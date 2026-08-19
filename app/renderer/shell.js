'use strict'

// ============================================================================
// 桌面壳 UI —— 模块化布局引擎
//
// 任务区模块(为自定义布局做准备):
//   topbar     顶部导航栏(标题 + 页面切换 + 设置 + 窗口按钮)
//   nav-slot   页面切换按钮区(shell.js 渲染)
//   settings   设置面板(皮肤切换)
//   win-controls 窗口控制(非 macOS)
//   content    内容视图区(WebContentsView 挂载点,由主进程控制 bounds)
//
// 布局配置(未来自定义布局入口):LAYOUT 对象集中描述各模块位置/显隐,
// 后续可做成用户可编辑的布局方案。
// ============================================================================

// 布局配置:模块 -> { show, order }(order 决定 topbar 内顺序,未来可扩展为拖拽排序)
const LAYOUT = {
  topbar: { show: true },
  nav: { show: true, order: 1 },
  settings: { show: true, order: 2 },
  winControls: { show: true },   // 非 macOS 才真正显示
}

let PAGES = []
let ACTIVE = 'main'

// 当前 iframe URL 解析(页面 url 可能由主进程提供,此处按页面 id 加载)
function loadPageIntoFrame(pageId) {
  const frame = document.getElementById('app-frame')
  if (!frame) return
  // 页面 URL 由主进程经 shell:pages 提供(url 函数在主进程),此处用固定映射或由主进程推送
  // 简化:壳请求主进程给 URL → 主进程回发;或主进程直接把当前页 URL 发来
  if (window.dshShell?.getPageUrl) {
    window.dshShell.getPageUrl(pageId)
  }
}
// 主进程推送页面 URL 后,设 iframe.src
function setFrameUrl(url) {
  const frame = document.getElementById('app-frame')
  if (frame && url) {
    frame.onload = () => { if (window.dshShell?.notifyFrameLoaded) window.dshShell.notifyFrameLoaded() }
    frame.src = url
  }
}

// ---------- 模块:nav(页面切换按钮,仅进入后显示) ----------
function renderNav() {
  const slot = document.getElementById('nav-slot')
  if (!slot) return
  const entered = document.body.classList.contains('entered')
  slot.innerHTML = ''
  if (!entered) return   // 启动页阶段不显示导航
  PAGES.forEach((p) => {
    const btn = document.createElement('button')
    btn.className = 'nav-btn' + (p.id === ACTIVE ? ' active' : '')
    btn.dataset.page = p.id
    btn.appendChild(document.createTextNode(p.label))
    btn.addEventListener('click', () => {
      if (window.dshShell?.navigate) window.dshShell.navigate(p.id)
    })
    slot.appendChild(btn)
  })
}

// ---------- 模块:win-controls(窗口按钮,非 macOS) ----------
function initWinControls() {
  const isMac = /Mac/i.test(navigator.platform)
  if (isMac) return
  document.body.classList.add('win')
  const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', () => window.dshShell?.[fn]?.())
  bind('wc-min', 'minimize')
  bind('wc-max', 'maximize')
  bind('wc-close', 'close')
}

// ---------- 模块:launcher(启动页交互) ----------
function setStatus(text) {
  const el = document.getElementById('launcher-status')
  if (el) el.textContent = text || ''
}
function setProgress(percent) {
  const bar = document.getElementById('launcher-progress')
  const fill = bar?.querySelector('i')
  if (bar) bar.classList.add('visible')
  if (fill) fill.style.width = (percent || 0) + '%'
}
function initLauncher() {
  const btnUpdate = document.getElementById('btn-update')
  const btnEnter = document.getElementById('btn-enter')
  btnUpdate?.addEventListener('click', () => {
    if (window.dshShell?.checkUpdate) {
      btnUpdate.disabled = true
      setStatus('正在检查更新…')
      window.dshShell.checkUpdate()
    }
  })
  btnEnter?.addEventListener('click', () => {
    if (window.dshShell?.enterApp) window.dshShell.enterApp()
  })
}

// ---------- 模块:balance-view(DeepSeek 额度,壳内视图) ----------
function setBalanceStatus(text) {
  const el = document.getElementById('bv-status')
  if (el) el.textContent = text || ''
}
function setBalanceLoading(on) {
  const view = document.getElementById('balance-view')
  if (view) view.classList.toggle('bv-loading', !!on)
}
async function refreshBalance() {
  setBalanceLoading(true)
  setBalanceStatus('查询中…')
  try {
    const res = await window.dshShell?.getBalance()
    if (!res || !res.ok) {
      setBalanceStatus(res?.error || '查询失败')
      setBalanceLoading(false)
      return
    }
    const data = res.data || {}
    const info = (data.balance_infos || [])[0] || {}
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v }
    set('bv-total', info.total_balance != null ? info.total_balance : '--')
    set('bv-currency', info.currency || 'CNY')
    set('bv-granted', info.granted_balance != null ? info.granted_balance : '--')
    set('bv-topped', info.topped_up_balance != null ? info.topped_up_balance : '--')
    const avail = document.getElementById('bv-available')
    if (avail) {
      const ok = data.is_available === true
      avail.textContent = ok ? '可用' : '不可用'
      avail.className = 'v ' + (ok ? 'ok' : 'bad')
    }
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setBalanceStatus(`更新于 ${t}`)
  } catch (e) {
    setBalanceStatus('查询失败: ' + String(e?.message || e))
  }
  setBalanceLoading(false)
}
function initBalanceView() {
  document.getElementById('bv-refresh')?.addEventListener('click', refreshBalance)
  document.getElementById('bv-recharge')?.addEventListener('click', () => {
    if (window.dshShell?.openRecharge) window.dshShell.openRecharge()
  })
}

