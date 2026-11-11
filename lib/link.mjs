/**
 * dsh-link · 电脑端运行时。
 *
 * 干一件事：在本机开一个「带密码门的反向代理」，把 dsh web 原样给手机用。
 *
 *   手机 → http://<电脑IP>:<端口>/          ← 本文件（HTTP + WS 全透传 + 密码门）
 *              → http://127.0.0.1:<dsh端口>/  ← 电脑上的 dsh web
 *
 * 三个必须记住的坑（交接文档里写过，这里再落一遍）：
 *  1. dsh web 自己有鉴权：根路径要带一次 ?token=<启动令牌> 换 cookie，否则 /api 与
 *     WebSocket 全 401。令牌只能由插件向 dsh 要（ctx.connection.authenticatedUrl）。
 *  2. cookie 与请求的 Host 绑定：兑换 cookie 用的 authority 必须和转发时用的 Host
 *     一模一样，否则 401 一直转。
 *  3. 只改写 Host 不够：dsh 宿主对设置/凭据这类特权方法还会看 Origin / Referer /
 *     Sec-Fetch-Site，判为跨站就 403。所以这四个头要一起改写成回环权威。
 */
import { createServer, request as httpRequest } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_PORT, STATE_DIR, loadState, saveState, newPin, normalizePin,
  portCandidates, lanAddress, machineName,
} from './state.mjs'
import { renderLoginPage } from './pages.mjs'
import { FIT_SCRIPT } from './fit.mjs'
import { createTunnelManager } from './tunnel.mjs'
import { resolveCloudflared, downloadCloudflared, diagnose, OWN_BINARY } from './cloudflared.mjs'

const COOKIE_NAME = 'dsh_link'
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
// 这些响应头不透传：前几个是 dsh / 隧道错误页带的「不许被嵌入」，手机端插件要把
// 页面塞进 iframe；set-cookie 不透传是因为浏览器只该拿到 dsh_link 这一个 cookie。
const DROP_RESPONSE = new Set([
  'set-cookie', 'x-frame-options',
  'content-security-policy', 'content-security-policy-report-only',
])
const LOGIN_FAIL_LIMIT = 5
const LOGIN_LOCK_MS = 60_000

const isLoopbackAddress = (address = '') =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

const cookieValueOf = (header = '') => {
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === COOKIE_NAME) return part.slice(index + 1).trim()
  }
  return ''
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

