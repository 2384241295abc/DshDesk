'use strict'

// ============================================================================
// DeepSeek Harness 桌面壳 —— 同层 iframe 架构
//
// 布局由桌面壳掌控:
//   ┌──────────────────────────────────────┐
//   │ 顶部导航栏(壳原生 UI: shell.html)      │  ← 页面切换/设置,始终可交互
//   ├──────────────────────────────────────┤
//   │ 启动页(launcher) / iframe(主界面)      │  ← 同层:iframe 与壳同一 web 内容
//   └──────────────────────────────────────┘
//
// iframe 方案:DSH/NapCat 通过 iframe 嵌入壳 web 内容,与顶栏同层,
// 顶栏不被遮挡、始终可交互(WebContentsView 原生层会盖住壳的问题已根治)。
//
// 皮肤接口 theme.js / 页面接口 pages.js / 更新 updater.js / 皮肤定制(原生菜单)
// ============================================================================

const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const { readNapCatWebUIConfig } = require('./napcat-auth.js')
const { registerPage, listPages, getPage } = require('./pages.js')
const { getSkin, listSkins, createSkin, registerSkin, deleteSkin } = require('./theme.js')
const updater = require('./updater.js')

const HARNESS_PORT = 3080
const BOOT_MARKER = '__DSH_BOOT__'
const START_TIMEOUT_MS = 120 * 1000
const IS_MAC = process.platform === 'darwin'
const NAV_H = 44

let isQuitting = false

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showUi())
}

let uiWindow = null
let splashWindow = null
let serverProcess = null
let stopRequested = false
let hideNotified = false
let currentPageId = 'main'
let currentSkinName = 'default'

function appResourcesDir() {
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

// ---------- DeepSeek 余额查询(主进程读凭据,密钥不落渲染器) ----------
const CREDENTIALS_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEEPSEEK_RECHARGE_URL = 'https://platform.deepseek.com/top_up'

/** 读取 ~/.dsh/.credentials.yaml 中的 DEEPSEEK_API_KEY(行级解析,不引入 yaml 依赖) */
function readDeepSeekApiKey() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8')
    const m = raw.match(/^DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)
    return m ? m[1] : null
  } catch { return null }
}

/** 调 DeepSeek /user/balance;返回 {ok:true,data} 或 {ok:false,error} */
async function fetchDeepSeekBalance() {
  const key = readDeepSeekApiKey()
  if (!key) return { ok: false, error: '未找到 DEEPSEEK_API_KEY(检查 ~/.dsh/.credentials.yaml)' }
  try {
    const res = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { ok: false, error: `API 响应 ${res.status} ${res.statusText}` }
    const data = await res.json()
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: `请求失败: ${String(e?.message || e)}` }
  }
}

function showError(msg) {
  console.error(msg)
  try {
    dialog.showErrorBox('DeepSeek Harness 启动失败', `${msg}\n\n日志文件：${errFile()}`)
  } catch { /* 忽略 */ }
}

async function startHarness() {
  if (await probeServer()) return true
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
  try { process.kill(-pid, signal) } catch { /* 已退出 */ }
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true } catch { return false }
}
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
        const d2 = Date.now() + 1000
        const check2 = () => {
          if (!groupAlive(pid) || Date.now() >= d2) { resolve(); return }
          setTimeout(check2, 100)
        }
        check2()
      }
      const deadline = Date.now() + 5000
      check()
    } catch { resolve() }
  })
}

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
  if (splashWindow) { splashWindow.close(); splashWindow = null }
}

app.on('activate', () => { showUi() })

function showUi() {
  if (!uiWindow) { openUi(); return }
  if (uiWindow.isMinimized()) uiWindow.restore()
  uiWindow.show()
  uiWindow.focus()
}

