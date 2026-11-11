/**
 * 找 cloudflared：公网隧道要用的那个独立可执行文件，不是 npm 依赖。
 *
 * 用户可能什么都没装，所以这里要能自己下下来：
 *   1. 先在几个常见位置找（插件自己的 bin、dsh-pocket 下好的、各 profile 的 node_modules、PATH）；
 *   2. 找不到就按顺序试多个下载源（官方 GitHub + 几个 GitHub 镜像，谁通用谁）；
 *   3. 全都失败时，把"试过哪些源、为什么失败、手动该怎么做"原样交给调用方去展示。
 *
 * 下载下来的文件一律先落到 .part，校验能跑（--version）之后再改名，避免留下半截文件。
 */
import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { get } from 'node:https'
import { homedir } from 'node:os'
import path from 'node:path'

export const HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
export const BIN_DIR = path.join(HOME, 'dsh-link', 'bin')
const BIN_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
export const OWN_BINARY = path.join(BIN_DIR, BIN_NAME)

const GH_LATEST = 'https://github.com/cloudflare/cloudflared/releases/latest/download'

/** 官方文件名（按平台/架构）。macOS 官方只发 .tgz，这里不支持自动装。 */
function assetName() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? null : 'cloudflared-windows-amd64.exe'
  }
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'cloudflared-linux-arm64'
    if (process.arch === 'x64') return 'cloudflared-linux-amd64'
    return null
  }
  return null
}

/** 下载源：官方在前，后面几个是 GitHub 镜像（国内直连 GitHub 常常超时）。 */
export function downloadSources() {
  const asset = assetName()
  if (!asset) return []
  const official = `${GH_LATEST}/${asset}`
  return [
    { label: 'GitHub 官方', url: official },
    { label: '镜像 ghproxy.net', url: `https://ghproxy.net/${official}` },
    { label: '镜像 gh-proxy.com', url: `https://gh-proxy.com/${official}` },
    { label: '镜像 ghfast.top', url: `https://ghfast.top/${official}` },
  ]
}

/** 手动下载时建议放的位置（给用户看）。 */
export const MANUAL_TARGET = OWN_BINARY
export const MANUAL_PAGE = 'https://github.com/cloudflare/cloudflared/releases/latest'

const exists = async (file) => {
  try {
    await access(file)
    const info = await stat(file)
    return info.isFile() && info.size > 1024 * 1024
  } catch {
    return false
  }
}

/** 版本探测：能跑起来才算数（有的残留文件是半截下载）。 */
export function probeVersion(binary) {
  try {
    const result = spawnSync(binary, ['--version'], { timeout: 8000, windowsHide: true, encoding: 'utf8' })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    const match = text.match(/cloudflared version (\S+)/i)
    if (result.status === 0 && match) return match[1]
    return null
  } catch {
    return null
  }
}

/** 会去找的每一个位置（顺序即优先级），诊断信息里原样给用户看。 */
export async function searchPaths() {
  const list = [
    { path: OWN_BINARY, label: '插件自己下载的' },
    { path: path.join(HOME, 'dsh-pocket', 'bin', BIN_NAME), label: 'dsh-pocket 下好的' },
  ]
  const profilesDir = path.join(HOME, 'profiles')
  try {
    for (const name of await readdir(profilesDir)) {
      list.push({ path: path.join(profilesDir, name, 'node_modules', 'cloudflared', 'bin', BIN_NAME), label: `profile ${name} 的依赖` })
    }
  } catch {
    // 没有 profiles 目录就算了
  }
  list.push({ path: BIN_NAME, label: '系统 PATH' })
  return list
}

/** 返回 { binary, version, source } 或 null。 */
export async function resolveCloudflared() {
  const override = process.env.DSH_LINK_CLOUDFLARED
  if (override) {
    const version = probeVersion(override)
    if (version) return { binary: override, version, source: 'env' }
  }
  for (const candidate of await searchPaths()) {
    if (candidate.path === BIN_NAME) {
      const version = probeVersion(BIN_NAME)
      if (version) return { binary: BIN_NAME, version, source: 'PATH' }
      continue
    }
    if (!(await exists(candidate.path))) continue
    const version = probeVersion(candidate.path)
    if (version) {
      return { binary: candidate.path, version, source: candidate.path === OWN_BINARY ? 'own' : 'found' }
    }
  }
  return null
}

