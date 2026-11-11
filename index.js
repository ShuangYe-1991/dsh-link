/**
 * dsh-link · 入口（一个插件，两个角色）
 *
 * 同一个包装在两边，用状态页里的开关选这台设备当什么：
 *   - 电脑（默认）：在局域网/公网开一个带密码门反向代理，把本机 dsh 给手机用；
 *     还能自己拉 cloudflared 起隧道（快速隧道地址会变，命名隧道可固定域名）。
 *   - 手机：在 127.0.0.1 开一个反向代理，把电脑上那台 dsh 的整页喂给 DSH 面板；
 *     会话登录、地址自愈都在这一侧，浏览器/壳子不用管鉴权。
 *
 * 状态页：
 *   固定地址  http://127.0.0.1:<电脑端端口>/__link/ui   （只有"电脑"角色时这个端口才在听）
 *   dsh 端口  http://127.0.0.1:<dsh端口>/__link/ui      （两种角色都在）
 *
 * 注：状态页只允许回环来源访问——里面明文显示访问密码。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createLinkRuntime } from './lib/link.mjs'
import { createPhoneRuntime } from './lib/phone/runtime.mjs'
import { renderStatusPage } from './lib/pages.mjs'
import { loadState, saveState } from './lib/state.mjs'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

export const name = 'dsh-link'
export const inject = ['webServer', 'connection']

/** 现读磁盘上的版本：插件更新后不用重启 dsh，状态页也不会显示旧版本号。 */
const currentVersion = () => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version
  } catch {
    return pkg.version
  }
}

const isLoopback = (req) => {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const readJsonBody = async (req) => {
  const chunks = []
  let size = 0
  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8192) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', resolve)
    req.on('error', resolve)
  })
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.(name) ?? console
  const link = createLinkRuntime(ctx, { logger, version: currentVersion(), config })
  const phone = createPhoneRuntime(ctx, { logger })

  const currentRole = () => (link.rt.state.role === 'phone' ? 'phone' : 'computer')

  const pageData = () => ({
    ...link.status(),
    role: currentRole(),
    phone: phone.status(),
  })

  const guard = (req, res) => {
    if (isLoopback(req)) return true
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('这个页面只允许在电脑本机打开。')
    return false
  }

  const renderPage = (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(renderStatusPage(pageData()))
  }

  /**
   * 切角色：写盘 → 停掉不要的那半边 → 起要的那半边。
   * 顺序很重要：先停再起，否则 3199 会撞端口。
   */
  async function switchRole(next) {
    const role = next === 'phone' ? 'phone' : 'computer'
    const state = await loadState()
    state.role = role
    await saveState(state)
    link.rt.state.role = role

    // 手机端半边（只听 127.0.0.1）一直开着：角色只决定"要不要对外开 3199 + 隧道"，
    // 这样面板/连接管理不会因为角色不对而报"本机代理没在跑"。
    await phone.start()

    if (role === 'phone') {
      await link.stop()
      await link.tunnel.stop()
      logger.info?.(`dsh-link: 已切到「手机端」角色，本机反向代理 127.0.0.1:${phone.status().port ?? '?'}`)
    } else {
      await link.boot()
      logger.info?.('dsh-link: 已切到「电脑端」角色')
    }
    return pageData()
  }

  const handleApi = async (req, res) => {
    // GET 只读状态：状态页在等隧道地址时靠它轮询。
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, state: pageData() })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '只接受 GET / POST' })
      return
    }
    let payload = {}
    try {
      payload = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    try {
      if (String(payload.op ?? '') === 'role') {
        const next = payload.role === 'phone' ? 'phone' : 'computer'
        if (next !== currentRole()) await switchRole(next)
        sendJson(res, 200, { ok: true, state: pageData() })
        return
      }
      const state = await link.manage(payload)
      sendJson(res, 200, { ok: true, state: { ...state, role: currentRole(), phone: phone.status() } })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
    }
  }

  // 同一个状态页/接口，两个入口：dsh 的回环路由 + 插件自己的固定端口（后者由运行时内部判回环）。
  link.setManagement({ page: renderPage, api: handleApi })

  ctx.effect(() => {
    const disposers = []
    const register = (route) => {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (error) {
        logger.warn?.(`dsh-link: 路由 ${route.path} 注册失败 ${error?.message ?? error}`)
      }
    }

    register({
      kind: 'exact',
      path: '/__link',
      handler: (req, res) => {
        if (!guard(req, res)) return
        res.writeHead(302, { location: '/__link/ui', 'cache-control': 'no-store' })
        res.end()
      },
    })

    register({
      kind: 'exact',
      path: '/__link/ui',
      handler: (req, res) => {
        if (!guard(req, res)) return
        renderPage(res)
      },
    })

    register({
      kind: 'exact',
      path: '/__link/api',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        await handleApi(req, res)
      },
    })

    // 手机端面板靠这个拿本机代理端口（客户端插件是同一份，路径保持不变）。
    register({
      kind: 'exact',
      path: phone.PORT_ROUTE,
      handler: (req, res) => {
        if (!guard(req, res)) return
        sendJson(res, 200, { port: phone.status().port ?? 0 })
      },
    })

    // 同源转发：面板里的 iframe / 状态页跟本机代理不同端口，直接 fetch 会被 CORS 拦成
    // "failed to fetch"。这里在 dsh 自己的域上开一条 /__phone/* 转发过去，客户端就不用跨源了。
    register({
      kind: 'prefix',
      path: '/__phone',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const port = phone.status().port
        if (!port) {
          sendJson(res, 503, { ok: false, error: '本机代理没在跑（这台设备可能还没选「作为手机」）' })
          return
        }
        const target = (req.url ?? '/').replace(/^\/__phone/, '') || '/__ctl/state'
        const upstream = httpRequest(
          { hostname: '127.0.0.1', port, path: target, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers)
            upRes.pipe(res)
          },
        )
        upstream.on('error', (error) => {
          if (!res.headersSent) sendJson(res, 502, { ok: false, error: `转发到本机代理失败：${error?.message ?? error}` })
          else res.destroy()
        })
        req.pipe(upstream)
      },
    })

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 忽略：路由可能已随宿主一起销毁
        }
      }
    }
  }, 'dsh-link: 状态页与接口')

  ctx.effect(() => {
    let disposed = false
    const boot = async () => {
      link.rt.state = await loadState()
      // 手机端半边永远起来（只绑回环），角色只决定要不要对外开 3199。
      await phone.start()
      if (link.rt.state.role === 'phone') {
        if (!disposed) logger.info?.(`dsh-link: 手机端已就绪 127.0.0.1:${phone.status().port ?? '?'}`)
        return
      }
      await link.boot()
      const state = link.status()
      const fixed = state.port ? `http://127.0.0.1:${state.port}/__link/ui` : '（等端口）'
      if (!disposed) {
        logger.info?.(
          `dsh-link: 状态页 ${fixed}` + (state.listening ? ` · 手机访问 ${state.lanUrl}` : ' · 手机访问未开启'),
        )
      }
    }
    boot().catch((error) => logger.error?.(`dsh-link: 启动失败 ${error?.message ?? error}`))
    return () => {
      disposed = true
      phone.stop()
      link.stop()
    }
  }, 'dsh-link: 启停')

  return () => {
    phone.stop()
    link.stop()
  }
}
