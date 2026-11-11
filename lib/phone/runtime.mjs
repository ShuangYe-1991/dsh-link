/**
 * dsh-link · 手机端运行时（角色：这台设备当"接收方"）。
 *
 * 干的事：在本机回环上开一个反向代理，把**电脑上那台 dsh** 的整页页面喂给手机 DSH 的面板。
 *
 *   手机 DSH 页面 → 127.0.0.1:<本机端口>（本文件）
 *                     → http(s)://<电脑地址>/（电脑端的 dsh-link，带密码门）
 *                        → 电脑上的 dsh web
 *
 * 为什么非要这一层：
 *   1. 第三方 cookie：把电脑地址直接当 iframe 打开，Android WebView 会拦 cookie，登录进死循环；
 *      代理把登录态攥在服务端，浏览器侧零鉴权。
 *   2. 自动重登：电脑那边重启就换会话，密码存在本机，代理自己补一次登录。
 *   3. 地址自愈：快通隧道的地址会变，本文件会在连不上时去局域网地址问一次
 *      `/__link/tunnel`，拿到新的公网地址就自己换掉——用户不用手贴。
 *
 * 协议兼容两种电脑端：自家的 dsh-link（`/__link/version` 探测）和第三方 dsh-pocket。
 */
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { renderPhoneManage, renderPhoneScan } from './pages.mjs'

const HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
const DIR = path.join(HOME, 'dsh-link', 'phone')
const STATE_FILE = path.join(DIR, 'state.json')
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_PORT = 4319
const PORT_ROUTE = '/__pocket-remote/port'
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])
const SKIP_RESPONSE = new Set([
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
])
const REFRESH_COOLDOWN_MS = 30_000

const now = () => Date.now()

function sanitizeUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('地址不能为空')
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('地址格式不对，应该像 http://192.168.1.5:3199 或 https://xxx.trycloudflare.com')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https')
  const token = url.searchParams.get('token')
  url.searchParams.delete('token')
  url.hash = ''
  return { url: url.toString().replace(/\/$/, ''), token: token || null }
}

const isPrivateHost = (host) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === 'localhost' || host === '127.0.0.1'

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

