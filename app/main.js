'use strict'

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')

const HARNESS_PORT = 3080
const BOOT_MARKER = '__DSH_BOOT__'
const START_TIMEOUT_MS = 120 * 1000
const IS_MAC = process.platform === 'darwin'

let tray = null
let isQuitting = false

// 单实例：启动期间再双击不会拉起第二个后端，而是唤起已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showUi())
}

let uiWindow = null
let splashWindow = null
let serverProcess = null
let stopRequested = false
let hideNotified = false   // 首次隐藏到托盘是否已提示过

function appResourcesDir() {
  // macOS: 可执行文件在 Contents/MacOS，资源在同级的 Contents/Resources（大写 R，注意大小写！）
  // Windows/Linux: 资源与可执行文件同级 resources/
  const exeDir = path.dirname(process.execPath)
  return process.platform === 'darwin'
    ? path.join(exeDir, '..', 'Resources')
    : path.join(exeDir, 'resources')
}
function nodeExe() {
  // Windows 内置 node.exe，macOS/Linux 为无扩展名可执行文件
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  return path.join(appResourcesDir(), 'node', name)
}
function harnessDir() { return path.join(appResourcesDir(), 'harness') }
function logFile() { return path.join(app.getPath('userData'), 'harness-server.log') }
function errFile() { return path.join(app.getPath('userData'), 'harness-server.err.log') }
function appIcon() {
  const exeDir = path.dirname(process.execPath)
  // macOS: 可执行文件在 Contents/MacOS，图标资源在 Contents/Resources
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

// 端口是否被任意进程监听(无论是否为 DSH);用于区分「端口空闲」与「被残留进程占用」
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

  // 端口被占用但响应中无 DSH 标记 → 残留进程占坑(常见于上次未彻底退出)
  // 此时 spawn 新实例必然因端口冲突失败,直接给出明确指引
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
  // 用 openSync 立即拿到文件描述符，spawn 的 stdio 才能使用
  const fdOut = fs.openSync(logFile(), 'a')
  const fdErr = fs.openSync(errFile(), 'a')
  fs.writeSync(fdOut, `\n===== ${new Date().toISOString()} DeepSeek Harness 启动 =====\n`)

  let child
  let spawnFailed = false
  try {
    child = spawn(node, ['apps/cli/lib/bin.js', 'web'], {
      cwd, stdio: ['ignore', fdOut, fdErr], windowsHide: true,
      // POSIX: 独立进程组，便于整体终止（含孙进程）
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

// 停止 harness:先 SIGTERM 整个进程组,等待退出;未退出则 SIGKILL。
// 返回 Promise,resolve 时进程组已确认退出(或已发 SIGKILL)。
// ⚠️ 调用方必须 await 完成后再退出应用:
// Electron 主进程一旦真正开始退出,事件循环中的 setTimeout 回调不再执行,
// 若 SIGKILL 兜底是 fire-and-forget 的异步定时器,进程退出后兜底永不触发 → 残留进程占住 3080。
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
      // 最多等 5 秒:每 200ms 检查进程组是否退出,超时 SIGKILL 后再等 1 秒
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

// MD3 风格启动加载页：圆角卡片 + 左上角 logo + 底部滚动进度条
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

// 系统托盘：关闭窗口后服务继续后台运行
function createTray() {
  if (tray) return
  const iconPath = appIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开界面', click: () => showUi() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }, // 统一走 before-quit：置 isQuitting + await 清理 harness 进程组
  ]))
  tray.on('click', () => showUi())
}

// macOS: 点击 Dock 图标恢复隐藏的窗口（窗口隐藏到托盘后，Dock 点击依赖 activate 事件）
app.on('activate', () => { showUi() })

function showUi() {
  if (!uiWindow) { openUi(); return }
  if (uiWindow.isMinimized()) uiWindow.restore()
  uiWindow.show()
  uiWindow.focus()
}

function openUi() {
  // macOS: 使用原生红黄绿交通灯(titleBarStyle: 'hiddenInset' 隐藏标题栏但保留原生按钮)
  // Windows/Linux: 完全无边框 + 注入自绘按钮(见 injectWindowControls)
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
      preload: path.join(__dirname, 'titlebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  uiWindow.loadURL(`http://127.0.0.1:${HARNESS_PORT}`)
  // 只允许停留在 harness 本机源，防止页面跳转外域后 preload/注入控件被带出去
  const harnessOrigin = `http://127.0.0.1:${HARNESS_PORT}`
  uiWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(harnessOrigin)) e.preventDefault()
  })
  uiWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(harnessOrigin)) return { action: 'allow' }
    // 外部链接交给系统浏览器（新窗口与本窗口同 origin 除外）
    require('node:child_process').spawn(
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open',
      process.platform === 'win32' ? ['/c', 'start', '', url] : [url],
      { detached: true, stdio: 'ignore' },
    ).unref()
    return { action: 'deny' }
  })
  uiWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // 后端尚未就绪时的加载失败：短暂等待后自动重载
    if (url.startsWith(harnessOrigin)) setTimeout(() => uiWindow?.webContents.reload(), 1500)
    console.error(`load failed ${code}: ${desc}`)
  })
  uiWindow.on('page-title-updated', (e) => e.preventDefault())
  uiWindow.on('closed', () => { uiWindow = null })
  // 点关闭（✕）不退出，隐藏到托盘，服务继续运行
  uiWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      uiWindow.hide()
      // 首次隐藏时弹系统通知，提示用户应用仍在后台运行、如何真正退出
      if (!hideNotified) {
        hideNotified = true
        try {
          new Notification({ title: 'DeepSeek Harness 仍在运行', body: '窗口已最小化到系统托盘，右键托盘图标可退出应用。' }).show()
        } catch { /* 通知失败不影响功能 */ }
      }
    }
  })
  // 页面加载完成后，把三个窗口按钮嵌入到页面右上角 + 顶部拖拽区
  uiWindow.webContents.on('did-finish-load', () => {
    injectWindowControls(uiWindow.webContents)
  })
  // 最大化状态变化通知页面，用于切换 最大化/还原 图标
  uiWindow.on('maximize', () => uiWindow.webContents.send('win:maximized-change', true))
  uiWindow.on('unmaximize', () => uiWindow.webContents.send('win:maximized-change', false))
}

