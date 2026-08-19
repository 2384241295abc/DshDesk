'use strict'
// Windows 系统托盘:窗口 ✕ = 隐藏驻留(与 macOS 一致),托盘图标可恢复/退出。
// 仅在 win32 创建;macOS 走 Dock(activate 恢复)逻辑,无需托盘。
const { Tray, Menu, app } = require('electron')
const path = require('node:path')

let tray = null

/**
 * 创建 Windows 托盘。
 * @param {object} opts
 *   icon    图标路径(app.ico)
 *   onShow  点击托盘"打开主界面"回调(showUi)
 *   onQuit  点击托盘"退出"回调(真正退出)
 */
function createTray(opts = {}) {
  if (process.platform !== 'win32') return null
  const icon = opts.icon || (() => {
    const exeDir = path.dirname(process.execPath)
    const p = path.join(exeDir, 'app.ico')
    return require('node:fs').existsSync(p) ? p : undefined
  })()
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => opts.onShow && opts.onShow() },
    { type: 'separator' },
    { label: '退出', click: () => opts.onQuit && opts.onQuit() },
  ]))
  // 单击托盘图标 = 恢复窗口
  tray.on('click', () => opts.onShow && opts.onShow())
  return tray
}

/** 销毁托盘(退出前调用) */
function destroyTray() {
  if (tray) { tray.destroy(); tray = null }
}

module.exports = { createTray, destroyTray }