// ---------- 皮肤状态 ----------
function skinStateFile() { return path.join(app.getPath('userData'), 'skin.json') }
function loadSkinState() {
  try {
    const s = JSON.parse(fs.readFileSync(skinStateFile(), 'utf8'))
    if (s && s.skin && listSkins().some((k) => k.name === s.skin)) currentSkinName = s.skin
  } catch { /* 首次 */ }
}
function saveSkinState() {
  try { fs.writeFileSync(skinStateFile(), JSON.stringify({ skin: currentSkinName })) } catch { /* 忽略 */ }
}
function applySkin(name) {
  const skin = getSkin(name)
  if (!skin) return
  currentSkinName = skin.name
  saveSkinState()
  if (uiWindow && !uiWindow.isDestroyed()) {
    uiWindow.webContents.send('shell:theme', skin.colors)
    uiWindow.webContents.send('shell:skins', listSkins().map((s) => ({ name: s.name, label: s.label, colors: s.colors, images: s.images, animations: s.animations })), currentSkinName)
    injectDsThemeIntoFrames()
  }
}

// ---------- 皮肤 → DSH 主题联动(注入 --dsw-* 变量到 iframe 内 DSH 文档) ----------
function skinBridgeLog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'skin-bridge.log'),
      `${new Date().toISOString()} ${msg}\n`)
  } catch { /* 忽略 */ }
}

/** 把壳皮肤主色注入 iframe 内 DSH 文档的 token(不侵入 DSH 源码,仅覆盖 CSS 变量) */
function injectDsThemeIntoFrames() {
  if (!uiWindow || uiWindow.isDestroyed()) return
  const skin = getSkin(currentSkinName)
  const accent = skin.colors['--launcher-accent'] || '#4D6BFE'
  const appBg = skin.images && skin.images.appBg ? String(skin.images.appBg) : ''
  const mainFrame = uiWindow.webContents.mainFrame
  if (!mainFrame) return
  const accentBlock = [
    ':root, body, body[data-ds-dark-theme] {',
    '  --dsw-static-deepseek-400: ' + accent + ' !important;',
    '  --dsw-static-deepseek-450: ' + accent + ' !important;',
    '  --dsw-static-deepseek-500: ' + accent + ' !important;',
    '  --dsw-static-deepseek-600: ' + accent + ' !important;',
    '  --dsw-alias-brand-primary-new-colorprimary-new-color: ' + accent + ' !important;',
    '  --dsw-alias-button-info-fill: ' + accent + ' !important;',
    '  --dsw-alias-button-info-hover: ' + accent + ' !important;',
    '  --dsw-alias-state-business-primary: ' + accent + ' !important;',
    '}',
  ]
  // 皮肤带工作台背景图:半透明化 DSH 背景层,并直接把 appBg 铺到 body
  const bgBlock = appBg ? [
    ':root, body, body[data-ds-dark-theme] {',
    '  --dsw-alias-bg-base: rgba(16, 16, 20, 0.55) !important;',
    '  --dsw-alias-bg-layer-1: rgba(28, 28, 34, 0.62) !important;',
    '  --dsw-alias-bg-layer-2: rgba(28, 28, 34, 0.68) !important;',
    '  --dsw-alias-bg-layer-3: rgba(28, 28, 34, 0.72) !important;',
    '  --dsw-specific-sidebar-fill: rgba(21, 21, 23, 0.55) !important;',
    '  --dsw-specific-menu: rgba(28, 28, 34, 0.78) !important;',
    '  --dsw-alias-bg-module-platform: rgba(28, 28, 34, 0.6) !important;',
    '  --dsw-alias-bg-overlay: rgba(28, 28, 34, 0.72) !important;',
    '  --dsw-alias-bg-multi-select: rgba(28, 28, 34, 0.6) !important;',
    '  --dsw-specific-bubble: rgba(28, 28, 34, 0.55) !important;',
    '}',
    'body, body[data-ds-dark-theme] {',
    '  background-image: url("' + appBg + '") !important;',
    '  background-size: cover !important;',
    '  background-position: center !important;',
    '  background-repeat: no-repeat !important;',
    '  background-attachment: fixed !important;',
    '}',
  ] : []
  const css = accentBlock.concat(bgBlock).join('\n')
  const styleCode = `(() => {
      const old = document.getElementById('dsh-shell-skin-bridge')
      if (old) old.remove()
      const s = document.createElement('style')
      s.id = 'dsh-shell-skin-bridge'
      s.textContent = ${JSON.stringify(css)}
      ;(document.head || document.documentElement).appendChild(s)
      // 回读计算样式,写回主进程日志定位
      const b = getComputedStyle(document.body)
      return JSON.stringify({ bgColor: b.backgroundColor, bgImage: b.backgroundImage.slice(0, 40), bodyBg: document.body.style.background })
    })()`
  let injected = 0
  for (const frame of mainFrame.frames) {
    if (frame.url && frame.url.includes('127.0.0.1:3080')) {
      frame.executeJavaScript(styleCode)
        .then((probe) => { injected++; skinBridgeLog(`injected accent=${accent} appBg=${!!appBg} -> ${frame.url} probe=${probe}`) })
        .catch((e) => skinBridgeLog(`inject failed -> ${frame.url}: ${String(e?.message || e)}`))
    }
  }
  skinBridgeLog(`injectDsThemeIntoFrames: frames=${mainFrame.frames.length} matched=${injected} skin=${currentSkinName}`)
}

