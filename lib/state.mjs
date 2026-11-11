/**
 * 电脑端状态：开关、端口、访问密码。
 *
 * 存在 $DSH_HOME/dsh-link/state.json（0600）。改密码不需要重装插件，
 * 因为密码是我们自己那把门的，不是 dsh 的。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { networkInterfaces } from 'node:os'
import path from 'node:path'

export const HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
export const STATE_DIR = path.join(HOME, 'dsh-link')
export const STATE_FILE = path.join(STATE_DIR, 'state.json')

/** 默认端口刻意避开 3081（dsh-pocket 的默认端口），两个插件可以同时装。 */
export const DEFAULT_PORT = 3199
const PORT_FALLBACKS = 12

/** 8 位数字密码（和 dsh-pocket 观感一致，手输不吃力）。 */
export function newPin() {
  return String(randomInt(10_000_000, 100_000_000))
}

export function normalizePin(value) {
  const pin = String(value ?? '').trim()
  return pin.length >= 8 && pin.length <= 64 ? pin : null
}

export async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return {
      enabled: parsed.enabled !== false,
      port: Number.isInteger(parsed.port) ? parsed.port : null,
      pin: normalizePin(parsed.pin) ?? newPin(),
      // 公网密码：留空 = 跟局域网用同一个。填了就对隧道地址单独生效。
      pinPublic: normalizePin(parsed.pinPublic) ?? '',
      bind: typeof parsed.bind === 'string' && parsed.bind !== '' ? parsed.bind : '0.0.0.0',
      // 竖屏适配：默认开。关掉之后手机竖屏会看到 dsh 自己的窄屏布局（主区被挤出屏幕）。
      fit: parsed.fit !== false,
      lanEnabled: parsed.lanEnabled !== false,
      // 公网隧道：'off' | 'quick'（免费、地址每次变）| 'named'（固定域名，要 token）
      tunnelMode: parsed.tunnelMode === 'quick' || parsed.tunnelMode === 'named' ? parsed.tunnelMode : 'off',
      tunnelToken: typeof parsed.tunnelToken === 'string' ? parsed.tunnelToken : '',
      tunnelHostname: typeof parsed.tunnelHostname === 'string' ? parsed.tunnelHostname : '',
      // 这台设备当什么用：'computer'（开入口给手机连）| 'phone'（连电脑、在面板里操作）
      // 第一次装的时候按平台猜：Windows/macOS 当电脑，其它（安卓壳子里的 node 常报 linux）当手机。
      role:
        parsed.role === 'phone' || parsed.role === 'computer'
          ? parsed.role
          : process.platform === 'win32' || process.platform === 'darwin'
            ? 'computer'
            : 'phone',
    }
  } catch {
    return {
      enabled: true, port: null, pin: newPin(), bind: '0.0.0.0', fit: true, lanEnabled: true,
      pinPublic: '',
      tunnelMode: 'off', tunnelToken: '', tunnelHostname: '',
      role: process.platform === 'win32' || process.platform === 'darwin' ? 'computer' : 'phone',
    }
  }
}

export async function saveState(state) {
  await mkdir(STATE_DIR, { recursive: true })
  const body = {
    enabled: state.enabled !== false,
    port: state.port ?? null,
    pin: state.pin,
    pinPublic: state.pinPublic ?? '',
    bind: state.bind ?? '0.0.0.0',
    fit: state.fit !== false,
    lanEnabled: state.lanEnabled !== false,
    tunnelMode: state.tunnelMode ?? 'off',
    tunnelToken: state.tunnelToken ?? '',
    tunnelHostname: state.tunnelHostname ?? '',
    role: state.role === 'phone' ? 'phone' : 'computer',
  }
  await writeFile(STATE_FILE, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
}

/** 候选端口：上次成功的端口优先，然后默认端口往下顺延。 */
export function portCandidates(preferred) {
  const list = []
  if (Number.isInteger(preferred)) list.push(preferred)
  for (let offset = 0; offset < PORT_FALLBACKS; offset += 1) list.push(DEFAULT_PORT + offset)
  return [...new Set(list)]
}

/** 局域网 IPv4：优先 192.168 / 10 / 172.16-31，跳过虚拟网卡与回环。 */
export function lanAddress() {
  const rows = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const [a, b] = item.address.split('.').map(Number)
      const priv = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      rows.push({ name, address: item.address, priv })
    }
  }
  const picked = rows.find((row) => row.priv && !/vethernet|vmware|virtualbox|hyper-v/i.test(row.name)) ?? rows.find((row) => row.priv)
  return picked?.address ?? rows[0]?.address ?? '127.0.0.1'
}

export function machineName() {
  try {
    return hostname()
  } catch {
    return 'computer'
  }
}