// ---------- 模块初始化 ----------
function init() {
  // 设置按钮:点击 → 主进程弹原生皮肤菜单(原生菜单不被 WebContentsView 遮挡)
  const gear = document.getElementById('settings-btn')
  gear?.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (window.dshShell?.openSkinMenu) window.dshShell.openSkinMenu()
  })
  renderNav()
  initWinControls()
  initLauncher()
  initBalanceView()
}

// ---------- 启动页状态(主进程推送) ----------
if (window.dshShell?.onUpdateStatus) {
  window.dshShell.onUpdateStatus((state) => {
    // state: { phase:'checking'|'found'|'uptodate'|'downloading'|'installing'|'done'|'error', text?, percent? }
    const btn = document.getElementById('btn-update')
    if (!state) return
    setStatus(state.text || '')
    if (typeof state.percent === 'number') setProgress(state.percent)
    if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing') {
      if (btn) btn.disabled = true
    } else if (state.phase === 'error' || state.phase === 'uptodate' || state.phase === 'done') {
      if (btn) btn.disabled = false
    }
    if (state.phase === 'done' && btn) {
      btn.textContent = '已是最新'
      btn.disabled = true
    }
  })
}

// ---------- 主进程事件 ----------
// 应用皮肤:颜色(CSS 变量) + 图片(logo/背景)
function applySkinAssets(colors, images) {
  const root = document.documentElement
  Object.entries(colors || {}).forEach(([k, v]) => root.style.setProperty(k, v))
  // 图片:启动页背景(launcherBg)
  if (images && images.launcherBg) {
    const launcher = document.getElementById('launcher')
    if (launcher) {
      launcher.style.backgroundImage = `url("${images.launcherBg}")`
      launcher.style.backgroundSize = 'cover'
      launcher.style.backgroundPosition = 'center'
    }
  }
  // 图片:工作台背景(appBg)→ 铺到 iframe 容器,iframe 透明露出
  if (images && images.appBg) {
    const wrap = document.getElementById('app-frame-wrap')
    if (wrap) {
      wrap.style.backgroundImage = `url("${images.appBg}")`
      wrap.style.backgroundSize = 'cover'
      wrap.style.backgroundPosition = 'center'
      wrap.style.backgroundRepeat = 'no-repeat'
    }
    const frame = document.getElementById('app-frame')
    if (frame) frame.style.background = 'transparent'
  } else {
    const wrap = document.getElementById('app-frame-wrap')
    if (wrap) wrap.style.backgroundImage = ''
    const frame = document.getElementById('app-frame')
    if (frame) frame.style.background = ''
  }
}
if (window.dshShell?.onTheme) {
  window.dshShell.onTheme((vars) => {
    applySkinAssets(vars)
  })
}
if (window.dshShell?.onSkins) {
  window.dshShell.onSkins((skins, current) => {
    const s = (skins || []).find((x) => x.name === current)
    if (s) applySkinAssets(s.colors, s.images)
  })
}
if (window.dshShell?.onPages) {
  window.dshShell.onPages((pages, active, version) => {
    PAGES = pages
    ACTIVE = active
    window.__DSH_VERSION__ = version
    renderNav()
  })
}
if (window.dshShell?.onActive) {
  window.dshShell.onActive((pageId) => {
    ACTIVE = pageId
    renderNav()
    if (document.body.classList.contains('entered')) switchPage(pageId)
  })
}

// ---------- 视图切换(启动页 ⇄ 工作台,完全切换,互不残留) ----------
function showLauncher() {
  // 卸载工作台
  const frame = document.getElementById('app-frame')
  if (frame) frame.src = 'about:blank'
  const appView = document.getElementById('app-view')
  if (appView) appView.style.display = 'none'
  const balView = document.getElementById('balance-view')
  if (balView) balView.style.display = 'none'
  const launcher = document.getElementById('launcher')
  if (launcher) launcher.style.display = 'flex'
  document.body.classList.remove('entered')
  renderNav()   // 清空导航(启动页不显示导航)
}
function showWorkspace() {
  const launcher = document.getElementById('launcher')
  if (launcher) launcher.style.display = 'none'
  document.body.classList.add('entered')
  renderNav()
  switchPage(ACTIVE)   // 显示当前页(iframe 或壳内视图)
}

// 按页面 id 切换工作台内容:壳内视图(balance)显示对应视图,其余加载 iframe
function switchPage(pageId) {
  const isShellView = pageId === 'balance'
  const appView = document.getElementById('app-view')
  const balView = document.getElementById('balance-view')
  if (isShellView) {
    if (appView) appView.style.display = 'none'
    if (balView) {
      balView.style.display = 'flex'
      refreshBalance()   // 进入额度页即查一次余额
    }
  } else {
    if (balView) balView.style.display = 'none'
    if (appView) appView.style.display = 'flex'
    if (window.dshShell?.getPageUrl) window.dshShell.getPageUrl(pageId)
  }
}

// 已进入应用:切换工作台视图
if (window.dshShell?.onEntered) {
  window.dshShell.onEntered(() => showWorkspace())
}
// 返回启动页
if (window.dshShell?.onReturnLauncher) {
  window.dshShell.onReturnLauncher(() => showLauncher())
}

// 主进程回发页面 URL → 设 iframe.src
if (window.dshShell?.onPageUrl) {
  window.dshShell.onPageUrl((pageId, url) => {
    ACTIVE = pageId
    // 壳内视图(balance)无 url,仅切换显示
    if (pageId === 'balance') { switchPage(pageId); renderNav(); return }
    setFrameUrl(url)
    renderNav()
  })
}

init()
