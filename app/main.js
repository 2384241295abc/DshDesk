'use strict'

// ============================================================================
// DeepSeek Harness 桌面壳 —— WebContentsView 架构
//
// 布局由桌面壳掌控(不是注入 web DOM):
//   ┌──────────────────────────────────────┐
//   │ 顶部导航栏(壳原生 UI: shell.html)      │  ← 页面切换/版本,永远固定
//   ├──────────────────────────────────────┤
//   │ WebContentsView(内容视图)             │  ← DSH / NapCat,随窗口缩放
//   └──────────────────────────────────────┘
//
// 皮肤接口: theme.js(桌面壳皮肤,与 web 无关)
// 页面接口: pages.js(registerPage 注册新页面)
// ============================================================================

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Notification } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')

const { readNapCatWebUIConfig } = require('./napcat-auth.js')
const { registerPage, listPages, getPage } = require('./pages.js')

const HARNESS_PORT = 3080
const BOOT_MARKER = '__DSH_BOOT__'
const START_TIMEOUT_MS = 120 * 1000
const IS_MAC = process.platform === 'darwin'
const NAV_H = 44   // 顶部导航栏高度(壳 UI)

let tray = null
let isQuitting = false

// 单实例：启动期间再双击不会拉起第二个后端，而是唤起已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showUi())
}

let uiWindow = null
let contentView = null
let splashWindow = null
let serverProcess = null
let stopRequested = false
let hideNotified = false
let currentPageId = 'main'

function appResourcesDir() {
  // macOS: 可执行文件在 Contents/MacOS，资源在同级的 Contents/Resources（大写 R）
  const exeDir = path.dirname(process.execPath)
  return process.platform === 'darwin'
    ? path.join(exeDir, '..', 'Resources')
    : path.join(exeDir, 'resources')
}
function nodeExe() {
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  return path.join(appResourcesDir(), 'node', name)
}
function harnessDir() { return path.join(appResourcesDir(), 'harness') }
function logFile() { return path.join(app.getPath('userData'), 'harness-server.log') }
function errFile() { return path.join(app.getPath('userData'), 'harness-server.err.log') }
function appIcon() {
  const exeDir = path.dirname(process.execPath)
  const dirs = process.platform === 'darwin'
    ? [path.join(exeDir, '..', 'Resources'), exeDir]
    : [exeDir]
  const names = process.platform === 'win32' ? ['app.ico']
    : process.platform === 'darwin' ? ['icon.icns', 'icon.png']
    : ['icon.png']
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

function probeServer() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: HARNESS_PORT, path: '/', timeout: 3000 },
      (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve(body.includes(BOOT_MARKER)))
        res.resume()
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// 端口是否被任意进程监听(区分「端口空闲」与「被残留进程占用」)
function portInUse() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: HARNESS_PORT })
    sock.setTimeout(1500)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
  })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function showError(msg) {
  console.error(msg)
  try {
    dialog.showErrorBox('DeepSeek Harness 启动失败', `${msg}\n\n日志文件：${errFile()}`)
  } catch { /* 对话框失败则忽略 */ }
}

