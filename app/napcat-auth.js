'use strict'

/**
 * napcat-auth.mjs —— NapCat WebUI 自动登录
 *
 * 从 NapCat 的 webui.json 配置读取 token，注入到内嵌 WebUI 实现自动登录。
 * 配置路径因平台/安装方式而异，优先探测多个候选位置。
 */

const fs = require('node:fs')
const path = require('node:path')

// NapCat webui.json 候选路径（注入版 macOS 实测路径在前，其余兜底）
function webuiConfigCandidates() {
  const home = process.env.HOME || ''
  return [
    // 注入版 NapCat（QQ 2.app 容器内）
    path.join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Library', 'Application Support', 'QQ', 'NapCat', 'config', 'webui.json'),
    // Shell 版 / 独立安装（Application Support）
    path.join(home, 'Library', 'Application Support', 'QQ', 'NapCat', 'config', 'webui.json'),
  ]
}

/**
 * 读取 NapCat WebUI token。
 * @returns {{port:number, token:string, host:string}|null} 未找到返回 null
 */
function readNapCatWebUIConfig() {
  for (const p of webuiConfigCandidates()) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const cfg = JSON.parse(raw)
      if (cfg && (cfg.token || cfg.port)) {
        return { port: cfg.port ?? 6099, token: cfg.token || '', host: cfg.host || '127.0.0.1' }
      }
    } catch { /* 尝试下一个 */ }
  }
  return null
}

module.exports = { readNapCatWebUIConfig, webuiConfigCandidates }