// 向 harness 页面注入浮动窗口控件与拖拽区。
// macOS: 原生交通灯在左上角(12,12 起,约 70px 宽)，仅注入顶部拖拽区(左侧留出交通灯空间)，
//        不注入自绘按钮——关闭/最小化/全屏均走系统红黄绿按钮。
// Windows/Linux: 注入右上角自绘按钮 + 整行拖拽区。
function injectWindowControls(wc) {
  if (IS_MAC) {
    // macOS: 顶部拖拽区，避开左侧约 84px 的原生交通灯
    const cssMac = `
      .dsh-drag-region { position: fixed; top: 0; left: 84px; right: 0; height: 32px; -webkit-app-region: drag; z-index: 2147483646; }
      .dsh-drag-region::after { content: ''; position: absolute; top: 10px; left: 50%; transform: translateX(-50%); width: 160px; height: 5px; border-radius: 3px; background: rgba(128,128,128,0.28); }
    `
    wc.insertCSS(cssMac).catch(() => {})
    const jsMac = `(function(){
      if (document.querySelector('.dsh-drag-region')) return;
      var drag = document.createElement('div'); drag.className = 'dsh-drag-region'; document.body.appendChild(drag);
    })();`
    wc.executeJavaScript(jsMac).catch(() => {})
    return
  }

  const isWin = process.platform === 'win32'
  const css = `
    .dsh-drag-region { position: fixed; top: 0; left: 0; right: 138px; height: 32px; -webkit-app-region: drag; z-index: 2147483646; }
    .dsh-win-controls { position: fixed; top: 0; right: 0; height: 32px; display: flex; z-index: 2147483647; -webkit-app-region: no-drag; }
    .dsh-win-controls button {
      width: 46px; height: 32px; border: none; background: transparent; padding: 0;
      font-family: "Segoe MDL2 Assets", "Segoe Fluent Icons", sans-serif;
      font-size: 10px; line-height: 32px; color: #595959;
      display: flex; align-items: center; justify-content: center; cursor: default;
    }
    .dsh-win-controls button svg { width: 10px; height: 10px; fill: currentColor; }
    .dsh-win-controls button:hover { background: rgba(0,0,0,0.06); color: #000; }
    .dsh-win-controls button:active { background: rgba(0,0,0,0.12); }
    .dsh-win-controls button.dsh-close:hover { background: #e81123; color: #fff; }
    .dsh-win-controls button.dsh-close:active { background: #c50f1f; }
  `
  wc.insertCSS(css).catch(() => {})
  const isWinFlag = isWin ? 'true' : 'false'
  const js = `(function(){
    if (document.querySelector('.dsh-win-controls')) return;
    var IS_WIN = ${isWinFlag};
    var GLYPH_MIN='\\uE921', GLYPH_MAX='\\uE922', GLYPH_REST='\\uE923', GLYPH_CLOSE='\\uE8BB';
    var SVG_MIN='<svg viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1"/></svg>';
    var SVG_MAX='<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    var SVG_REST='<svg viewBox="0 0 10 10"><path d="M2.5 1.5 h5.5 v5.5 h-5.5 z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M1.5 2.5 v6 h6" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    var SVG_CLOSE='<svg viewBox="0 0 10 10"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" stroke-width="1"/></svg>';
    function btnContent(glyph, svg){ return IS_WIN ? glyph : svg; }
    var drag = document.createElement('div'); drag.className = 'dsh-drag-region'; document.body.appendChild(drag);
    var bar = document.createElement('div'); bar.className = 'dsh-win-controls';
    var minBtn = document.createElement('button'); minBtn.innerHTML = btnContent(GLYPH_MIN, SVG_MIN); minBtn.title = '最小化';
    var maxBtn = document.createElement('button'); maxBtn.innerHTML = btnContent(GLYPH_MAX, SVG_MAX); maxBtn.title = '最大化';
    var closeBtn = document.createElement('button'); closeBtn.innerHTML = btnContent(GLYPH_CLOSE, SVG_CLOSE); closeBtn.className = 'dsh-close'; closeBtn.title = '关闭';
    minBtn.addEventListener('click', function(){ window.win && window.win.minimize(); });
    maxBtn.addEventListener('click', function(){ window.win && window.win.maximize(); });
    closeBtn.addEventListener('click', function(){ window.win && window.win.close(); });
    bar.appendChild(minBtn); bar.appendChild(maxBtn); bar.appendChild(closeBtn);
    document.body.appendChild(bar);
    function setMax(v){ maxBtn.innerHTML = btnContent(v ? GLYPH_REST : GLYPH_MAX, v ? SVG_REST : SVG_MAX); maxBtn.title = v ? '还原' : '最大化'; }
    if (window.win && window.win.isMaximized) window.win.isMaximized().then(setMax).catch(function(){});
    if (window.win && window.win.onMaximizedChange) window.win.onMaximizedChange(setMax);
  })();`
  wc.executeJavaScript(js).catch(() => {})
}

