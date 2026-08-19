'use strict'

// 壳 UI(shell.html)的 preload：接收主进程发布的页面清单,暴露窗口控制
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  // 主进程 → 壳:页面清单 + 当前页 + 版本
  onPages: (cb) => ipcRenderer.on('shell:pages', (_e, pages, active, version) => cb(pages, active, version)),
  // 主进程 → 壳:皮肤 CSS 变量
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, vars) => cb(vars)),
  // 主进程 → 壳:皮肤清单 + 当前皮肤
  onSkins: (cb) => ipcRenderer.on('shell:skins', (_e, skins, current) => cb(skins, current)),
  // 主进程 → 壳:切换高亮
  onActive: (cb) => ipcRenderer.on('shell:active', (_e, pageId) => cb(pageId)),
  // 主进程 → 壳:更新状态
  onUpdateStatus: (cb) => ipcRenderer.on('shell:update-status', (_e, state) => cb(state)),
  // 主进程 → 壳:已进入应用(隐藏启动页,显示主界面)
  onEntered: (cb) => ipcRenderer.on('shell:entered', () => cb()),
  // 主进程 → 壳:返回启动页
  onReturnLauncher: (cb) => ipcRenderer.on('shell:return-launcher', () => cb()),
  // 壳 → 主进程:切换页面 / 窗口控制 / 皮肤 / 启动页
  navigate: (pageId) => ipcRenderer.send('win:navigate', pageId),
  setSkin: (name) => ipcRenderer.send('shell:set-skin', name),
  openSkinMenu: () => ipcRenderer.send('shell:open-skin-menu'),
  checkUpdate: () => ipcRenderer.send('shell:check-update'),
  enterApp: () => ipcRenderer.send('shell:enter-app'),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  // 额度查询(主进程读凭据调 DeepSeek API,密钥不落渲染器)
  getBalance: () => ipcRenderer.invoke('balance:get'),
  openRecharge: () => ipcRenderer.send('balance:open-recharge'),
  // 复制:iframe 内 DSH 复制按钮经 postMessage 转交主进程写剪贴板
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  // 壳 → 主进程:iframe 加载完成(触发皮肤注入)
  notifyFrameLoaded: () => ipcRenderer.send('frame:loaded'),
  // 主进程 → 壳:页面 URL(供 iframe 加载)
  onPageUrl: (cb) => ipcRenderer.on('shell:page-url', (_e, pageId, url) => cb(pageId, url)),
})
