'use strict'

// 桌面壳 UI 逻辑：构建顶部导航栏按钮,点击通过 IPC 通知主进程切换页面
// 页面清单由主进程经 shell-preload 推送,此处仅渲染。

let PAGES = []
let ACTIVE = 'main'

function buildTopbar() {
  const bar = document.getElementById('topbar')
  if (!bar) return
  bar.innerHTML = ''

  const title = document.createElement('span')
  title.className = 'app-title'
  title.textContent = 'DeepSeek Harness'
  bar.appendChild(title)

  PAGES.forEach((p) => {
    const btn = document.createElement('button')
    btn.className = 'nav-btn' + (p.id === ACTIVE ? ' active' : '')
    btn.dataset.page = p.id
    btn.appendChild(document.createTextNode(p.label))
    btn.addEventListener('click', () => {
      if (window.dshShell?.navigate) window.dshShell.navigate(p.id)
    })
    bar.appendChild(btn)
  })

  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  bar.appendChild(spacer)
  const ver = document.createElement('span')
  ver.className = 'version'
  ver.textContent = 'v' + (window.__DSH_VERSION__ || '')
  bar.appendChild(ver)
}

// 主进程推送页面清单
if (window.dshShell?.onPages) {
  window.dshShell.onPages((pages, active, version) => {
    PAGES = pages
    ACTIVE = active
    window.__DSH_VERSION__ = version
    buildTopbar()
  })
}
if (window.dshShell?.onActive) {
  window.dshShell.onActive((pageId) => {
    ACTIVE = pageId
    buildTopbar()
  })
}

// 平台检测：非 macOS 显示自绘窗口按钮(macOS 用原生交通灯)
// macOS 是 titleBarStyle hiddenInset → navigator.platform 为 'MacIntel'
const isMac = /Mac/i.test(navigator.platform)
if (!isMac) {
  document.body.classList.add('win')
  const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', () => window.dshShell?.[fn]?.())
  bind('wc-min', 'minimize')
  bind('wc-max', 'maximize')
  bind('wc-close', 'close')
}