// 自绘标题栏窗口控制
ipcMain.on('win:minimize', () => { uiWindow?.minimize() })
ipcMain.on('win:maximize', () => {
  if (!uiWindow) return
  uiWindow.isMaximized() ? uiWindow.unmaximize() : uiWindow.maximize()
})
ipcMain.on('win:close', () => { uiWindow?.close() })
ipcMain.handle('win:isMaximized', () => uiWindow?.isMaximized() ?? false)

app.whenReady().then(async () => {
  createTray() // 托盘常驻，关闭窗口后服务仍在后台
  createSplash() // 启动加载页（MD3）
  const ok = await startHarness()
  splashDone()
  if (ok) openUi()
  else app.quit()
})

// 窗口关闭到托盘后不退出；仅真正退出时才停服
app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})
// ⚠️ 必须在这里置 isQuitting=true：Dock 右键退出 / Cmd+Q / 应用菜单都会走
// before-quit，若不清标记，窗口 close 事件会因 isQuitting=false 而
// preventDefault() 拦截退出，导致应用永远退不掉（只能强杀）。
// 同时：必须 await stopHarness() 完成后再真正退出——
// 否则主进程退出后，进程组清理的异步兜底(SIGKILL)不再执行 → 残留 harness 占住 3080。
let quitCleanupStarted = false
app.on('before-quit', (e) => {
  isQuitting = true
  if (quitCleanupStarted) return // 二次进入(清理完成后的真正退出)直接放行
  quitCleanupStarted = true
  e.preventDefault() // 先拦下退出，等待 harness 进程组清理完成
  stopHarness().then(() => app.quit())
})
