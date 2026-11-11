/**
 * 公网隧道：把本机这个密码门反向代理挂到公网上，让不在同一个 WiFi 的手机也能连。
 *
 * 两种模式：
 *   quick —— 快速隧道，免费、不需要账号，但**地址每次重启都变**（Cloudflare 随机分配）。
 *   named —— 命名隧道，需要 Cloudflare 账号里那条隧道的 token + 一个已经指过去的域名；
 *            地址固定（例如 https://dsh.example.com），重启也不变。
 *
 * 一个关键设计：隧道进程**独立于 dsh 活着**（detached + 把输出写文件）。
 * 这样"只重启 dsh / 只重开插件"时快速隧道的地址不会变，只有重启电脑才会变。
 * 启动时先认领上一次还活着的进程（pid + 地址都验一遍），认领成功就沿用旧地址。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, open, readFile, rename, stat, writeFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { Resolver } from 'node:dns/promises'
import path from 'node:path'
import { HOME } from './cloudflared.mjs'

const DIR = path.join(HOME, 'dsh-link')
const RUNTIME_FILE = path.join(DIR, 'tunnel.json')
const LOG_FILE = path.join(DIR, 'tunnel.log')
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const START_TIMEOUT_MS = 45_000
const LOG_LIMIT_BYTES = 2 * 1024 * 1024

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限发信号，也算活着
    return error?.code === 'EPERM'
  }
}

/** 用公共 DNS 解析：本机/路由器的 DNS 可能刚缓存了"这个域名不存在"，等它过期很烦。 */
async function resolvePublic(hostname) {
  const resolver = new Resolver({ timeout: 4000, tries: 2 })
  try {
    resolver.setServers(['1.1.1.1', '8.8.8.8'])
  } catch {
    // 某些环境不让设，退回系统 DNS
  }
  try {
    const list = await resolver.resolve4(hostname)
    return list[0] ?? null
  } catch {
    return null
  }
}

/** 拿到进程名：认领旧隧道时要确认那个 pid 现在确实还是个 cloudflared。 */
function processName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        timeout: 4000,
        encoding: 'utf8',
        windowsHide: true,
      })
      const first = String(out.stdout ?? '').trim().split('\n')[0] ?? ''
      return (first.split(',')[0] ?? '').replace(/^"|"$/g, '').trim()
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 4000, encoding: 'utf8' })
    return String(out.stdout ?? '').trim()
  } catch {
    return ''
  }
}

const looksLikeCloudflared = (pid) => /cloudflared/i.test(processName(pid))