function readBody(req, limit = 4096) {  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

export function createLinkRuntime(ctx, options = {}) {
  const logger = options.logger ?? ctx.logger?.('dsh-link') ?? console
  const version = options.version ?? '0.1.0'
  // 进程级随机：重启后旧 cookie 全部失效，手机端会用存下的密码自动重登。
  const nonce = randomBytes(16).toString('hex')

  /** 把竖屏适配脚本塞进 </body> 前；已经注过（例如上游还有一层代理）就不重复注。 */
  const injectFit = (html) => {
    if (html.includes('__dshLinkFit')) return html
    const tag = `<script>${FIT_SCRIPT}</script>`
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : html + tag
  }

  // 排障日志：只记"门口"发生的事（换 cookie、上游 401/403、重试），不记内容。
  // 手机上连不上时看这个文件就知道卡在哪一步：$DSH_HOME/dsh-link/proxy.log
  const LOG_FILE = path.join(STATE_DIR, 'proxy.log')
  let logQueue = Promise.resolve()
  const logLine = (event) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...event })
    logQueue = logQueue.then(async () => {
      try {
        await mkdir(STATE_DIR, { recursive: true })
        await appendFile(LOG_FILE, `${line}\n`)
      } catch {
        // 日志失败不影响主流程
      }
    })
  }

  // dsh web 的实际监听地址。晚解析是故意的：插件 apply 时监听器未必已经起来，
  // getOrigin() 在那之前会抛错，所以第一次真正用到时才取（端口进程内不变）。
  let target = null
  const originOf = () => {
    if (target) return target
    const url = new URL(ctx.webServer.getOrigin())
    target = {
      hostname: url.hostname,
      port: Number(url.port) || 80,
      authority: url.host,
      origin: url.origin,
      protocol: url.protocol,
    }
    return target
  }

  const rt = {
    state: { enabled: true, port: null, pin: newPin(), bind: '0.0.0.0', fit: true },
    server: null,
    lastError: null,
    session: null,
    attempts: new Map(),
  }

  // 状态页与接口的实现由 index.js 注入（它才知道怎么画页面、怎么改状态）。
  let management = null
  const setManagement = (handlers) => {
    management = handlers
  }

  const tunnel = createTunnelManager({ logger })
  // cloudflared 的位置探一次就缓存，别每次请求都去 spawn --version。
  let cloudflaredInfo = null
  // 下载状态（给状态页画进度和红字用）；diagnostic 是"去哪找过/能不能自己下"的体检结果。
  let installing = null
  let installPromise = null
  let diagnostic = null

  const ensureCloudflared = async () => {
    if (cloudflaredInfo) return cloudflaredInfo
    cloudflaredInfo = await resolveCloudflared()
    return cloudflaredInfo
  }

  const refreshDiagnostic = async () => {
    try {
      diagnostic = await diagnose()
    } catch (error) {
      logger.warn?.(`dsh-link: 体检 cloudflared 失败 ${error?.message ?? error}`)
    }
    return diagnostic
  }

  /** 自动下载 cloudflared（同一时刻只跑一次；页面靠 status 轮询看进度）。 */
  const installCloudflaredOnce = () => {
    if (installPromise) return installPromise
    installing = { state: 'downloading', mirror: null, tried: [], error: null, startedAt: Date.now() }
    installPromise = downloadCloudflared({
      onAttempt: (source) => {
        installing = { ...installing, mirror: source.label }
        logger.info?.(`dsh-link: 正在从 ${source.label} 下载 cloudflared`)
      },
    })
      .then((info) => {
        cloudflaredInfo = info
        installing = { state: 'done', mirror: info.mirror, tried: info.attempted, error: null, finishedAt: Date.now() }
        logger.info?.(`dsh-link: cloudflared ${info.version} 已装到 ${OWN_BINARY}（来自 ${info.mirror}）`)
        void refreshDiagnostic()
        return info
      })
      .catch((error) => {
        installing = {
          state: 'error',
          mirror: null,
          tried: error?.attempted ?? [],
          error: error?.message ?? String(error),
          finishedAt: Date.now(),
        }
        logger.error?.(`dsh-link: cloudflared 下载失败 ${installing.error}`)
        void refreshDiagnostic()
        throw error
      })
      .finally(() => {
        installPromise = null
      })
    return installPromise
  }

  const tunnelConfig = () => ({
    mode: rt.state.tunnelMode,
    token: rt.state.tunnelToken,
    hostname: rt.state.tunnelHostname,
  })

  /** 起隧道。缺 cloudflared 就先自己下，下不到再抛给调用方去展示。 */
  async function startTunnel() {
    if (rt.state.tunnelMode === 'off') return null
    if (!rt.server?.listening) throw new Error('手机访问还没开，先开它')
    let info = await ensureCloudflared()
    if (!info) {
      logger.info?.('dsh-link: 没找到 cloudflared，先自动下载')
      info = await installCloudflaredOnce()
    }
    if (!info) {
      throw new Error(`没找到 cloudflared，自动下载也失败了。手动下载放到 ${OWN_BINARY}`)
    }
    return tunnel.start(info.binary, tunnelConfig(), rt.state.port)
  }


  const authToken = (pin) => createHmac('sha256', nonce).update(pin).digest('hex')

  // 公网与局域网可以分开用两个密码：Host 是私网/回环就用局域网密码，
  // 其它（隧道域名）一律用公网密码——公网密码没设时退回局域网那个。
  const isLanAuthority = (host = '') => {
    const name = String(host).split(':')[0].toLowerCase().replace(/^\[|\]$/g, '')
    if (name === '' || name === 'localhost' || name === '::1' || name === '127.0.0.1') return true
    return /^10\./.test(name) || /^192\.168\./.test(name) || /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  }
  const pinPublic = () => rt.state.pinPublic || rt.state.pin
  const pinFor = (req) => (isLanAuthority(req.headers.host) ? rt.state.pin : pinPublic())

  const isAuthed = (req) => {
    const value = cookieValueOf(req.headers.cookie)
    return value !== '' && safeEqual(value, authToken(pinFor(req)))
  }

  const lockedSeconds = (ip) => {
    const row = rt.attempts.get(ip)
    if (!row) return 0
    if (row.count >= LOGIN_FAIL_LIMIT) {
      const left = LOGIN_LOCK_MS - (Date.now() - row.at)
      if (left > 0) return Math.ceil(left / 1000)
      rt.attempts.delete(ip)
    }
    return 0
  }

  const recordFailure = (ip) => {
    const row = rt.attempts.get(ip) ?? { count: 0, at: 0 }
    rt.attempts.set(ip, { count: row.count + 1, at: Date.now() })
  }

  // ---------- 向 dsh 自己换会话 cookie ----------

  function launchToken() {
    try {
      const fn = ctx.connection?.authenticatedUrl
      if (typeof fn !== 'function') return ''
      const url = new URL(fn.call(ctx.connection, originOf().origin))
      return url.searchParams.get('token') ?? ''
    } catch {
      return ''
    }
  }

  function mintSession() {
    const token = launchToken()
    if (token === '') return Promise.resolve(null)
    return new Promise((resolve) => {
      const req = httpRequest(
        {
          hostname: originOf().hostname,
          port: originOf().port,
          path: `/?${new URLSearchParams({ token }).toString()}`,
          method: 'GET',
          headers: {
            host: originOf().authority,
            'user-agent': 'dsh-link',
            'accept-encoding': 'identity',
          },
        },
        (res) => {
          res.resume()
          const raw = res.headers['set-cookie']
          const list = Array.isArray(raw) ? raw : raw ? [raw] : []
          const cookie = list
            .map((line) => String(line).split(';')[0].trim())
            .filter(Boolean)
            .join('; ')
          logLine({
            kind: 'mint',
            status: res.statusCode,
            names: cookie === '' ? [] : cookie.split('; ').map((pair) => pair.split('=')[0]),
          })
          resolve(cookie === '' ? null : cookie)
        },
      )
      req.on('error', (error) => {
        logLine({ kind: 'mint-error', message: error?.message ?? String(error) })
        resolve(null)
      })
      req.setTimeout(8000, () => req.destroy(new Error('兑换 dsh 会话超时')))
      req.end()
    })
  }

  async function ensureSession() {
    if (rt.session) return rt.session
    rt.session = await mintSession()
    if (!rt.session) logger.warn?.('dsh-link: 没换到 dsh 会话 cookie（无法拿到启动令牌？）')
    return rt.session
  }

  // ---------- 请求头改写 ----------

  function toLoopback(req, { upgrade = false } = {}) {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'sec-fetch-site') continue
      // 不要上游压缩：身体是原样透传的，压缩头一旦对不上浏览器就解出乱码。
      if (lower === 'accept-encoding') continue
      headers[lower] = value
    }
    headers.host = originOf().authority
    // Origin / Referer 只在客户端本来就有的时候才改写：浏览器对同源的 GET/HEAD
    // 不发 Origin，凭空补一个没有好处，只是多一处和宿主判据对不上的机会。
    const incomingOrigin = req.headers.origin
    if (incomingOrigin) headers.origin = originOf().origin
    headers['sec-fetch-site'] = 'same-origin'
    const referer = req.headers.referer
    if (referer) {
      try {
        const ref = new URL(referer)
        ref.protocol = originOf().protocol
        ref.host = originOf().authority
        headers.referer = ref.toString()
      } catch {
        headers.referer = `${originOf().origin}/`
      }
    }
    headers['accept-encoding'] = 'identity'
    if (rt.session) headers.cookie = rt.session
    if (upgrade) {
      headers.connection = 'Upgrade'
      headers.upgrade = req.headers.upgrade ?? 'websocket'
    }
    return headers
  }

  // ---------- 数据平面：HTTP 透传 ----------

  function proxy(req, res, attempt = 0) {
    const upstream = httpRequest(
      {
        hostname: originOf().hostname,
        port: originOf().port,
        path: req.url,
        method: req.method,
        headers: toLoopback(req),
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502
        // 只在 401 时重兑：403 是"这条路不给你"，换 cookie 也没用
        // （例如 dsh-video-preview 的预览路由在没带 p 参数时就回 403）。
        const retriable = status === 401 && attempt === 0 && (req.method === 'GET' || req.method === 'HEAD')
        if (status === 401 || status === 403) {
          logLine({ kind: 'upstream-deny', status, method: req.method, path: req.url, hadSession: Boolean(rt.session), retry: retriable })
        }
        if (retriable) {
          upRes.resume()
          rt.session = null
          logger.warn?.(`dsh-link: 上游 ${status}，重兑一次会话 cookie 后重试 ${req.url}`)
          ensureSession().then(() => proxy(req, res, 1))
          return
        }
        const out = {}
        for (const [key, value] of Object.entries(upRes.headers)) {
          if (DROP_RESPONSE.has(key)) continue
          out[key] = value
        }

        const contentType = String(upRes.headers['content-type'] ?? '')
        const wantsFit = rt.state.fit && contentType.includes('text/html') && req.method !== 'HEAD'
        if (!wantsFit) {
          res.writeHead(status, out)
          upRes.pipe(res)
          return
        }

        // HTML 要改一改（塞竖屏适配脚本），只能先攒起来再发。
        // 页面就几十 KB，手机那边也就多等这一下；视频/流式响应走的是上面那条直通。
        const chunks = []
        upRes.on('data', (chunk) => chunks.push(chunk))
        upRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const body = injectFit(raw)
          const headers = { ...out }
          delete headers['content-length']
          delete headers['transfer-encoding']
          res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) })
          res.end(body)
        })
        upRes.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end()
        })
      },
    )
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendHtml(res, 502, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>连不上 dsh web</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;padding:28px 20px}</style></head><body>
<h3>连不上电脑上的 dsh web</h3><p>${String(error?.message ?? error)}</p><p>通常是 dsh 正在重启，等几秒刷新。</p></body></html>`)
    })
    upstream.setTimeout(0)
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  }

  // ---------- 数据平面：WebSocket 透传 ----------

  function proxyUpgrade(req, socket) {
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const upstream = httpRequest({
      hostname: originOf().hostname,
      port: originOf().port,
      path: req.url,
      method: 'GET',
      headers: toLoopback(req, { upgrade: true }),
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
      socket.on('close', () => upSocket.destroy())
      upSocket.on('close', () => socket.destroy())
    })
    upstream.on('response', (upRes) => {
      // 上游拒绝升级（401/404）：把状态码回给浏览器再断开，别让客户端干挂着。
      socket.write(
        `HTTP/1.1 ${upRes.statusCode ?? 400} ${upRes.statusMessage ?? 'Bad Request'}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
      )
      socket.destroy()
      upRes.resume()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
    socket.on('error', () => upstream.destroy())
  }

  // ---------- 门口：版本、登录、拦截 ----------

  async function handleLogin(req, res) {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const locked = lockedSeconds(ip)
    if (locked > 0) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(locked) })
      res.end(renderLoginPage(`试错次数太多，等 ${locked} 秒再试。`))
      return
    }
    const body = await readBody(req)
    // 手机端按 SPEC 发表单；顺手也认 JSON，方便别的地方试。
    let token = ''
    try {
      token = new URLSearchParams(body).get('token') ?? ''
    } catch {
      token = ''
    }
    if (token === '' && body.trim().startsWith('{')) {
      try {
        token = String(JSON.parse(body).token ?? '')
      } catch {
        token = ''
      }
    }
    const expected = pinFor(req)
    if (token !== '' && safeEqual(token, expected)) {
      rt.attempts.delete(ip)
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE_NAME}=${authToken(expected)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (token !== '') recordFailure(ip)
    sendHtml(res, 200, renderLoginPage(token === '' ? '' : '密码不对，再试一次。'))
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://link.local')
    const path = url.pathname

    // 本机开的窗口看状态页：走这个固定端口更方便——dsh 的端口每次启动都会变。
    // 只认回环来源：页面里明文写着访问密码。
    if (management && isLoopbackAddress(req.socket?.remoteAddress)) {
      if (path === '/__link/ui' || path === '/__link') {
        management.page(res)
        return
      }
      if (path === '/__link/api') {
        await management.api(req, res)
        return
      }
    }

    if (path === '/__link/version') {
      sendJson(res, 200, {
        name: 'dsh-link',
        version: 1,
        host: machineName(),
        features: ['auth', 'ws'],
        port: rt.state.port,
        plugin: version,
      })
      return
    }

    // 局域网访问开关：只影响私网来源，公网那一路不受影响。
    if (rt.state.lanEnabled === false && isLanAuthority(req.headers.host)) {
      sendHtml(res, 403, '<!doctype html><meta charset="utf-8"><body style="font:15px/1.6 -apple-system,PingFang SC,sans-serif;padding:24px">' +
        '<h3>局域网访问已关闭</h3><p>这台电脑目前只对公网地址开放。到电脑上打开 127.0.0.1:3199/__link/ui 可以重新打开局域网访问。</p></body>')
      return
    }

    if (path === '/__link/login' && req.method === 'POST') {
      await handleLogin(req, res)
      return
    }

    if (path === '/__link/logout') {
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    // 手机端（在同一局域网时）来问"现在的公网地址是什么"，问到就自己存下来。
    // 要过密码门：手机那半边本来就存着密码。
    if (path === '/__link/tunnel' && req.method === 'GET') {
      if (!isAuthed(req)) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: '需要访问密码' }))
        return
      }
      const state = tunnel.status()
      sendJson(res, 200, {
        ok: true,
        mode: rt.state.tunnelMode,
        state: state.state,
        url: state.url,
        host: machineName(),
        updatedAt: state.startedAt,
      })
      return
    }

    if (!isAuthed(req)) {
      // 浏览器拉 PWA manifest 时不带 cookie（credentials 默认 omit），会一路撞到
      // 我们的 401 上、在控制台留一条红字。manifest 里没有敏感信息，直接给个最小版。
      if (path === '/manifest.webmanifest') {
        sendJson(res, 200, {
          name: 'DSH · dsh-link',
          short_name: 'DSH',
          start_url: '/',
          display: 'standalone',
        })
        return
      }
      const accept = String(req.headers.accept ?? '')
      if ((req.method === 'GET' || req.method === 'HEAD') && (accept === '' || accept.includes('text/html'))) {
        sendHtml(res, 200, renderLoginPage(''))
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('需要访问密码')
      return
    }

    proxy(req, res)
  }

  // ---------- 起停 ----------

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        Promise.resolve(handle(req, res)).catch((error) => {
          logger.warn?.(`dsh-link: 请求处理失败 ${error?.message ?? error}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('dsh-link 内部错误')
          } else {
            res.destroy()
          }
        })
      })
      server.on('upgrade', proxyUpgrade)
      // 手机端会挂长连接（WS）、也会长时间不关页面，别用默认超时把它们掐掉。
      server.requestTimeout = 0
      server.headersTimeout = 65_000
      server.keepAliveTimeout = 65_000
      server.on('clientError', (error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        else socket.destroy()
      })
      server.once('error', (error) => {
        try {
          server.close()
        } catch {
          // 忽略
        }
        reject(error)
      })
      server.listen(port, rt.state.bind, () => {
        server.removeAllListeners('error')
        server.on('error', (error) => logger.warn?.(`dsh-link: 监听异常 ${error?.message ?? error}`))
        resolve(server)
      })
    })

  function closeServer(server) {
    return new Promise((resolve) => {
      if (!server) {
        resolve()
        return
      }
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      server.close(() => done())
      // WS / keep-alive 长连接会让 close 一直等，主动断一次。
      setTimeout(() => {
        try {
          server.closeAllConnections?.()
        } catch {
          // 忽略
        }
      }, 250)
      setTimeout(done, 2000)
    })
  }

  async function start() {
    if (rt.server) return rt
    const candidates = portCandidates(rt.state.port)
    let lastError = null
    for (const port of candidates) {
      try {
        rt.server = await listen(port)
        rt.state.port = port
        rt.state.enabled = true
        rt.lastError = null
        await saveState(rt.state)
        logger.info?.(`dsh-link: 手机访问已开启 http://${rt.state.bind}:${port} → ${originOf().origin}`)
        return rt
      } catch (error) {
        lastError = error
      }
    }
    rt.lastError = lastError?.message ?? '端口都被占用'
    logger.error?.(`dsh-link: 启动失败 ${rt.lastError}`)
    throw lastError ?? new Error(rt.lastError)
  }

  async function stop() {
    const server = rt.server
    rt.server = null
    await closeServer(server)
    logger.info?.('dsh-link: 手机访问已关闭')
    return rt
  }

  // ---------- 给状态页用的读写口 ----------

  function lanUrl() {
    if (rt.state.bind === '127.0.0.1') return `http://127.0.0.1:${rt.state.port}`
    return `http://${lanAddress()}:${rt.state.port}`
  }

  function status() {
    const tunnelState = tunnel.status()
    return {
      enabled: rt.state.enabled,
      listening: Boolean(rt.server),
      port: rt.state.port,
      bind: rt.state.bind,
      lanUrl: rt.state.port ? lanUrl() : null,
      pin: rt.state.pin,
      pinPublic: pinPublic(),
      pinPublicCustom: rt.state.pinPublic !== '',
      machine: machineName(),
      version,
      defaultPort: DEFAULT_PORT,
      fit: rt.state.fit,
      lanEnabled: rt.state.lanEnabled !== false,
      lastError: rt.lastError,
      tunnel: {
        ...tunnelState,
        mode: rt.state.tunnelMode,
        hostname: rt.state.tunnelHostname,
        tokenSet: rt.state.tunnelToken !== '',
        binary: cloudflaredInfo ? { version: cloudflaredInfo.version, source: cloudflaredInfo.source, mirror: cloudflaredInfo.mirror ?? null } : null,
        binaryPath: OWN_BINARY,
        install: installing,
        diagnostic,
      },
    }
  }

  async function manage(payload) {
    const op = String(payload?.op ?? '')
    if (op === 'start') {
      rt.state.enabled = true
      await saveState(rt.state)
      await start()
      if (rt.state.tunnelMode !== 'off') startTunnel().catch((error) => logger.warn?.(`dsh-link: 隧道没起来 ${error?.message ?? error}`))
    } else if (op === 'stop') {
      rt.state.enabled = false
      await saveState(rt.state)
      await tunnel.stop()
      await stop()
    } else if (op === 'rotate-pin') {
      rt.state.pin = newPin()
      await saveState(rt.state)
    } else if (op === 'fit') {
      rt.state.fit = typeof payload.fit === 'boolean' ? payload.fit : !rt.state.fit
      await saveState(rt.state)
    } else if (op === 'port') {
      const port = Number(payload.port)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口要在 1024–65535 之间')
      const wasListening = Boolean(rt.server)
      const hadTunnel = rt.state.tunnelMode !== 'off'
      if (wasListening) await stop()
      await tunnel.stop()
      rt.state.port = port
      await saveState(rt.state)
      if (wasListening) await start()
      if (hadTunnel && rt.server) startTunnel().catch((error) => logger.warn?.(`dsh-link: 隧道没起来 ${error?.message ?? error}`))
    } else if (op === 'pin') {
      const pin = normalizePin(payload.pin)
      if (!pin) throw new Error('密码要 8–64 位')
      rt.state.pin = pin
      await saveState(rt.state)
    } else if (op === 'lan-enabled') {
      rt.state.lanEnabled = rt.state.lanEnabled === false
      await saveState(rt.state)
    } else if (op === 'rotate-pin-lan') {
      rt.state.pin = newPin()
      await saveState(rt.state)
    } else if (op === 'rotate-pin-public') {
      rt.state.pinPublic = newPin()
      await saveState(rt.state)
    } else if (op === 'pin-public') {
      // 空字符串 = 取消自定义，公网跟局域网用同一个密码
      const raw = String(payload.pin ?? '').trim()
      if (raw === '') {
        rt.state.pinPublic = ''
        await saveState(rt.state)
      } else {
        const pin = normalizePin(raw)
        if (!pin) throw new Error('公网密码要 8–64 位')
        rt.state.pinPublic = pin
        await saveState(rt.state)
      }
    } else if (op === 'tunnel-start') {
      const mode = payload.mode === 'named' || payload.mode === 'quick' ? payload.mode : rt.state.tunnelMode
      if (mode !== 'quick' && mode !== 'named') throw new Error('先选一种模式：quick 或 named')
      const token = typeof payload.token === 'string' ? payload.token.trim() : rt.state.tunnelToken
      const hostname = typeof payload.hostname === 'string' ? payload.hostname.trim() : rt.state.tunnelHostname
      // 先校验再改状态：不然校验失败会留下一个"半改好"的配置。
      if (mode === 'named' && (token === '' || hostname === '')) {
        throw new Error('固定域名模式要填 tunnel token 和域名')
      }
      rt.state.tunnelMode = mode
      rt.state.tunnelToken = token
      rt.state.tunnelHostname = hostname
      await saveState(rt.state)
      if (!rt.server) await start()
      // 起隧道要等地址，最长 45 秒——不憋在请求里，页面自己轮询状态。
      startTunnel().catch((error) => logger.warn?.(`dsh-link: 隧道没起来 ${error?.message ?? error}`))
    } else if (op === 'tunnel-stop') {
      rt.state.tunnelMode = 'off'
      await saveState(rt.state)
      await tunnel.stop()
    } else if (op === 'tunnel-config') {
      if (typeof payload.token === 'string') rt.state.tunnelToken = payload.token.trim()
      if (typeof payload.hostname === 'string') rt.state.tunnelHostname = payload.hostname.trim()
      await saveState(rt.state)
    } else if (op === 'tunnel-install') {
      // 手动点「下载 cloudflared」：后台跑，页面轮询看进度。
      installCloudflaredOnce().catch(() => {})
    } else if (op === 'tunnel-recheck') {
      // 用户可能自己把文件放进去了：清缓存重新找一遍
      cloudflaredInfo = null
      installing = null
      await ensureCloudflared()
      await refreshDiagnostic()
    } else {
      throw new Error(`未知操作：${op}`)
    }
    return status()
  }

  async function boot() {
    rt.state = await loadState()
    await saveState(rt.state)
    if (rt.state.enabled) {
      try {
        await start()
      } catch {
        // 端口全占 / 别的什么原因，都只影响手机访问，不该让 dsh 起不来。
      }
    }
    // 先把 dsh 的会话 cookie 换好：不然手机一打开的第一个请求会白挨一次 401。
    if (rt.server) ensureSession().catch(() => {})

    // 顺带查一下 cloudflared 在不在（状态页要如实显示缺什么、去哪找过、能不能自己下）。
    ensureCloudflared()
      .then(() => refreshDiagnostic())
      .catch(() => {})

    // 隧道：优先认领上次还活着的那条（这样"只重启 dsh"地址不变）。
    if (rt.state.tunnelMode !== 'off' && rt.server) {
      const config = tunnelConfig()
      tunnel
        .adopt(config, rt.state.port)
        .then(async (adopted) => {
          if (!adopted) {
            // 没有可认领的（电脑重启过 / 端口变过 / 进程被杀了）→ 收掉残留再起一条新的
            await tunnel.discardSaved()
            return startTunnel()
          }
          if (adopted.reachable) return null
          // 认领回来但域名还没生效：再等两分钟；确实连不上就重起一条
          const ok = await tunnel.watch(adopted.url, 8, 15_000)
          if (ok) return null
          logger.warn?.('dsh-link: 认领的隧道一直连不上，重起一条')
          return startTunnel()
        })
        .catch((error) => logger.warn?.(`dsh-link: 隧道没起来 ${error?.message ?? error}`))
    }
    return rt
  }

  return { rt, boot, start, stop, status, manage, lanUrl, setManagement, tunnel }
}
