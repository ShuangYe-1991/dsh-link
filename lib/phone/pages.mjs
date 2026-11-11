/**
 * 手机端的两个页面：连接管理、扫码添加。
 * 只在本机回环上出现（由手机 DSH 的面板 iframe 打开）。
 */
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const BASE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px 16px 48px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 22px 0 10px; opacity: .85; }
.sub { font-size: 13px; opacity: .66; margin: 0 0 18px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; padding: 12px 14px; border: 1px solid rgba(127,127,127,.28); border-radius: 12px; margin-bottom: 10px; }
li.active { border-color: rgba(127,127,127,.6); }
.meta { min-width: 0; }
.url { font-size: 12px; opacity: .6; word-break: break-all; }
.tag { display: inline-block; margin-left: 8px; font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid rgba(127,127,127,.4); opacity: .8; }
.ops { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
button { font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 9px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
button.primary { width: 100%; padding: 11px; font-size: 15px; margin-top: 16px; border-radius: 10px; }
input { width: 100%; font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid rgba(127,127,127,.35); border-radius: 10px; background: transparent; color: inherit; }
label { display: block; font-size: 12.5px; opacity: .66; margin: 12px 0 5px; }
.hint { font-size: 12.5px; opacity: .62; margin-top: 8px; }
.err { font-size: 13px; color: #c0392b; margin-top: 10px; min-height: 18px; }
a.back { display: inline-block; margin-bottom: 10px; font-size: 13px; text-decoration: none; opacity: .7; color: inherit; }
.scan { display: block; padding: 13px 15px; border: 1px solid rgba(127,127,127,.35); border-radius: 12px; text-decoration: none; color: inherit; font-size: 14px; margin: 6px 0 18px; }
.stage { position: relative; width: 100%; border-radius: 14px; overflow: hidden; border: 1px solid rgba(127,127,127,.3); min-height: 180px; display: flex; align-items: center; justify-content: center; }
video { width: 100%; display: block; }
.ph { padding: 22px 14px; text-align: center; font-size: 13px; opacity: .65; }
.row { display: flex; gap: 10px; margin-top: 10px; }
.row button { flex: 1 1 0; padding: 12px; font-size: 14.5px; border-radius: 11px; }
`

const shell = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head><body>${body}</body></html>`

export function renderPhoneManage(state, port) {
  const rows = (state.connections ?? [])
    .map((conn) => {
      const active = conn.id === state.activeId
      return `<li data-id="${escapeHtml(conn.id)}" class="${active ? 'active' : ''}">
  <div class="meta"><strong>${escapeHtml(conn.label || '未命名电脑')}</strong>${active ? '<span class="tag">正在用</span>' : ''}
    <div class="url">${escapeHtml(conn.url)}</div>
    ${conn.lanUrl && conn.lanUrl !== conn.url ? `<div class="url">局域网：${escapeHtml(conn.lanUrl)}</div>` : ''}
  </div>
  <div class="ops">
    ${active ? '' : '<button data-op="select">切换</button>'}
    <button data-op="update">更新地址</button>
    <button data-op="rename">改名</button>
    <button data-op="delete">删除</button>
  </div>
</li>`
    })
    .join('')

  return shell(
    '电脑 DSH · 连接管理',
    `<h1>电脑 DSH</h1>
<p class="sub">手机通过这里连电脑上的 DSH。地址取电脑上 dsh-link 状态页给的链接，密码也是那里显示的。</p>

<h2>已保存的电脑</h2>
<ul id="list">${rows || '<li><div class="meta">还没有保存任何电脑</div></li>'}</ul>

<a class="scan" href="/__ctl/scan">📷 扫码添加（扫电脑上的二维码）→</a>

<h2>添加一台电脑</h2>
<label for="label">名字（例如：家里电脑）</label>
<input id="label" placeholder="家里电脑">
<label for="url">地址</label>
<input id="url" placeholder="http://192.168.1.5:3199 或 https://xxx.trycloudflare.com" autocapitalize="none" spellcheck="false">
<label for="pin">访问密码</label>
<input id="pin" type="password" autocomplete="off" placeholder="输入密码">
<div class="hint">更新旧连接时密码留空就沿用原来的。</div>
<button class="primary" id="add">保存并连接</button>
<div class="err" id="err"></div>

<h2>地址自动更新</h2>
<p class="hint" style="margin-top:0">公网地址变了以后，如果手机和电脑在同一个 WiFi，点下面这个按钮就从局域网问一次新地址，不用手贴。</p>
<button data-op="refresh">自动找新地址</button>
<div class="hint">本机代理端口：${escapeHtml(String(port ?? '—'))}</div>

<script>
const $ = (id) => document.getElementById(id)
const err = (text) => { $('err').textContent = text || '' }
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status))
  return json
}
$('add').addEventListener('click', async () => {
  err('')
  try {
    const id = window.__editingId
    const body = { label: $('label').value.trim(), url: $('url').value.trim(), pin: $('pin').value.trim() }
    const result = id ? await post('/__ctl/update', { ...body, id }) : await post('/__ctl/save', body)
    if (result.verified === false) { err('地址已保存，但试连没通过：' + (result.reason === 'locked' ? '电脑那边锁定中' : '密码或地址不对')); return }
    location.replace('/')
  } catch (error) { err(error.message) }
})
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-op]')
  if (!button) return
  const op = button.dataset.op
  err('')
  try {
    if (op === 'refresh') {
      const result = await post('/__ctl/refresh', {})
      err(result.changed ? '拿到新地址了，已自动替换' : '地址没变，或者现在问不到（可能不在同一个 WiFi）')
      return
    }
    const li = button.closest('li')
    const id = li.dataset.id
    if (op === 'select') { await post('/__ctl/select', { id }); location.replace('/'); return }
    if (op === 'update') {
      $('url').value = li.querySelector('.url').textContent.trim()
      $('label').value = li.querySelector('strong').textContent.trim()
      $('pin').value = ''
      $('url').scrollIntoView({ behavior: 'smooth', block: 'center' })
      window.__editingId = id
      return
    }
    if (op === 'delete') { await post('/__ctl/delete', { id }); location.reload(); return }
    if (op === 'rename') {
      const next = window.prompt('新的名字', li.querySelector('strong').textContent.trim())
      if (next === null) return
      await post('/__ctl/rename', { id, label: next.trim() })
      location.reload()
    }
  } catch (error) { err(error.message) }
})
</script>`,
  )
}

export function renderPhoneScan() {
  return shell(
    '电脑 DSH · 扫码',
    `<a class="back" href="/__ctl/ui">← 手动填写</a>
<h1>扫电脑上的二维码</h1>
<p class="sub">电脑上打开 <code>127.0.0.1:3199/__link/ui</code>，二维码就在页面上。</p>
<p style="font-size:12px;line-height:1.55;color:#c0392b;margin:0 0 10px">
  部分手机版 DSH 可能拿不到相机权限，页面内的实时扫码可能用不了。请用下面的「拍照扫码」或「从相册选」识别二维码图片；
  也可以直接在电脑上复制地址，回到「手动填写」粘贴。
</p>
<div class="stage" id="stage"><div class="ph" id="ph">用下面的按钮拍照 / 选图，或者直接粘贴链接</div></div>
<div class="row"><button id="shoot">拍照扫码</button><button id="pick">从相册选</button></div>
<div class="row"><button id="livecam" style="opacity:.75">页面内实时扫码（可能被权限拦）</button></div>
<div class="row"><button id="paste">粘贴链接</button></div>

<div id="confirm" style="display:none;margin-top:14px;padding:12px;border:1px solid rgba(127,127,127,.35);border-radius:12px">
  <div style="font-weight:600;font-size:14px;margin-bottom:8px">确认这台电脑</div>
  <div style="font-size:12px;opacity:.65;margin-bottom:6px">扫到的地址（可以改）</div>
  <input id="scan-url" placeholder="http://192.168.1.5:3199" autocapitalize="none" spellcheck="false">
  <div style="font-size:12px;opacity:.65;margin:10px 0 6px">名字（随便起）</div>
  <input id="scan-label" placeholder="家里电脑">
  <div style="font-size:12px;opacity:.65;margin:10px 0 6px">访问密码（电脑上 dsh-link 页面显示的）</div>
  <input id="scan-pin" type="password" autocomplete="off" placeholder="输入密码">
  <button class="primary" id="scan-save" style="margin-top:12px;width:100%">添加并连接</button>
  <div style="font-size:12px;opacity:.6;margin-top:8px">没填密码的话是连不上的，这一步必须要填。</div>
</div>

<div class="err" id="err"></div>
<input id="cam" type="file" accept="image/*" capture="camera" hidden>
<input id="gal" type="file" accept="image/*" hidden>
<script src="/__ctl/jsqr.js"></script>
<script>
const err = (text) => { document.getElementById('err').textContent = text || '' }
const cvs = document.createElement('canvas')
const cx = cvs.getContext('2d', { willReadFrequently: true })

// 扫码只负责把地址填进来；名字和密码要用户自己确认，不能直接当"已配置好"
function done(text) {
  const url = String(text || '').trim()
  if (!/^https?:\\/\\//i.test(url)) { err('扫到的不是链接：' + url.slice(0, 40)); return }
  err('')
  document.getElementById('scan-url').value = url
  document.getElementById('scan-label').value = document.getElementById('scan-label').value || url.replace(/^https?:\\/\\//, '').split('/')[0]
  document.getElementById('confirm').style.display = 'block'
  document.getElementById('scan-pin').focus()
  document.getElementById('confirm').scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function submitScan() {
  const url = document.getElementById('scan-url').value.trim()
  const label = document.getElementById('scan-label').value.trim()
  const pin = document.getElementById('scan-pin').value.trim()
  if (!url) { err('地址不能为空'); return }
  if (!pin) { err('还要填访问密码，不然连不上'); return }
  fetch('/__ctl/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, label, pin }) })
    .then((r) => r.json())
    .then((j) => {
      if (j && j.ok) {
        if (j.verified === false) { err('地址存下了，但试连没通过：密码或地址不对'); return }
        // 嵌入式（插件面板里打开的）就通知父窗口，别把 iframe 自己跳到代理首页
        if (window.parent && window.parent !== window) {
          try { window.parent.postMessage({ source: 'dsh-link', type: 'scan-saved' }, '*'); return } catch (e) {}
        }
        location.replace('/')
      } else err('保存失败：' + ((j && j.error) || '未知'))
    })
    .catch((e) => err('保存失败：' + e.message))
}
document.addEventListener('click', (event) => {
  if (event.target && event.target.id === 'scan-save') submitScan()
})
function decodeImage(image) {
  if (typeof jsQR !== 'function') { err('二维码库没加载出来'); return }
  const W = image.naturalWidth || image.width
  const H = image.naturalHeight || image.height
  for (const scale of [0.5, 0.35, 0.75, 1]) {
    for (const threshold of [null, 140, 175]) {
      const w = Math.max(1, Math.round(W * scale))
      const h = Math.max(1, Math.round(H * scale))
      cvs.width = w; cvs.height = h
      cx.drawImage(image, 0, 0, w, h)
      const data = cx.getImageData(0, 0, w, h)
      if (threshold !== null) {
        const d = data.data
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          const v = gray > threshold ? 255 : 0
          d[i] = v; d[i + 1] = v; d[i + 2] = v
        }
      }
      const code = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' })
      if (code && code.data) { done(code.data); return }
    }
  }
  err('这张图里没找到二维码，让二维码占满取景框、别反光')
}
function loadPicked(file) {
  if (!file) return
  const img = new Image()
  const url = URL.createObjectURL(file)
  img.onload = () => { decodeImage(img); URL.revokeObjectURL(url) }
  img.onerror = () => { err('图片读不出来'); URL.revokeObjectURL(url) }
  img.src = url
}
var camStream = null, camRaf = 0
function stopCamera() {
  if (camRaf) { cancelAnimationFrame(camRaf); camRaf = 0 }
  if (camStream) {
    camStream.getTracks().forEach(function (t) { try { t.stop() } catch (e) {} })
    camStream = null
  }
  var v = document.getElementById('camvideo')
  if (v) v.remove()
  var ph = document.getElementById('ph')
  if (ph) ph.style.display = ''
}
function startCamera() {
  err('')
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err('这个界面拿不到摄像头，改用「从相册选」或给相机权限后重试')
    document.getElementById('cam').click()
    return
  }
  var stage = document.getElementById('stage')
  var ph = document.getElementById('ph')
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } })
    .then(function (stream) {
      camStream = stream
      if (ph) ph.style.display = 'none'
      var video = document.createElement('video')
      video.id = 'camvideo'
      video.setAttribute('playsinline', 'true')
      video.muted = true
      video.autoplay = true
      video.style.width = '100%'
      video.style.display = 'block'
      stage.appendChild(video)
      video.srcObject = stream
      return video.play()
    })
    .then(function () {
      var video = document.getElementById('camvideo')
      var loop = function () {
        if (!camStream) return
        if (video.readyState === 4 && video.videoWidth) {
          var w = Math.round(video.videoWidth * 0.6)
          var h = Math.round(video.videoHeight * 0.6)
          cvs.width = w; cvs.height = h
          cx.drawImage(video, 0, 0, w, h)
          var data = cx.getImageData(0, 0, w, h)
          var code = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' })
          if (code && code.data) { stopCamera(); done(code.data); return }
        }
        camRaf = requestAnimationFrame(loop)
      }
      camRaf = requestAnimationFrame(loop)
    })
    .catch(function (e) {
      var name = (e && e.name) || '被拒绝'
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        err('App 没给相机权限，已替你打开拍照选择器；不行就用「从相册选」')
        stopCamera()
        try { document.getElementById('cam').click() } catch (e2) {}
      } else {
        err('摄像头打不开（' + name + '），可以从相册选一张带二维码的图')
        stopCamera()
      }
    })
}

// 默认走系统相机/相册选择器：立即有反应，不依赖 App 给 WebView 的相机权限
document.getElementById('shoot').addEventListener('click', function () {
  err('')
  try { document.getElementById('cam').click() } catch (e) { err('系统相机打不开，用「从相册选」') }
})
var liveBtn = document.getElementById('livecam')
if (liveBtn) liveBtn.addEventListener('click', startCamera)
document.getElementById('pick').addEventListener('click', () => document.getElementById('gal').click())
document.getElementById('cam').addEventListener('change', (e) => loadPicked(e.target.files && e.target.files[0]))
document.getElementById('gal').addEventListener('change', (e) => loadPicked(e.target.files && e.target.files[0]))
document.getElementById('paste').addEventListener('click', () => {
  err('')
  if (!navigator.clipboard || !navigator.clipboard.readText) { err('这个界面不让读剪贴板，回到「手动填写」长按粘贴'); return }
  navigator.clipboard.readText()
    .then((text) => { if (/^https?:\\/\\//i.test(String(text).trim())) done(text); else err('剪贴板里没有链接') })
    .catch(() => err('读剪贴板被拒绝，回到「手动填写」长按粘贴'))
})
</script>`,
  )
}