/** 从公网地址问一次版本接口：能通说明隧道确实在工作。 */
async function probeUrl(url, timeoutMs = 10_000) {
  let target
  try {
    target = new URL('/__link/version', url)
  } catch {
    return false
  }
  const ip = await resolvePublic(target.hostname)
  if (!ip) return false
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: ip,
        servername: target.hostname, // SNI 要用域名，Cloudflare 才认
        path: target.pathname,
        method: 'GET',
        headers: { host: target.hostname },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function readTail(offset) {
  try {
    const text = await readFile(LOG_FILE, 'utf8')
    return text.slice(Math.min(offset, text.length))
  } catch {
    return ''
  }
}

async function fileSize() {
  try {
    return (await stat(LOG_FILE)).size
  } catch {
    return 0
  }
}

export function createTunnelManager({ logger = console } = {}) {
  /** 运行中的隧道：{ pid, url, mode, port, startedAt, phase } */
  let running = null

  const persist = async () => {
    if (!running) {
      await rm(RUNTIME_FILE, { force: true })
      return
    }
    await mkdir(DIR, { recursive: true })
    const body = {
      pid: running.pid ?? null,
      url: running.url ?? null,
      mode: running.mode,
      port: running.port,
      startedAt: running.startedAt ?? null,
    }
    await writeFile(RUNTIME_FILE, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  }

  async function killPid(pid) {
    if (!isAlive(pid)) return
    try {
      process.kill(pid)
    } catch {
      // 忽略：可能刚好已经退了
    }
    for (let i = 0; i < 20; i += 1) {
      if (!isAlive(pid)) return
      await sleep(150)
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Windows 上 SIGKILL 等同强杀，失败就算了
    }
  }

  /** 收掉当前隧道（含上次遗留的进程）。 */
  async function stop() {
    const pid = running?.pid
    running = null
    if (pid) await killPid(pid)
    await persist()
  }

  /** 反复探一个地址，直到通或者次数用完。返回最终是否可达。 */
  async function watchUntilReachable(url, attempts, intervalMs) {
    for (let i = 0; i < attempts; i += 1) {
      await sleep(intervalMs)
      if (!running || running.phase !== 'running' || running.url !== url) return true // 目标变了就别追了
      if (await probeUrl(url)) {
        running = { ...running, reachable: true }
        await persist()
        return true
      }
    }
    return false
  }

  /**
   * 启动。config = { mode:'quick'|'named', token, hostname }，port 是本地密码门端口。
   * 返回 running（phase 已经是 running 或 error）。
   */
  async function start(binary, config, port) {
    await stop()

    const args =
      config.mode === 'named'
        ? ['tunnel', '--no-autoupdate', 'run', '--token', config.token, '--url', `http://127.0.0.1:${port}`]
        : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]

    // 日志太大的时候先截断，省得越读越慢；旧内容对我们没用了。
    const size = await fileSize()
    if (size > LOG_LIMIT_BYTES) await writeFile(LOG_FILE, '')
    const offset = await fileSize()

    await mkdir(DIR, { recursive: true })
    const handle = await open(LOG_FILE, 'a')
    await handle.write(`\n--- ${new Date().toISOString()} start ${config.mode} ---\n`)

    running = {
      mode: config.mode,
      port,
      pid: null,
      url: config.mode === 'named' && config.hostname ? `https://${config.hostname}` : null,
      startedAt: Date.now(),
      phase: 'starting',
      error: null,
    }

    let child
    try {
      child = spawn(binary, args, {
        // detached + unref：dsh 退出后它继续活着，下次启动能认领回来。
        detached: true,
        windowsHide: true,
        stdio: ['ignore', handle.fd, handle.fd],
      })
      child.unref()
    } catch (error) {
      await handle.close()
      running = { ...running, phase: 'error', error: error?.message ?? String(error) }
      await persist()
      return running
    }
    await handle.close()

    if (!child.pid) {
      running = { ...running, phase: 'error', error: 'cloudflared 没起来' }
      await persist()
      return running
    }
    running.pid = child.pid
    logger.info?.(`dsh-link: 隧道进程已启动 pid=${child.pid} 模式=${config.mode}`)

    child.on('exit', (code) => {
      if (!running || running.pid !== child.pid) return
      running = { ...running, phase: 'error', error: `cloudflared 退了（退出码 ${code}）` }
      logger.warn?.(`dsh-link: 隧道进程退出 code=${code}`)
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(600)
      const tail = await readTail(offset)
      if (config.mode === 'quick') {
        const match = tail.match(QUICK_URL_RE)
        if (match) {
          running = { ...running, url: match[0], phase: 'running' }
          break
        }
      } else if (/Registered tunnel connection/i.test(tail)) {
        running = { ...running, phase: 'running' }
        break
      }
      if (!isAlive(child.pid)) {
        running = { ...running, phase: 'error', error: 'cloudflared 启动后马上退出了，看 tunnel.log' }
        break
      }
    }

    if (running.phase === 'starting') {
      running = { ...running, phase: 'error', error: `${START_TIMEOUT_MS / 1000} 秒内没拿到地址，看 tunnel.log` }
    }

    // 地址一拿到就先落盘：这样"只重启 dsh"的时候下次启动能认领回来。
    await persist()

    if (running.phase === 'running' && running.url) {
      // 再验一次：地址出来了不代表能访问（Cloudflare 那边要几秒、本机 DNS 还可能缓存了否定答案）
      for (let i = 0; i < 4; i += 1) {
        if (await probeUrl(running.url)) {
          running = { ...running, reachable: true }
          break
        }
        await sleep(2000)
      }
      await persist()

      // 还没验通就后台再追一会儿：DNS 生效常常要一分多钟，状态页下次刷新就能看到「已验证」。
      if (!running.reachable) void watchUntilReachable(running.url, 8, 10_000)
    }

    return running
  }

  /**
   * 认领上次遗留的隧道。
   *
   * 判据刻意**不要求"现在能访问"**：快速隧道的域名刚分配时，本机或路由器的 DNS 常常
   * 还缓存着"该域名不存在"，可隧道本身是好的。真正的证据是：
   *   pid 还活着 + 那个 pid 现在确实还是个 cloudflared + 模式/端口对得上。
   * 认领回来之后如果确实连不上，boot() 那边会再重起一条。
   */
  async function adopt(config, port) {
    let saved
    try {
      saved = JSON.parse(await readFile(RUNTIME_FILE, 'utf8'))
    } catch {
      return null
    }
    if (!saved?.url || saved.mode !== config.mode || saved.port !== port) return null
    if (!isAlive(saved.pid) || !looksLikeCloudflared(saved.pid)) return null
    if (config.mode === 'named' && saved.url !== `https://${config.hostname}`) return null
    const reachable = await probeUrl(saved.url)
    running = {
      mode: saved.mode,
      port: saved.port,
      pid: saved.pid,
      url: saved.url,
      startedAt: saved.startedAt ?? null,
      phase: 'running',
      reachable,
      adopted: true,
    }
    logger.info?.(`dsh-link: 沿用上次的隧道 ${saved.url}（pid=${saved.pid}，可达=${reachable}）`)
    return running
  }

  /** 认领失败时把遗留的那个 cloudflared 收掉，别留孤儿进程。 */
  async function discardSaved() {
    try {
      const saved = JSON.parse(await readFile(RUNTIME_FILE, 'utf8'))
      if (saved?.pid && isAlive(saved.pid) && looksLikeCloudflared(saved.pid)) {
        logger.info?.(`dsh-link: 收掉上次遗留的隧道进程 pid=${saved.pid}`)
        await killPid(saved.pid)
      }
    } catch {
      // 没文件就算了
    }
    await rm(RUNTIME_FILE, { force: true })
  }

  function status() {
    return {
      state: running?.phase ?? 'off',
      url: running?.url ?? null,
      mode: running?.mode ?? 'off',
      pid: running?.pid ?? null,
      startedAt: running?.startedAt ?? null,
      reachable: Boolean(running?.reachable),
      adopted: Boolean(running?.adopted),
      error: running?.error ?? null,
      logPath: LOG_FILE,
    }
  }

  return { start, stop, adopt, discardSaved, watch: watchUntilReachable, status, logFilePath: LOG_FILE }
}
