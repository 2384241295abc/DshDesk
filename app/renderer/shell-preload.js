'use strict'

// 壳 UI(shell.html)的 preload：接收主进程发布的页面清单,暴露窗口控制
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshShell', {
  // 主进程 → 壳:页面清单 + 当前页 + 版本
  onPages: (cb) => ipcRenderer.on('shell:pages', (_e, pages, active, version) => cb(pages, active, version)),
  // 主进程 → 壳:切换高亮
  onActive: (cb) => ipcRenderer.on('shell:active', (_e, pageId) => cb(pageId)),
  // 壳 → 主进程:切换页面 / 窗口控制
  navigate: (pageId) => ipcRenderer.send('win:navigate', pageId),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
})