/** 环境体检：给状态页用（缺什么、去哪找过、能不能自己下）。 */
export async function diagnose() {
  const found = await resolveCloudflared()
  const searched = []
  for (const candidate of await searchPaths()) {
    if (candidate.path === BIN_NAME) {
      searched.push({ ...candidate, state: probeVersion(BIN_NAME) ? 'ok' : 'not-found' })
      continue
    }
    const present = await exists(candidate.path)
    searched.push({ ...candidate, state: present ? (probeVersion(candidate.path) ? 'ok' : 'broken') : 'not-found' })
  }
  return {
    platform: `${process.platform}/${process.arch}`,
    found,
    searched,
    canDownload: downloadSources().length > 0,
    sources: downloadSources(),
    manualTarget: MANUAL_TARGET,
    manualPage: MANUAL_PAGE,
  }
}

function downloadOnce(url, target, { connectTimeoutMs = 12_000, stallMs = 25_000, limitMs = 6 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const follow = (current, redirects) => {
      if (redirects > 6) {
        fail(new Error('重定向太多'))
        return
      }
      const req = get(
        current,
        { headers: { 'user-agent': 'dsh-link', accept: '*/*' }, timeout: connectTimeoutMs },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            follow(new URL(res.headers.location, current).toString(), redirects + 1)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            fail(new Error(`HTTP ${res.statusCode}`))
            return
          }
          const total = Number(res.headers['content-length'] ?? 0)
          let received = 0
          let lastData = Date.now()
          const out = createWriteStream(target)
          const stallTimer = setInterval(() => {
            if (Date.now() - lastData > stallMs) {
              clearInterval(stallTimer)
              req.destroy(new Error('下载卡住了'))
            }
            if (Date.now() - started > limitMs) {
              clearInterval(stallTimer)
              req.destroy(new Error('下载超时'))
            }
          }, 2000)
          res.on('data', (chunk) => {
            received += chunk.length
            lastData = Date.now()
          })
          res.pipe(out)
          out.on('finish', () => {
            clearInterval(stallTimer)
            out.close(() => {
              if (total > 0 && received < total * 0.98) {
                fail(new Error(`只下到 ${received}/${total} 字节`))
                return
              }
              if (settled) return
              settled = true
              resolve(received)
            })
          })
          out.on('error', (error) => {
            clearInterval(stallTimer)
            fail(error)
          })
          res.on('error', (error) => {
            clearInterval(stallTimer)
            fail(error)
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('连接超时')))
      req.on('error', fail)
    }

    follow(url, 0)
  })
}

/**
 * 依次试每个下载源，成功就装到插件自己的 bin 目录。
 * 返回 { binary, version, source, mirror, attempted }；全失败时抛出的错误带 attempted 明细。
 */
export async function downloadCloudflared({ onAttempt } = {}) {
  const sources = downloadSources()
  if (sources.length === 0) {
    const error = new Error(`这个系统（${process.platform}/${process.arch}）没法自动装 cloudflared，请手动下载放到 ${MANUAL_TARGET}`)
    error.attempted = []
    throw error
  }
  await mkdir(BIN_DIR, { recursive: true })
  const attempted = []
  for (const source of sources) {
    const partial = `${OWN_BINARY}.part`
    await rm(partial, { force: true })
    try {
      onAttempt?.(source, attempted.length)
      const bytes = await downloadOnce(source.url, partial)
      const info = await stat(partial)
      if (info.size < 20 * 1024 * 1024) throw new Error(`文件太小（${Math.round(info.size / 1024)} KB），可能被拦截了`)
      if (process.platform !== 'win32') await chmod(partial, 0o755)
      await rename(partial, OWN_BINARY)
      const version = probeVersion(OWN_BINARY)
      if (!version) {
        await rm(OWN_BINARY, { force: true })
        throw new Error('下载完成但运行不起来（可能是坏的或不完整的文件）')
      }
      attempted.push({ label: source.label, url: source.url, ok: true, bytes })
      return { binary: OWN_BINARY, version, source: 'downloaded', mirror: source.label, attempted }
    } catch (error) {
      attempted.push({ label: source.label, url: source.url, ok: false, error: error?.message ?? String(error) })
      await rm(partial, { force: true })
    }
  }
  const error = new Error(`所有下载源都没成功（试了 ${attempted.length} 个）`)
  error.attempted = attempted
  throw error
}