// ---------- 页面注册 ----------
function registerBuiltinPages() {
  registerPage({ id: 'main', label: '主界面', url: `http://127.0.0.1:${HARNESS_PORT}` })
  registerPage({
    id: 'napcat', label: 'NapCat',
    url: () => {
      const cfg = readNapCatWebUIConfig()
      const port = cfg?.port || 6099
      const token = cfg?.token || ''
      return token ? `http://127.0.0.1:${port}/webui?token=${encodeURIComponent(token)}` : `http://127.0.0.1:${port}/webui`
    },
  })
  // 壳内视图(无 url):不加载 iframe,由 shell.js 按 pageId 显示对应壳内视图
  registerPage({ id: 'balance', label: '额度' })
}
registerBuiltinPages()

function navigateTo(pageId, opts = {}) {
  const page = getPage(pageId)
  if (!page) { console.error(`navigate: 未知页面 ${pageId}`); return }
  if (!uiWindow) { openUi(); return }
  currentPageId = pageId
  const url = typeof page.url === 'function' ? page.url() : page.url
  // iframe 方案:回发 URL 给壳,壳设置 iframe.src(与壳同层)
  uiWindow.webContents.send('shell:page-url', pageId, url)
  uiWindow.webContents.send('shell:active', pageId)
  if (!opts.silent) showUi()
}

/** 进入应用:切换工作台视图(壳 iframe 加载当前页) */
function enterApp() {
  if (uiWindow && !uiWindow.isDestroyed()) {
    uiWindow.webContents.send('shell:entered')
    const page = getPage(currentPageId)
    const url = page ? (typeof page.url === 'function' ? page.url() : page.url) : null
    if (url) uiWindow.webContents.send('shell:page-url', currentPageId, url)
  }
}

/** 返回启动窗口:卸载工作台,回到启动页 */
function returnToLauncher() {
  if (uiWindow && !uiWindow.isDestroyed()) {
    uiWindow.webContents.send('shell:return-launcher')
  }
}