export function createPhoneRuntime(ctx, { logger = console } = {}) {
  const rt = { state: { port: null, activeId: null, connections: [] }, server: null, jars: new Map(), lastRefresh: new Map(), lastError: null }

  const save = async () => {
    await mkdir(DIR, { recursive: true })
    const body = {
      port: rt.state.port,
      activeId: rt.state.activeId,
      connections: rt.state.connections.map(({ id, label, url, lanUrl }) => ({ id, label, url, lanUrl })),
    }
    await writeFile(STATE_FILE, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  }

  const load = async () => {
    try {
      const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
      rt.state.port = Number.isInteger(parsed.port) ? parsed.port : null
      rt.state.activeId = typeof parsed.activeId === 'string' ? parsed.activeId : null
      rt.state.connections = Array.isArray(parsed.connections) ? parsed.connections : []
    } catch {
      // 没有状态文件：保持空的，别把 rt.state 换成新对象（外面拿着引用）
      rt.state.port = null
      rt.state.activeId = null
      rt.state.connections = []
    }
  }

  // ---------- 密码：优先放 DSH 凭据服务，取不到退回本机状态文件 ----------
  const pinKey = (id) => `DSH_LINK_PHONE_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`

  const credentialsOf = () => {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      return viaGet ?? ctx.credentials ?? null
    } catch {
      return null
    }
  }

  async function writePin(id, pin) {
    const credentials = credentialsOf()
    if (!credentials) return false
    try {
      await credentials.set(pinKey(id), pin)
      const readback = await credentials.resolve(pinKey(id))
      return readback?.value === pin
    } catch {
      return false
    }
  }

  async function readPin(conn) {
    const credentials = credentialsOf()
    if (credentials) {
      try {
        const resolved = await credentials.resolve(pinKey(conn.id))
        if (resolved?.value) return resolved.value
      } catch {
        // 忽略，退回状态文件
      }
    }
    return typeof conn.pin === 'string' && conn.pin !== '' ? conn.pin : null
  }

  // ---------- 登录态（cookie jar 按连接分） ----------
  const jarHeader = (id) => {
    const jar = rt.jars.get(id)
    if (!jar) return undefined
    const parts = Object.keys(jar).map((key) => `${key}=${jar[key]}`)
    return parts.length > 0 ? parts.join('; ') : undefined
  }

  const absorbCookies = (id, setCookie) => {
    if (!setCookie) return
    const list = Array.isArray(setCookie) ? setCookie : [setCookie]
    const jar = rt.jars.get(id) ?? {}
    for (const line of list) {
      const pair = String(line).split(';')[0]
      const index = pair.indexOf('=')
      if (index <= 0) continue
      jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
    }
    rt.jars.set(id, jar)
  }

  /** 单次上游请求，收集完整响应（登录握手、探测都是小响应）。 */
  function fetchUpstream(target, options = {}) {
    const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
    const body = options.form ? new URLSearchParams(options.form).toString() : options.body
    const headers = {
      host: target.host,
      'accept-encoding': 'identity',
      'user-agent': 'dsh-link/0.3',
      ...(options.headers ?? {}),
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      headers['content-length'] = Buffer.byteLength(body)
    }
    return new Promise((resolve) => {
      const req = mod(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: options.path ?? '/',
          method: options.method ?? 'GET',
          headers,
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          )
        },
      )
      req.on('error', (error) => resolve({ status: 0, headers: {}, body: '', error }))
      req.setTimeout(15_000, () => req.destroy(new Error('连接超时')))
      req.end(body)
    })
  }

  const isLoginWall = (status, contentType, body) => {
    if (status === 401 || status === 403) return true
    if (!contentType || !contentType.includes('text/html') || typeof body !== 'string') return false
    return body.includes('current-password') || body.includes('访问密码') || body.includes('Access PIN')
  }

  async function detectProtocol(conn) {
    if (conn.protocol === 'link' || conn.protocol === 'pocket') return conn.protocol
    const probe = await fetchUpstream(new URL(conn.url), { path: '/__link/version' })
    conn.protocol = probe.status === 200 ? 'link' : 'pocket'
    return conn.protocol
  }

  async function login(conn) {
    const pin = await readPin(conn)
    if (!pin) return { ok: false, reason: 'missing-pin' }
    const target = new URL(conn.url)
    const protocol = await detectProtocol(conn)
    const path = protocol === 'link' ? '/__link/login' : '/pocket-login'
    const result = await fetchUpstream(target, { method: 'POST', path, form: { token: pin } })
    if (result.status === 429) return { ok: false, reason: 'locked' }
    absorbCookies(conn.id, result.headers['set-cookie'])
    if (!jarHeader(conn.id)) return { ok: false, reason: result.status === 0 ? 'unreachable' : 'rejected' }
    if (protocol === 'pocket') {
      const handshake = await fetchUpstream(target, {
        path: '/?dsh-pocket-auth=1',
        headers: { cookie: jarHeader(conn.id) },
      })
      absorbCookies(conn.id, handshake.headers['set-cookie'])
    }
    return { ok: true }
  }

  /**
   * 地址自愈：旧地址连不上时，去局域网那个地址问一次"你现在公网地址是多少"。
   * 只有在手机和电脑同一个 WiFi 时才可能成功——正是我们想要的时机（人回家了）。
   */
  async function refreshAddress(conn) {
    const last = rt.lastRefresh.get(conn.id) ?? 0
    if (now() - last < REFRESH_COOLDOWN_MS) return false
    rt.lastRefresh.set(conn.id, now())
    const bases = [...new Set([conn.lanUrl, conn.url].filter(Boolean))].filter((base) => base !== conn.url || conn.lanUrl === base)
    for (const base of bases) {
      const target = new URL(base)
      const jar = jarHeader(conn.id)
      let probe = await fetchUpstream(target, { path: '/__link/tunnel', headers: jar ? { cookie: jar } : {} })
      if (probe.status === 401) {
        const fresh = await loginAt(conn, base)
        if (!fresh) continue
        probe = await fetchUpstream(target, { path: '/__link/tunnel', headers: { cookie: jarHeader(conn.id) } })
      }
      if (probe.status !== 200) continue
      let payload
      try {
        payload = JSON.parse(probe.body)
      } catch {
        continue
      }
      if (!payload?.url || payload.url === conn.url) continue
      logger.info?.(`dsh-link: 地址自愈 ${conn.url} → ${payload.url}（从 ${base} 问到）`)
      conn.url = payload.url
      conn.protocol = payload.mode ? 'link' : conn.protocol
      rt.jars.delete(conn.id)
      await save()
      return true
    }
    return false
  }

  /** 用指定 base 登录一次（自愈过程中可能换了一个 base）。 */
  async function loginAt(conn, base) {
    const pin = await readPin(conn)
    if (!pin) return false
    const target = new URL(base)
    const protocol = await detectProtocol(conn)
    const path = protocol === 'link' ? '/__link/login' : '/pocket-login'
    const result = await fetchUpstream(target, { method: 'POST', path, form: { token: pin } })
    absorbCookies(conn.id, result.headers['set-cookie'])
    return Boolean(jarHeader(conn.id))
  }

  const activeConn = () => rt.state.connections.find((row) => row.id === rt.state.activeId)

  /**
   * 失败页。这里要回答用户心里那个问题："怎么昨天还能用，今天就不行了？"
   * 所以按错误类型分三种说法，并且都给出「去电脑上拿新地址」和「局域网自动找」两条路。
   */
  function renderFailure(res, conn, kind, detail) {
    const title =
      kind === 'dns' ? '这个地址可能已经失效了' : kind === 'http' ? '电脑那边回了个错误' : '连不上这台电脑'
    const reason =
      kind === 'dns'
        ? '域名现在解析不到——最常见的原因是电脑重启过，快速隧道的地址换了。'
        : kind === 'http'
          ? '电脑是通的，但那边返回了错误页面（隧道过期时 Cloudflare 也会这样回）。'
          : '地址还在，但连不上：电脑关机、dsh 没在跑，或者不在同一个网络。'
    const lan = conn.lanUrl && conn.lanUrl !== conn.url ? conn.lanUrl : null
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>电脑 DSH · ${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:22px 16px 40px;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:17px;margin:0 0 8px}p{font-size:13.5px;opacity:.78;margin:0 0 10px}
code{font-size:12px;word-break:break-all}.box{border:1px solid rgba(192,57,43,.4);border-radius:12px;padding:10px 12px;margin:12px 0;font-size:13px}
button,a.btn{display:inline-block;font:inherit;font-size:14px;padding:10px 14px;margin:0 8px 8px 0;border-radius:10px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;text-decoration:none}</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="box">${escapeHtml(reason)}</div>
<p>正在用的地址：<code>${escapeHtml(conn.url)}</code></p>
${lan ? `<p>局域网地址（同一个 WiFi 下可能还通）：<code>${escapeHtml(lan)}</code></p>` : ''}
<p>${escapeHtml(detail)}</p>
<p><button onclick="fetch('/__ctl/refresh',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>location.replace('/')).catch(()=>{})">自动找新地址</button>
<a class="btn" href="/__ctl/ui">改地址</a>
<button onclick="location.replace('/')">重试</button></p>
<p>拿新地址的办法：在电脑上打开 <code>http://127.0.0.1:3199/__link/ui</code>，页面上「公网地址」那一块就是新的；
或者让手机连上和电脑同一个 WiFi，再点上面的「自动找新地址」。</p>
</body></html>`)
  }

  function forward(conn, req, res, attempt = 0) {
    const target = new URL(conn.url)
    const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP.has(key.toLowerCase())) continue
      headers[key] = value
    }
    headers.host = target.host
    delete headers['accept-encoding']
    headers['accept-encoding'] = 'identity'
    const jar = jarHeader(conn.id)
    if (jar) headers.cookie = headers.cookie ? `${headers.cookie}; ${jar}` : jar

    const upstream = mod(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname.replace(/\/$/, '')}${req.url === '/' ? '/' : req.url}`,
        method: req.method,
        headers,
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502
        const contentType = String(upRes.headers['content-type'] ?? '')
        const wantsHtml = contentType.includes('text/html') && req.method !== 'HEAD'
        const maybeWall = status === 401 || status === 403 || wantsHtml

        if (!maybeWall) {
          res.statusCode = status
          for (const [key, value] of Object.entries(upRes.headers)) {
            if (SKIP_RESPONSE.has(key)) continue
            res.setHeader(key, value)
          }
          upRes.pipe(res)
          return
        }

        const chunks = []
        upRes.on('data', (chunk) => chunks.push(chunk))
        upRes.on('end', async () => {
          const raw = Buffer.concat(chunks)
          const text = raw.toString('utf8')
          const wall = isLoginWall(status, contentType, text)
          if (!wall && status < 500) {
            res.statusCode = status
            for (const [key, value] of Object.entries(upRes.headers)) {
              if (SKIP_RESPONSE.has(key) || key === 'content-length') continue
              res.setHeader(key, value)
            }
            res.end(raw)
            return
          }
          if (attempt === 0) {
            if (wall) await login(conn)
            else await refreshAddress(conn) // 5xx：多半是隧道地址失效，先试着自愈
            return forward(conn, req, res, 1)
          }
          if (wall) {
            rt.state.lastError = { at: now(), kind: 'auth', url: conn.url, message: '密码没通过' }
            return renderFailure(res, conn, 'auth', '密码没过：电脑那边可能重新生成过密码。点「改地址」把新密码填进去。')
          }
          rt.state.lastError = { at: now(), kind: 'http', url: conn.url, message: `HTTP ${status}` }
          return renderFailure(res, conn, 'http', `电脑返回 ${status}`)
        })
      },
    )

    upstream.on('error', async (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (attempt === 0 && (await refreshAddress(conn))) {
        return forward(conn, req, res, 1)
      }
      const code = String(error?.code ?? '')
      const kind = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns' : 'conn'
      rt.state.lastError = { at: now(), kind, url: conn.url, message: error?.message ?? String(error) }
      renderFailure(res, conn, kind, `${error?.message ?? String(error)}${code ? `（${code}）` : ''}`)
    })
    upstream.setTimeout(0)
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  function handleUpgrade(req, socket) {
    const conn = activeConn()
    if (!conn) {
      socket.destroy()
      return
    }
    const target = new URL(conn.url)
    const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = { ...req.headers, host: target.host }
    const jar = jarHeader(conn.id)
    if (jar) headers.cookie = headers.cookie ? `${headers.cookie}; ${jar}` : jar
    const upstream = mod({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname.replace(/\/$/, '')}${req.url}`,
      method: req.method,
      headers,
    })
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (let index = 0; index < upRes.rawHeaders.length; index += 2) {
        lines.push(`${upRes.rawHeaders[index]}: ${upRes.rawHeaders[index + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead?.length) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      socket.on('error', () => upSocket.destroy())
      upSocket.on('error', () => socket.destroy())
    })
    upstream.on('response', (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode ?? 400} Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`)
      socket.destroy()
      upRes.resume()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
    socket.on('error', () => upstream.destroy())
  }

  // ---------- 控制接口（只在本机回环可用，客户端半边要调） ----------
  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 4 * 1024 * 1024) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

  async function handleControl(req, res, pathname) {
    if (pathname === '/__ctl/state') {
      return sendJson(res, 200, {
        port: rt.state.port,
        activeId: rt.state.activeId,
        connections: rt.state.connections.map(({ id, label, url, lanUrl }) => ({ id, label, url, lanUrl })),
        lastError: rt.state.lastError,
      })
    }
    if (pathname === '/__ctl/ui') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(renderPhoneManage(rt.state, rt.state.port))
    }
    if (pathname === '/__ctl/scan') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(renderPhoneScan())
    }
    if (pathname === '/__ctl/jsqr.js') {
      try {
        const source = await readFile(path.join(PKG_ROOT, 'vendor', 'jsqr.js'))
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' })
        return res.end(source)
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    if (!pathname.startsWith('/__ctl/')) return false
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' })

    let payload = {}
    try {
      payload = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    }

    try {
      if (pathname === '/__ctl/save') {
        const { url, token } = sanitizeUrl(payload.url)
        const pin = String(payload.pin ?? '').trim() || token || ''
        const existing = rt.state.connections.find((conn) => conn.url === url || (payload.id && conn.id === payload.id))
        const id = existing?.id ?? randomUUID()
        const host = new URL(url).hostname
        const label = String(payload.label ?? '').trim() || existing?.label || host
        const conn = { id, label, url, lanUrl: existing?.lanUrl ?? (isPrivateHost(host) ? url : null) }
        if (pin) {
          const stored = await writePin(id, pin)
          if (!stored) conn.pin = pin
        } else if (existing?.pin) {
          conn.pin = existing.pin
        }
        if (existing) Object.assign(existing, conn)
        else rt.state.connections.push(conn)
        rt.state.activeId = id
        rt.jars.delete(id)
        await save()
        const result = await login(conn)
        return sendJson(res, 200, { ok: true, id, verified: result.ok, reason: result.reason ?? null })
      }
      if (pathname === '/__ctl/select') {
        const id = String(payload.id ?? '')
        if (!rt.state.connections.some((conn) => conn.id === id)) throw new Error('没有这台电脑')
        rt.state.activeId = id
        await save()
        return sendJson(res, 200, { ok: true })
      }
      if (pathname === '/__ctl/rename') {
        const conn = rt.state.connections.find((row) => row.id === payload.id)
        if (!conn) throw new Error('没有这台电脑')
        conn.label = String(payload.label ?? '').trim() || conn.label
        await save()
        return sendJson(res, 200, { ok: true })
      }
      if (pathname === '/__ctl/delete') {
        rt.state.connections = rt.state.connections.filter((row) => row.id !== payload.id)
        rt.jars.delete(String(payload.id ?? ''))
        if (rt.state.activeId === payload.id) rt.state.activeId = rt.state.connections[0]?.id ?? null
        await save()
        return sendJson(res, 200, { ok: true })
      }
      if (pathname === '/__ctl/update') {
        const conn = rt.state.connections.find((row) => row.id === payload.id)
        if (!conn) throw new Error('没有这台电脑')
        const label = String(payload.label ?? '').trim()
        if (label) conn.label = label
        const rawUrl = String(payload.url ?? '').trim()
        if (rawUrl) {
          const parsed = sanitizeUrl(rawUrl)
          conn.url = parsed.url
          const host = new URL(parsed.url).hostname
          if (isPrivateHost(host)) conn.lanUrl = parsed.url
        }
        const pin = String(payload.pin ?? '').trim()
        if (pin) {
          const stored = await writePin(conn.id, pin)
          if (stored) delete conn.pin
          else conn.pin = pin
        }
        rt.jars.delete(conn.id)
        rt.state.activeId = conn.id
        await save()
        const result = await login(conn)
        return sendJson(res, 200, { ok: true, id: conn.id, verified: result.ok, reason: result.reason ?? null })
      }
      if (pathname === '/__ctl/pin') {
        const conn = rt.state.connections.find((row) => row.id === payload.id)
        if (!conn) throw new Error('没有这台电脑')
        const pin = String(payload.pin ?? '').trim()
        if (!pin) throw new Error('密码不能为空')
        const stored = await writePin(conn.id, pin)
        if (!stored) conn.pin = pin
        rt.jars.delete(conn.id)
        await save()
        const result = await login(conn)
        return sendJson(res, result.ok ? 200 : 200, result.ok ? { ok: true } : { ok: false, error: '密码没通过' })
      }
      if (pathname === '/__ctl/refresh') {
        const conn = rt.state.connections.find((row) => row.id === payload.id) ?? activeConn()
        if (!conn) throw new Error('还没有连过电脑')
        rt.lastRefresh.delete(conn.id)
        const changed = await refreshAddress(conn)
        return sendJson(res, 200, { ok: true, changed, url: conn.url })
      }
      return sendJson(res, 404, { ok: false, error: '未知操作' })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
    }
  }

  async function handle(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname.startsWith('/__ctl/')) {
      // 客户端面板在另一个端口（dsh 页面）里发请求，属于跨源：不补这几个头就是 "failed to fetch"。
      res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      const handled = await handleControl(req, res, pathname)
      if (handled !== false) return
    }
    const conn = activeConn()
    if (!conn) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(renderPhoneManage(rt.state, rt.state.port))
    }
    if (!jarHeader(conn.id)) await login(conn)
    forward(conn, req, res)
  }

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        Promise.resolve(handle(req, res)).catch((error) => {
          logger.warn?.(`dsh-link(phone): 请求失败 ${error?.message ?? error}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('dsh-link 手机端内部错误')
          } else {
            res.destroy()
          }
        })
      })
      server.on('upgrade', handleUpgrade)
      server.requestTimeout = 0
      server.headersTimeout = 65_000
      server.keepAliveTimeout = 65_000
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        server.on('error', (error) => logger.warn?.(`dsh-link(phone): 监听异常 ${error?.message ?? error}`))
        resolve(server)
      })
    })

  async function start() {
    if (rt.server) return rt
    await load()
    const candidates = []
    if (rt.state.port) candidates.push(rt.state.port)
    for (let offset = 0; offset < 12; offset += 1) candidates.push(DEFAULT_PORT + offset)
    let lastError = null
    for (const port of [...new Set(candidates)]) {
      try {
        rt.server = await listen(port)
        rt.state.port = port
        await save()
        logger.info?.(`dsh-link(phone): 本机反向代理已监听 127.0.0.1:${port}`)
        return rt
      } catch (error) {
        lastError = error
      }
    }
    rt.lastError = lastError?.message ?? '端口全被占用'
    logger.error?.(`dsh-link(phone): 启动失败 ${rt.lastError}`)
    return rt
  }

  async function stop() {
    const server = rt.server
    rt.server = null
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve())
        setTimeout(() => {
          try {
            server.closeAllConnections?.()
          } catch {
            // 忽略
          }
          resolve()
        }, 400)
      })
    }
  }

  const status = () => ({
    listening: Boolean(rt.server),
    port: rt.state.port,
    activeId: rt.state.activeId,
    connections: rt.state.connections.map(({ id, label, url, lanUrl }) => ({ id, label, url, lanUrl })),
    lastError: rt.state.lastError,
  })

  return {
    start,
    stop,
    status,
    get state() {
      return rt.state
    },
    PORT_ROUTE,
  }
}
