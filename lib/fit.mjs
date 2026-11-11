/**
 * 竖屏适配脚本：注入到转发出去的 HTML 里（不是注入到 dsh 本身）。
 *
 * 问题：dsh 的桌面外壳是个 grid，窄屏时列宽算成 `390px 0 0`，主内容列变成 0 宽、
 * 还被推到 x=390（屏幕右边外面），所以手机竖屏看到的是一片空白——侧边栏反而能拉出来。
 *
 * 做法：只改一件事——把外壳的列宽强制成 `0 / 1fr / 0`，让主内容列占满屏宽。
 * 侧边栏的抽屉、遮罩、打开按钮全都还用 dsh 自己的（dsh 本来就有"打开侧边栏"按钮，
 * 只是主列 0 宽时它也被挤到屏幕外了）。
 *
 * 只在"确实坏了"的时候生效：主内容列宽度 < 40 或整列被推出视口右侧，且视口 ≤ 900。
 * 平板/横屏/桌面宽度一律不碰。
 */
export const FIT_SCRIPT = `;(function () {
  if (window.__dshLinkFit) return
  window.__dshLinkFit = true
  var NARROW_MAX = 900
  var STYLE_ID = '__dshLinkFitStyle'
  var CSS = 'html[data-dsh-link-fit] [class*="_frame"]{grid-template-columns:0 minmax(0,1fr) 0!important}'

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  function centerCol() {
    return document.querySelector('[class*="_centerCol"]')
  }

  function check() {
    ensureStyle()
    if (forced === 'desktop') return
    var center = centerCol()
    if (!center) return
    var on = document.documentElement.getAttribute('data-dsh-link-fit') === '1'
    var narrow = window.innerWidth <= NARROW_MAX

    // 关键：只在"没开适配"的时候量。开了之后主内容列本来就该是满宽，
    // 再拿量到的宽度反推"已经不坏了"就会自己把自己关掉，来回抖。
    if (!narrow) {
      if (on) document.documentElement.removeAttribute('data-dsh-link-fit')
      return
    }
    if (on) return
    var box = center.getBoundingClientRect()
    var broken = box.width < 40 || box.left >= window.innerWidth - 2
    if (!broken) return
    document.documentElement.setAttribute('data-dsh-link-fit', '1')
    try {
      console.debug('[dsh-link] 竖屏适配已开', Math.round(box.width), Math.round(box.left), window.innerWidth)
    } catch (error) {}
  }

  // 留一个手动入口：页面上想临时看看到底该怎么改时，控制台敲 __dshLinkFitCheck()
  window.__dshLinkFitCheck = check

  // 手机那边面板顶部的「布局 / 缩放 / 侧边栏」按钮走的是同一套 postMessage 协议：
  // 以前由手机端注入的 fit.js 处理，现在由这段脚本接管，省得两层注入打架。
  var forced = 'auto'
  window.addEventListener('message', function (event) {
    var data = event && event.data
    if (!data || data.source !== 'dsh-pocket-remote') return
    if (data.type === 'set-layout') {
      forced = String(data.value) === 'desktop' ? 'desktop' : 'auto'
      if (forced === 'desktop') document.documentElement.removeAttribute('data-dsh-link-fit')
      else check()
    }
    if (data.type === 'set-zoom') {
      document.documentElement.style.zoom = String(data.value) === '1' ? '' : String(data.value)
    }
    if (data.type === 'toggle-sidebar') {
      var button = document.querySelector('button[aria-label="打开侧边栏"], button[aria-label="关闭侧边栏"]')
      if (button) button.click()
    }
  })

  function boot() {
    check()
    // 应用是异步渲染的，隔几拍再校几次
    setTimeout(check, 200)
    setTimeout(check, 700)
    setTimeout(check, 1500)
    setTimeout(check, 3000)
    setInterval(check, 1200)
  }

  window.addEventListener('resize', check)
  window.addEventListener('orientationchange', function () { setTimeout(check, 300) })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()`