async function startHarness() {
  // 端口上已有一个可用实例则直接复用
  if (await probeServer()) return true

  // 端口被占用但无 DSH 标记 → 残留进程占坑,给出明确指引
  if (await portInUse()) {
    showError(`端口 ${HARNESS_PORT} 已被其他进程占用且不是 DeepSeek Harness。\n\n这通常是上次退出未彻底(残留进程占住端口)所致。\n请先退出本应用,再在终端执行:\n  lsof -ti:${HARNESS_PORT} | xargs kill -9\n然后重新启动应用。`)
    return false
  }

  const node = nodeExe()
  const cwd = harnessDir()
  if (!fs.existsSync(node)) { showError(`Node 运行时缺失：${node}`); return false }
  if (!fs.existsSync(path.join(cwd, 'apps', 'cli', 'lib', 'bin.js'))) { showError(`harness 目录不完整：${cwd}`); return false }

  stopRequested = false
  fs.mkdirSync(path.dirname(logFile()), { recursive: true })
  const fdOut = fs.openSync(logFile(), 'a')
  const fdErr = fs.openSync(errFile(), 'a')
  fs.writeSync(fdOut, `\n===== ${new Date().toISOString()} DeepSeek Harness 启动 =====\n`)

  let child
  let spawnFailed = false
  try {
    child = spawn(node, ['apps/cli/lib/bin.js', 'web'], {
      cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true,
      detached: process.platform !== 'win32',
    })
  } catch (e) { showError(`无法启动进程：${String(e.message || e)}`); return false }
  serverProcess = child

  child.on('error', (e) => {
    spawnFailed = true
    if (!stopRequested) showError(`进程错误：${String(e.message || e)}`)
  })
  child.on('exit', (code) => {
    if (serverProcess === child) serverProcess = null
    if (!stopRequested) showError(`harness 进程退出（码 ${code ?? 'unknown'}），见日志`)
  })

  const deadline = Date.now() + START_TIMEOUT_MS
  while (true) {
    if (await probeServer()) return true
    if (stopRequested) return false
    if (spawnFailed) { showError('harness 进程启动失败（spawn error），见日志'); return false }
    if (child.exitCode !== null) { showError(`harness 启动失败（码 ${child.exitCode}），见日志`); return false }
    if (Date.now() > deadline) { showError(`启动超时（${START_TIMEOUT_MS / 1000}s），见日志`); return false }
    await delay(1000)
  }
}

function killGroup(pid, signal) {
  try { process.kill(-pid, signal) } catch { /* 进程可能已退出 */ }
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true } catch { return false }
}

// 停止 harness:先 SIGTERM 进程组,等待退出;未退出则 SIGKILL。返回 Promise。
function stopHarness() {
  stopRequested = true
  if (!serverProcess || !serverProcess.pid) return Promise.resolve()
  const pid = serverProcess.pid
  serverProcess = null
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        resolve()
        return
      }
      killGroup(pid, 'SIGTERM')
      const check = () => {
        if (!groupAlive(pid)) { resolve(); return }
        if (Date.now() < deadline) { setTimeout(check, 200); return }
        killGroup(pid, 'SIGKILL')
        const deadline2 = Date.now() + 1000
        const check2 = () => {
          if (!groupAlive(pid) || Date.now() >= deadline2) { resolve(); return }
          setTimeout(check2, 100)
        }
        check2()
      }
      const deadline = Date.now() + 5000
      check()
    } catch { resolve() }
  })
}

// MD3 风格启动加载页
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 400, height: 148,
    frame: false, transparent: true,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true,
    icon: appIcon(),
    webPreferences: { contextIsolation: true },
  })
  splashWindow.setAlwaysOnTop(true, 'screen-saver')
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'))
}
function splashDone() {
  if (splashWindow) {
    splashWindow.close()
    splashWindow = null
  }
}

// 系统托盘已移除(2026-08-19)：不再常驻菜单栏图标。
// 关闭窗口 → 隐藏(Dock 点击恢复,Cmd+Q / Dock 右键退出)。
// 若未来需要托盘常驻,在此恢复 createTray 即可。

app.on('activate', () => { showUi() })

function showUi() {
  if (!uiWindow) { openUi(); return }
  if (uiWindow.isMinimized()) uiWindow.restore()
  uiWindow.show()
  uiWindow.focus()
}

// ---------- 页面注册(见 pages.js) ----------
function registerBuiltinPages() {
  registerPage({
    id: 'main',
    label: '主界面',
    url: `http://127.0.0.1:${HARNESS_PORT}`,
  })
  registerPage({
    id: 'napcat',
    label: 'NapCat',
    url: () => {
      const cfg = readNapCatWebUIConfig()
      const port = cfg?.port || 6099
      const token = cfg?.token || ''
      // NapCat WebUI 原生登录:URL 带 ?token= 自动消费
      return token
        ? `http://127.0.0.1:${port}/webui?token=${encodeURIComponent(token)}`
        : `http://127.0.0.1:${port}/webui`
    },
    onEnter: (win) => {
      const cfg = readNapCatWebUIConfig()
      const port = cfg?.port || 6099
      try {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => res.resume())
        req.on('error', () => {})
        req.on('timeout', () => req.destroy())
      } catch { /* 仅探活 */ }
    },
  })
}
registerBuiltinPages()

