/**
 * 页面：登录门（给手机浏览器看的）＋ 状态页（给电脑本人看的）。
 *
 * 两件约定：
 *  1. 登录页 HTML 里必须出现 `current-password` 或 `访问密码`——手机端插件靠这两个
 *     字符串判断"撞墙了"，换掉会认不出（见 SPEC.md）。
 *  2. 状态页只挂在 dsh 自己的回环路由上，里面会明文显示访问密码，所以调用方必须先
 *     确认请求来自 127.0.0.1（见 index.js）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 二维码库是随包内置的（MIT），不走 CDN：没网也要能出码。 */
function loadQrLib() {
  try {
    return require('../vendor/qrcode.cjs')
  } catch {
    return null
  }
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

/** 把文本编成二维码 SVG；库缺失时返回 null，调用方退回只给地址。 */
export function renderQrSvg(text, size = 208) {
  const qrcode = loadQrLib()
  if (!qrcode) return null
  try {
    const qr = qrcode(0, 'M')
    qr.addData(String(text))
    qr.make()
    const count = qr.getModuleCount()
    const quiet = 2
    const box = count + quiet * 2
    // 每个模块必须是整数像素，否则浏览器会把边缘抹成半透明、扫码变难。
    const scale = Math.max(2, Math.floor(size / box))
    let path = ''
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`
      }
    }
    const pixels = box * scale
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges"><rect width="${box}" height="${box}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  } catch {
    return null
  }
}

const BASE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 26px 18px 56px;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
main { max-width: 620px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { margin: 0 0 22px; font-size: 13px; opacity: .65; }
h2 { font-size: 14px; margin: 0 0 12px; opacity: .85; font-weight: 600; }
.card { border: 1px solid rgba(127,127,127,.28); border-radius: 12px; padding: 13px 14px; margin-bottom: 10px; }
.row { display: flex; gap: 12px; align-items: flex-start; }
.grow { flex: 1 1 auto; min-width: 0; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; word-break: break-all; }
button {
  font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 9px;
  border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; cursor: pointer; white-space: nowrap;
}
button:hover { background: rgba(127,127,127,.12); }
button.primary { padding: 11px 16px; font-size: 14px; }
input {
  font: inherit; font-size: 14px; padding: 9px 11px; border-radius: 9px;
  border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; width: 100%;
}
.hint { font-size: 12.5px; opacity: .62; margin-top: 8px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
.dot.on { background: #22c55e; }
.dot.off { background: #9ca3af; }
.kv { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.kv:last-child { margin-bottom: 0; }
.kv .k { font-size: 12.5px; opacity: .6; flex: 0 0 auto; }
.kv .v { text-align: right; min-width: 0; overflow-wrap: anywhere; }
.qr { flex: 0 0 auto; line-height: 0; border-radius: 10px; overflow: hidden; }
.err { margin-top: 10px; font-size: 13px; color: #c0392b; min-height: 18px; }
ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li { padding: 10px 0; border-bottom: 1px solid rgba(127,127,127,.18); }
ul.plain li:last-child { border-bottom: 0; }
.tag { display: inline-block; margin-left: 8px; font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid rgba(127,127,127,.4); opacity: .8; }
.url { font-size: 12px; opacity: .6; word-break: break-all; }
.meta { min-width: 0; }
`

function pageShell(title, bodyHtml) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style></head><body><main>${bodyHtml}</main></body></html>`
}

/** 手机撞门时看到的页面（SPEC 要求：200 + HTML，含 current-password / 访问密码）。 */
export function renderLoginPage(message = '') {
  const body = `
<h1>需要访问密码</h1>
<p class="sub">这台电脑上的 DSH 只对知道密码的人开放。</p>
<div class="card">
  <form method="post" action="/__link/login">
    <label for="current-password" class="k" style="font-size:12.5px;opacity:.6">访问密码</label>
    <input id="current-password" name="token" type="password"
           autocomplete="current-password" placeholder="输入密码" autofocus>
    <button class="primary" type="submit" style="margin-top:12px;width:100%">进入</button>
  </form>
  <div class="err">${escapeHtml(message)}</div>
</div>
<p class="hint">密码在电脑上打开 <code>/__link/ui</code> 就能看到；电脑那边重新生成密码后，这里要用新的。</p>`
  return pageShell('访问验证 · dsh-link', body)
}

const baseName = (value) => String(value ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')

const SOURCE_LABEL = {
  own: '插件自己的',
  found: '复用本机已有的',
  downloaded: '刚下载的',
  env: '环境变量指定的',
  PATH: '系统 PATH 里的',
}

const STATE_LABEL = {
  ok: '有',
  'not-found': '没有',
  broken: '有文件但跑不起来',
}

/** cloudflared 这一块：装了显示版本，正在下显示进度，缺了/失败了给红字 + 怎么手动解决。 */
function cloudflaredSection(tunnel) {
  const install = tunnel?.install
  const binary = tunnel?.binary
  const diag = tunnel?.diagnostic

  if (binary) {
    const from = binary.mirror ? `${SOURCE_LABEL[binary.source] ?? binary.source}，来自 ${binary.mirror}` : SOURCE_LABEL[binary.source] ?? binary.source
    return `<p class="hint">cloudflared ${escapeHtml(binary.version)}（${escapeHtml(from)}）</p>`
  }

  if (install?.state === 'downloading') {
    return `<div data-tunnel-installing="1" style="margin-top:10px">
      <p class="hint" style="margin:0">本机没有 cloudflared，正在自动下载${install.mirror ? `（当前源：${escapeHtml(install.mirror)}）` : ''}…下载完会自己接着开隧道，这个页面会刷新。</p>
    </div>`
  }

  const searched = Array.isArray(diag?.searched)
    ? diag.searched.map((row) => `<li><code>${escapeHtml(row.path)}</code> — ${escapeHtml(row.label)}：${escapeHtml(STATE_LABEL[row.state] ?? row.state)}</li>`).join('')
    : ''
  const platformLine = diag ? `系统：<code>${escapeHtml(diag.platform)}</code>${diag.canDownload ? '（支持自动下载）' : '（这个系统不支持自动下载，只能手动放）'}` : ''
  const tried = Array.isArray(install?.tried) && install.tried.length > 0
    ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12px">${install.tried
        .map((row) => `<li>${escapeHtml(row.label)}：${row.ok ? '成功' : escapeHtml(row.error ?? '失败')}</li>`)
        .join('')}</ul>`
    : ''

  const headline = install?.state === 'error'
    ? `自动下载没成功：${escapeHtml(install.error ?? '未知原因')}`
    : '缺少 cloudflared——公网隧道要靠它，本机没找到。'

  const manual = `手动办法：打开 <a href="${escapeHtml(diag?.manualPage ?? 'https://github.com/cloudflare/cloudflared/releases/latest')}" target="_blank" rel="noreferrer">cloudflared 发布页</a>，
  下载对应你系统的文件，改名成 <code>${escapeHtml((tunnel?.binaryPath ?? 'cloudflared').split(/[\\/]/).pop())}</code> 放到
  <code>${escapeHtml(tunnel?.binaryPath ?? '')}</code>，然后点「重新检测」。`

  return `<div class="err" style="border:1px solid rgba(192,57,43,.4);border-radius:10px;padding:10px 12px;margin:12px 0">
  <strong>${headline}</strong>
  ${tried}
  ${platformLine ? `<div style="margin-top:8px;font-size:12px">${platformLine}</div>` : ''}
  ${searched ? `<div style="margin-top:6px;font-size:12px">找过这些地方：</div><ul style="margin:4px 0 0;padding-left:18px;font-size:12px">${searched}</ul>` : ''}
  <div style="margin-top:8px;font-size:12px">${manual}</div>
</div>
<div class="row" style="gap:10px;flex-wrap:wrap">
  ${diag?.canDownload === false ? '' : '<button data-op="tunnel-install">自动下载 cloudflared</button>'}
  <button data-op="tunnel-recheck">重新检测</button>
</div>`
}

function tunnelCardTitle(tunnel) {
  const state = tunnel?.state ?? 'off'
  let label = '未开启'
  if (state === 'running') label = tunnel.mode === 'named' ? '已连上 · 固定域名' : '已连上 · 快速隧道'
  else if (state === 'starting') label = '正在申请地址…'
  else if (state === 'error') label = '出错'
  return `　<span class="mono" style="font-size:12px;opacity:.6;font-weight:400">${escapeHtml(label)}</span>`
}

function tunnelCardBody(tunnel, port, data = {}) {
  if (!tunnel) return '<p class="hint" style="margin-top:0">隧道状态未知。</p>'
  const state = tunnel.state
  const binaryLine = cloudflaredSection(tunnel)

  // 公网那一路的密码块：跟局域网一样「地址在上、密码在下、编辑在最后」
  const publicPin = data.pinPublic ?? data.pin ?? ''
  const pinBlock = `
  <div class="row" style="gap:8px;margin-top:8px">
    <input id="pin-public" placeholder="自定义公网密码" autocomplete="off" spellcheck="false">
    <button data-op="pin-public">保存</button>
  </div>`

  if (state === 'running' && tunnel.url) {
    const qr = renderQrSvg(tunnel.url, 160)
    const note =
      tunnel.mode === 'named'
        ? '固定域名：重启电脑也是这个地址，手机那边永远不用改。'
        : '快速隧道的地址是 Cloudflare 随机给的：只重启 dsh 会沿用（插件会认领上次那条），重启电脑才会变。'
    return `
  <div class="row" style="gap:14px">
    ${qr ? `<div class="qr">${qr}</div>` : ''}
    <div class="grow">
      <div class="kv"><span class="k">地址</span><button data-copy="${escapeHtml(tunnel.url)}">复制</button></div>
      <div class="mono" style="margin-bottom:8px">${escapeHtml(tunnel.url)}</div>
      <div class="kv"><span class="k">密码</span><span><button data-copy="${escapeHtml(publicPin)}">复制</button><button data-op="rotate-pin-public">换一个</button></span></div>
      <div class="mono">${escapeHtml(publicPin)}</div>
      ${pinBlock}
    </div>
  </div>
  <div class="row" style="gap:10px;margin-top:10px;flex-wrap:wrap">
    <button data-op="tunnel-stop">关闭公网访问</button>
    <span class="mono" style="font-size:11.5px;opacity:.6;align-self:center">${tunnel.reachable ? '公网可达已验证' : '域名生效中'}</span>
  </div>
  <p class="hint">${escapeHtml(note)}</p>
  ${binaryLine}`
  }

  if (state === 'starting') {
    return `
  <div data-tunnel-starting="1">
    <p class="hint" style="margin-top:0">正在向 Cloudflare 申请地址，通常十几秒；这个页面会自己刷新。</p>
  </div>
  ${binaryLine}`
  }

  if (state === 'error') {
    return `
  <p class="hint" style="margin-top:0">上一次没成功：${escapeHtml(tunnel.error ?? '未知原因')}</p>
  <div class="row" style="gap:10px;flex-wrap:wrap">
    <button data-op="tunnel-retry">再试一次</button>
    <button data-op="tunnel-stop">关掉公网访问</button>
  </div>
  <p class="hint">日志：<code>${escapeHtml(tunnel.logPath ?? '')}</code></p>
  ${binaryLine}`
  }

  return `
  <p class="hint" style="margin-top:0">人不在同一个 WiFi 时用这个，免费。</p>
  <div class="row" style="gap:10px;flex-wrap:wrap">
    <button data-op="tunnel-quick">开启快速隧道</button>
  </div>
  <p class="hint">快速隧道不需要账号，地址是随机的 <code>https://xxx.trycloudflare.com</code>；
  只重启 dsh 会沿用，重启电脑才会变。</p>

  <div style="border-top:1px solid rgba(127,127,127,.2);margin:12px 0 10px"></div>

  <h2 style="font-size:13px">有域名就能固定地址</h2>
  <input id="tunnel-token" type="password" autocomplete="off" spellcheck="false" placeholder="tunnel token（Cloudflare 后台复制）" style="margin-bottom:8px">
  <input id="tunnel-hostname" autocomplete="off" spellcheck="false" placeholder="dsh.example.com" style="margin-bottom:8px">
  <button data-op="tunnel-named">用固定域名开启</button>
  <p class="hint">Cloudflare Zero Trust → 网络 → 隧道，新建一条，把公共主机名指到
  <code>http://127.0.0.1:${escapeHtml(String(port ?? 3199))}</code>，token 粘到这里即可。</p>
  ${binaryLine}`
}

function roleCard(role) {
  const isComputer = role !== 'phone'
  return `<div class="card">
  <h2>这台设备当什么用</h2>
  <p class="hint" style="margin-top:0">同一个插件两边都装：电脑那台开入口，手机那台连过来、在面板里操作。</p>
  <div class="row" style="gap:10px;flex-wrap:wrap">
    <button class="primary" data-op="role-computer"${isComputer ? ' disabled' : ''}>作为电脑（开入口给手机）</button>
    <button class="primary" data-op="role-phone"${isComputer ? '' : ' disabled'}>作为手机（连电脑、面板操作）</button>
  </div>
  <p class="hint">切换会重启这里的服务。如果你是从 <code>127.0.0.1:3199</code> 打开这个页面的，切成「手机」后 3199 就不再监听了，请改用 dsh 端口那个 <code>/__link/ui</code>。</p>
</div>`
}

function phonePageBody(role, phone) {
  const port = phone?.port ?? null
  const rows = (phone?.connections ?? [])
    .map((conn) => `<li><div class="meta"><strong>${escapeHtml(conn.label || '未命名电脑')}</strong>${conn.id === phone.activeId ? '<span class="tag">正在用</span>' : ''}
    <div class="url">${escapeHtml(conn.url)}</div></div></li>`)
    .join('')
  const manageUrl = port ? `http://127.0.0.1:${port}/__ctl/ui` : null
  return `
<h1>这台设备是手机端</h1>
<p class="sub">在手机 DSH 的侧边栏点「电脑 DSH」，就能操作电脑上的 dsh。</p>

${roleCard(role)}

<div class="card">
  <h2>本机反向代理　<span class="mono" style="font-size:12px;opacity:.6">${phone?.listening ? '运行中' : '没起来'}</span></h2>
  <div class="mono">${manageUrl ? escapeHtml(manageUrl) : '端口还没拿到'}</div>
  <p class="hint">手机页面就是通过这个本机端口去连电脑的。客户端面板里的「切换 → 添加电脑」走的是同一个入口。</p>
  ${manageUrl ? `<p><a href="${escapeHtml(manageUrl)}" target="_blank" rel="noreferrer">打开连接管理页</a></p>` : ''}
  ${phone?.lastError ? `<div class="err">${escapeHtml(phone.lastError)}</div>` : ''}
</div>

<div class="card">
  <h2>已连的电脑</h2>
  <ul class="plain">${rows || '<li>还没连过电脑。手机上打开侧边栏「电脑 DSH」→ 添加一台。</li>'}</ul>
  <p class="hint">电脑那边重启后公网地址可能会变：手机和电脑在同一个 WiFi 时，打开面板会自动去局域网问一次新地址；也可以在连接管理页点「自动找新地址」。</p>
</div>

<div class="card">
  <h2>电脑端的功能</h2>
  <p class="hint" style="margin-top:0">这台选定为手机后，电脑端的代理、公网隧道都不在这台机器上跑。要用那些能力，把角色切回「作为电脑」。</p>
</div>

<script>
const err = (text) => { const node = document.getElementById('err'); if (node) node.textContent = text || '' }
async function api(body) {
  const res = await fetch('/__link/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status))
  return json
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-op]')
  if (!button) return
  const op = button.dataset.op
  err('')
  try {
    if (op === 'role-computer') await api({ op: 'role', role: 'computer' })
    else if (op === 'role-phone') await api({ op: 'role', role: 'phone' })
    else return
    location.reload()
  } catch (error) { err(error.message) }
})
</script>`
}

/**
 * 电脑端的状态页：地址、二维码、密码、开关。
 * 数据由调用方算好传进来，这里只负责画。
 */
export function renderStatusPage(data) {
  const {
    listening, port, bind, lanUrl, pin, pinVisible = true,
    lastError, machine, version, tunnel = null, fit = true,
    role = 'computer', phone = null,
  } = data
  if (role === 'phone') return pageShell('手机端 · dsh-link', phonePageBody(role, phone))
  const qr = lanUrl ? renderQrSvg(lanUrl) : null

  const stateLine = listening
    ? `<span class="dot on"></span>正在监听 <span class="mono">${escapeHtml(bind)}:${escapeHtml(port)}</span>`
    : `<span class="dot off"></span>已关闭监听${lastError ? ` · ${escapeHtml(lastError)}` : ''}`

  const qrBlock = qr
    ? `<div class="qr">${qr}</div>`
    : `<div class="qr" style="padding:16px;font-size:12px;opacity:.6;border:1px dashed rgba(127,127,127,.4)">二维码库没加载</div>`

  // 局域网访问关闭时：二维码、地址、密码全部收起，只留一个开启按钮
  const lanOff = data.lanEnabled === false
  const lanCard = lanOff
    ? `<div class="card">
  <h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span class="dot off"></span>局域网访问已关闭
    <span class="grow"></span>
    <button data-op="lan-toggle">开启局域网访问</button>
  </h2>
  <p class="hint">只对公网地址开放。重新开启不需要改端口或密码，之前连着的手机照旧能用新票据登回来。</p>
</div>`
    : `<div class="card">
  <h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>${stateLine}</span>
    <span class="grow"></span>
    <button data-op="lan-toggle">关闭局域网访问</button>
  </h2>
  <div class="row" style="gap:14px">
    ${qrBlock}
    <div class="grow">
      <div class="kv"><span class="k">地址</span><button data-copy="${escapeHtml(lanUrl ?? '')}">复制</button></div>
      <div class="mono" style="margin-bottom:8px">${escapeHtml(lanUrl ?? '未开启')}</div>
      <div class="kv"><span class="k">密码</span><span><button data-copy="${escapeHtml(pin)}">复制</button><button data-op="rotate-pin-lan">换一个</button></span></div>
      <div class="mono">${pinVisible ? escapeHtml(pin) : '••••••••'}</div>
      <div class="row" style="gap:8px;margin-top:8px">
        <input id="pin-new" placeholder="自定义密码" autocomplete="off" spellcheck="false">
        <button data-op="pin">保存</button>
      </div>
    </div>
  </div>
  <p class="hint">同一个 WiFi 下用这个地址 + 密码。关掉局域网访问只影响私网来源，公网那一路不受影响。</p>
</div>`

  const body = `
<h1>手机访问这台电脑</h1>
<p class="sub">dsh-link ${escapeHtml(version)} · 电脑端 · ${escapeHtml(machine)}</p>

${lanCard}

<div class="card">
  <h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>公网访问${tunnelCardTitle(tunnel)}</span>
  </h2>
  ${tunnelCardBody(tunnel, port, data)}
</div>

<div class="card">
  <h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>端口 <span class="mono" style="font-size:12px;opacity:.6">${escapeHtml(String(port ?? ''))}</span></span>
    <span class="grow"></span>
    <input id="port" type="number" min="1024" max="65535" value="${escapeHtml(port ?? '')}" style="width:88px">
    <button data-op="port">保存</button>
  </h2>
  <p class="hint">默认 ${escapeHtml(String(data.defaultPort))}。改动会重启监听，地址跟着变。</p>
  <div class="err" id="err"></div>
</div>

<div class="card">
  <h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span>手机竖屏适配 <span class="mono" style="font-size:12px;opacity:.6">${fit ? '已开' : '已关'}</span></span>
    <span class="grow"></span>
    <button data-op="fit">${fit ? '关掉' : '打开'}</button>
  </h2>
  <p class="hint">手机上竖屏时 dsh 自己的布局会把会话区推出屏幕外；开着就在发给手机的页面里修一下主内容列宽。平板/横屏/电脑宽度不受影响。</p>
  <p class="hint" style="margin-bottom:0">设备密钥：${data.keysTrusted ? `已信任 1 台设备（${escapeHtml(data.keyLabel || '手机')}，指纹 ${escapeHtml(data.keyFingerprint || '')}）` : '还没配对（现在只靠密码，手机连上后会自动配对）'}
  ${data.keysTrusted ? '<button data-op="rotate-keys">作废旧密钥</button>' : ''}</p>
  <p class="hint" style="margin-bottom:0">出问题时把诊断包发给维护者：<a href="/__link/diag" download style="color:inherit;text-decoration:underline">导出诊断包</a>（密码与 token 已打码，含代理日志与 cloudflared 日志尾部）。</p>
</div>

<script>
const err = (text) => { const node = document.getElementById('err'); if (node) node.textContent = text || '' }
async function api(body) {
  const res = await fetch('/__link/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status))
  return json
}
async function pollTunnel() {
  // 下载 cloudflared、申请快速隧道都要等，页面自己轮询，别让用户手动刷
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const res = await fetch('/__link/api', { headers: { accept: 'application/json' } }).catch(() => null)
    if (!res || !res.ok) continue
    const json = await res.json().catch(() => null)
    const t = json && json.state && json.state.tunnel ? json.state.tunnel : null
    if (!t) continue
    const busy = t.state === 'starting' || (t.install && t.install.state === 'downloading')
    if (!busy) { location.reload(); return }
  }
  location.reload()
}
document.addEventListener('click', async (event) => {
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    const text = copy.dataset.copy
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制' ; setTimeout(() => { copy.textContent = '复制' }, 1200) }
    catch { err('浏览器不让写剪贴板，请手动选中复制：' + text) }
    return
  }
  const button = event.target.closest('[data-op]')
  if (!button) return
  err('')
  try {
    const op = button.dataset.op
    if (op === 'role-computer' || op === 'role-phone') {
      button.textContent = '正在切换…'
      await api({ op: 'role', role: op === 'role-phone' ? 'phone' : 'computer' })
      location.reload()
      return
    }
    if (op === 'port') {
      await api({ op: 'port', port: Number(document.getElementById('port').value) })
    } else if (op === 'lan-toggle') {
      await api({ op: 'lan-enabled' })
    } else if (op === 'rotate-pin-lan') {
      await api({ op: 'rotate-pin-lan' })
    } else if (op === 'rotate-pin-public') {
      await api({ op: 'rotate-pin-public' })
    } else if (op === 'pin') {
      const pin = document.getElementById('pin-new').value.trim()
      if (!pin) { err('先在这个框里填一个新密码'); return }
      await api({ op: 'pin', pin })
    } else if (op === 'pin-public') {
      const pin = document.getElementById('pin-public').value.trim()
      await api({ op: 'pin-public', pin })
    } else if (op === 'tunnel-quick') {
      await api({ op: 'tunnel-start', mode: 'quick' })
      button.textContent = '正在申请地址…'
      await pollTunnel()
      return
    } else if (op === 'tunnel-named') {
      const token = document.getElementById('tunnel-token').value.trim()
      const hostname = document.getElementById('tunnel-hostname').value.trim()
      await api({ op: 'tunnel-start', mode: 'named', token, hostname })
      button.textContent = '正在连接…'
      await pollTunnel()
      return
    } else if (op === 'tunnel-retry') {
      await api({ op: 'tunnel-start' })
      button.textContent = '正在申请地址…'
      await pollTunnel()
      return
    } else if (op === 'tunnel-install') {
      await api({ op: 'tunnel-install' })
      button.textContent = '正在下载…'
      await pollTunnel()
      return
    } else {
      await api({ op })
    }
    location.reload()
  } catch (error) { err(error.message) }
})
if (document.querySelector('[data-tunnel-starting]')) pollTunnel()
</script>`
  return pageShell('手机访问 · dsh-link', body)
}