// ---------- 主窗口 ----------
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
          new Notification({ title: 'DeepSeek Harness 仍在运行', body: '窗口已隐藏,Dock 点击可恢复。' }).show()
        } catch { /* 忽略 */ }
      }
    }
  })

  // 壳 UI 就绪:发布页面/皮肤/版本(启动页显示)
  uiWindow.webContents.on('did-finish-load', () => {
    const pages = listPages().map((p) => ({ id: p.id, label: p.label }))
    let version = '0.2.1'
    try { version = require('./package.json').version || version } catch { /* 忽略 */ }
    uiWindow.webContents.send('shell:theme', getSkin(currentSkinName).colors)
    uiWindow.webContents.send('shell:skins', listSkins().map((s) => ({ name: s.name, label: s.label, colors: s.colors, images: s.images, animations: s.animations })), currentSkinName)
    uiWindow.webContents.send('shell:pages', pages, currentPageId, version)
    uiWindow.webContents.send('shell:update-status', { phase: 'idle', text: `当前版本 v${version}` })
  })

  // iframe(DSH)每次加载完成后注入皮肤联动主题
  uiWindow.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
    if (!isMainFrame) injectDsThemeIntoFrames()
  })
}

// ---------- 皮肤定制(原生菜单 + 对话框,无独立 web 窗口) ----------

/** 获取或创建自定义皮肤草稿 */
function customSkinDraft() {
  let s = getSkin('custom')
  if (!s) {
    s = createSkin({ name: 'custom', label: '自定义' })
    registerSkin(s)
  }
  return s
}

/** 导入图片到自定义皮肤(原生对话框) */
function pickSkinImage(slot) {
  dialog.showOpenDialog({
    title: slot === 'launcher' ? '选择启动界面图片' : '选择工作台界面图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  }).then((res) => {
    if (res.canceled || !res.filePaths?.length) return
    const file = res.filePaths[0]
    try {
      const buf = fs.readFileSync(file)
      const ext = path.extname(file).toLowerCase().slice(1)
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png'
      const dataUri = `data:${mime};base64,${buf.toString('base64')}`
      const s = customSkinDraft()
      if (slot === 'launcher') s.images.launcherBg = dataUri
      else s.images.appBg = dataUri
      // 实时预览:应用自定义皮肤(若用户已在用自定义)或仅更新草稿
      applySkin('custom')
    } catch (err) {
      dialog.showErrorBox('导入失败', String(err?.message || err))
    }
  })
}

/** 移除自定义皮肤图片 */
function clearSkinImage(slot) {
  const s = getSkin('custom')
  if (!s) return
  if (slot === 'launcher') delete s.images.launcherBg
  else delete s.images.appBg
  applySkin('custom')
}

/** 设置自定义皮肤主色 */
function setSkinColor(hex) {
  const s = customSkinDraft()
  s.colors['--launcher-btn-bg'] = hex
  s.colors['--launcher-accent'] = hex
  applySkin('custom')
}

// ---------- 更新流程 ----------
function sendUpdateStatus(state) {
  if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('shell:update-status', state)
}
async function runUpdate() {
  sendUpdateStatus({ phase: 'checking', text: '正在检查更新…' })
  try {
    const latest = await updater.fetchLatestRelease()
    if (!latest) { sendUpdateStatus({ phase: 'error', text: '无法获取最新版本(检查网络或 Release)' }); return }
    const local = updater.localVersion()
    if (updater.compareVersions(latest.version, local) <= 0) {
      sendUpdateStatus({ phase: 'uptodate', text: `已是最新版本 v${local}` })
      return
    }
    sendUpdateStatus({ phase: 'found', text: `发现新版本 v${latest.version},开始下载…` })
    const tmpDir = path.join(app.getPath('temp'), 'dsh-update')
    fs.mkdirSync(tmpDir, { recursive: true })
    const dmgPath = path.join(tmpDir, latest.dmgName)
    sendUpdateStatus({ phase: 'downloading', text: `正在下载 v${latest.version}(${(latest.dmgSize / 1024 / 1024).toFixed(0)}MB)…`, percent: 0 })
    await updater.download(latest.dmgUrl, dmgPath, (p) => {
      sendUpdateStatus({ phase: 'downloading', text: `正在下载 v${latest.version}… ${p.percent}%`, percent: p.percent })
    })
    sendUpdateStatus({ phase: 'installing', text: '正在安装更新…' })
    const mountPoint = updater.mountDmg(dmgPath)
    if (!mountPoint) { sendUpdateStatus({ phase: 'error', text: 'DMG 挂载失败' }); return }
    const result = updater.installApp(mountPoint)
    updater.unmountDmg(mountPoint)
    if (!result.ok) { sendUpdateStatus({ phase: 'error', text: `安装失败: ${result.error}` }); return }
    sendUpdateStatus({ phase: 'done', text: '更新完成,正在重启运行部分…' })
    setTimeout(() => {
      stopHarness().then(() => {
        startHarness().then((ok) => {
          if (ok && uiWindow && !uiWindow.isDestroyed()) {
            uiWindow.webContents.send('shell:page-url', 'main', `http://127.0.0.1:${HARNESS_PORT}`)
            sendUpdateStatus({ phase: 'done', text: `已更新到 v${latest.version}` })
          }
        })
      })
    }, 800)
  } catch (e) {
    sendUpdateStatus({ phase: 'error', text: `更新失败: ${String(e?.message || e)}` })
  }
}