function navigateTo(pageId, opts = {}) {
  const page = getPage(pageId)
  if (!page) { console.error(`navigate: 未知页面 ${pageId}`); return }
  if (!uiWindow) { openUi(); return }
  currentPageId = pageId
  const url = typeof page.url === 'function' ? page.url() : page.url
  if (contentView && contentView.webContents) {
    contentView.webContents.loadURL(url)
  }
  uiWindow.webContents.send('shell:active', pageId)
  if (!opts.silent) showUi()
}

// ---------- 主窗口 + 内容视图 ----------
function openUi() {
  const winOpts = IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } }
    : { frame: false }

  uiWindow = new BrowserWindow({
    width: 1280, height: 860,
    minWidth: 800, minHeight: 600,
    title: 'DeepSeek Harness',
    icon: appIcon(),
    ...winOpts,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 壳 UI:本地页面(顶部导航栏),不加载远端
  uiWindow.loadFile(path.join(__dirname, 'renderer', 'shell.html'))
  uiWindow.on('page-title-updated', (e) => e.preventDefault())
  uiWindow.on('closed', () => { uiWindow = null })

  uiWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      uiWindow.hide()
      if (!hideNotified) {
        hideNotified = true
        try {
          new Notification({ title: 'DeepSeek Harness 仍在运行', body: '窗口已最小化到系统托盘，右键托盘图标可退出应用。' }).show()
        } catch { /* 忽略 */ }
      }
    }
  })

  // 壳 UI 就绪:发布页面清单 + 创建内容视图
  uiWindow.webContents.on('did-finish-load', () => {
    const pages = listPages().map((p) => ({
      id: p.id, label: p.label,
    }))
    let version = '0.1.5'
    try { version = require('./package.json').version || version } catch { /* 忽略 */ }
    uiWindow.webContents.send('shell:pages', pages, currentPageId, version)

    createContentView()
    loadCurrentPage()
  })

  // 窗口缩放:内容视图跟随(顶部栏 NAV_H 始终保留)
  uiWindow.on('resize', () => {
    layoutContentView()
  })
}

function createContentView() {
  if (contentView) return
  contentView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  uiWindow.contentView.addChildView(contentView)

  // 内容视图内新窗口/外链处理
  contentView.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = [HARNESS_PORT, (readNapCatWebUIConfig()?.port) || 6099]
    const isLocal = allowed.some((p) => url.startsWith(`http://127.0.0.1:${p}`) || url.startsWith(`http://localhost:${p}`))
    if (isLocal) return { action: 'allow' }
    require('node:child_process').spawn(
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open',
      process.platform === 'win32' ? ['/c', 'start', '', url] : [url],
      { detached: true, stdio: 'ignore' },
    ).unref()
    return { action: 'deny' }
  })

  layoutContentView()
}

function layoutContentView() {
  if (!contentView || !uiWindow) return
  const [w, h] = uiWindow.getContentSize()
  contentView.setBounds({ x: 0, y: NAV_H, width: w, height: Math.max(0, h - NAV_H) })
}

function loadCurrentPage() {
  const page = getPage(currentPageId)
  if (!page || !contentView) return
  const url = typeof page.url === 'function' ? page.url() : page.url
  contentView.webContents.loadURL(url)
  if (page.onEnter) page.onEnter(uiWindow)
}

// ---------- IPC ----------
ipcMain.on('win:navigate', (_e, pageId) => {
  navigateTo(String(pageId), { silent: true })
})
// 非 macOS：壳 UI 自绘窗口按钮（macOS 走原生交通灯,无需这些）
ipcMain.on('win:minimize', () => { uiWindow?.minimize() })
ipcMain.on('win:maximize', () => {
  if (!uiWindow) return
  uiWindow.isMaximized() ? uiWindow.unmaximize() : uiWindow.maximize()
})
ipcMain.on('win:close', () => { uiWindow?.close() })
ipcMain.handle('win:isMaximized', () => uiWindow?.isMaximized() ?? false)

app.whenReady().then(async () => {
  createTray()
  createSplash()
  const ok = await startHarness()
  splashDone()
  if (ok) openUi()
  else app.quit()
})

// 窗口关闭到托盘后不退出；仅真正退出时才停服
app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})

// before-quit:置 isQuitting + await 清理 harness 进程组,再真正退出
let quitCleanupStarted = false
app.on('before-quit', (e) => {
  isQuitting = true
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  e.preventDefault()
  stopHarness().then(() => app.quit())
})