// ---------- IPC ----------
ipcMain.handle('balance:get', () => fetchDeepSeekBalance())
ipcMain.on('balance:open-recharge', () => {
  shell.openExternal(DEEPSEEK_RECHARGE_URL).catch(() => { /* 忽略 */ })
})
ipcMain.on('frame:loaded', () => injectDsThemeIntoFrames())
ipcMain.on('win:navigate', (_e, pageId) => { navigateTo(String(pageId), { silent: true }) })
ipcMain.on('shell:set-skin', (_e, name) => { applySkin(String(name)) })
ipcMain.on('shell:open-skin-menu', () => {
  const hasCustom = !!getSkin('custom')
  const presetColors = ['#4D6BFE', '#e81123', '#28c840', '#febc2e', '#7c3aed', '#0891b2', '#f472b6', '#84cc16']
  const menu = Menu.buildFromTemplate([
    ...listSkins().map((s) => ({ label: s.label, type: 'radio', checked: s.name === currentSkinName, click: () => applySkin(s.name) })),
    { type: 'separator' },
    { label: '导入启动界面图片…', click: () => pickSkinImage('launcher') },
    { label: '导入工作台界面图片…', click: () => pickSkinImage('app') },
    { label: '移除启动图', enabled: !!(getSkin('custom')?.images?.launcherBg), click: () => clearSkinImage('launcher') },
    { label: '移除工作台图', enabled: !!(getSkin('custom')?.images?.appBg), click: () => clearSkinImage('app') },
    { type: 'separator' },
    {
      label: '主色基调',
      submenu: presetColors.map((c) => ({
        label: c,
        click: () => setSkinColor(c),
      })),
    },
    { type: 'separator' },
    { label: '应用自定义皮肤', enabled: hasCustom, click: () => applySkin('custom') },
    { label: '恢复默认', enabled: hasCustom, click: () => { deleteSkin('custom'); applySkin('default') } },
    { type: 'separator' },
    { label: '回到主界面', click: () => navigateTo('main') },
    { label: '返回启动窗口', click: () => returnToLauncher() },
  ])
  menu.popup({ window: uiWindow })
})
ipcMain.on('shell:check-update', () => { void runUpdate() })
ipcMain.on('shell:enter-app', () => { enterApp() })
ipcMain.on('win:minimize', () => { uiWindow?.minimize() })
ipcMain.on('win:maximize', () => { uiWindow?.isMaximized() ? uiWindow?.unmaximize() : uiWindow?.maximize() })
ipcMain.on('win:close', () => { uiWindow?.close() })
ipcMain.handle('win:isMaximized', () => uiWindow?.isMaximized() ?? false)

app.whenReady().then(async () => {
  loadSkinState()
  createSplash()
  const ok = await startHarness()
  splashDone()
  if (ok) openUi()
  else app.quit()
})

app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})

let quitCleanupStarted = false
app.on('before-quit', (e) => {
  isQuitting = true
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  e.preventDefault()
  stopHarness().then(() => app.quit())
})
