'use strict'

/**
 * updater.js —— 桌面端自动更新(从 GitHub Release 拉取 DMG 并替换)
 *
 * 职责:
 *   1. 查询 GitHub 最新 Release(tag + macOS DMG 资产 URL)
 *   2. 与本地版本比对,判断是否有更新
 *   3. 下载 DMG 到临时目录(带进度回调)
 *   4. 挂载 DMG → 拷贝 .app 替换 /Applications → 重启运行部分
 *
 * 设计原则(见 PRINCIPLES.md):
 *   - 启动页(壳)常驻,更新后只重启"运行部分"(DSH 内容),不重启启动页
 *   - 更新逻辑在主进程(updater.js),不依赖 web
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { spawnSync } = require('node:child_process')

const REPO = '2384241295abc/DshDesk'
const API = `https://api.github.com/repos/${REPO}/releases/latest`

/** 当前本地版本(来自 package.json) */
function localVersion() {
  try {
    return require('./package.json').version || '0.0.0'
  } catch { return '0.0.0' }
}

/** 版本号比较:a>b → 1, a==b → 0, a<b → -1 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** 查询 GitHub 最新 Release;返回 { tag, version, assetUrl, assetName, assetSize } 或 null */
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(API, { headers: { 'User-Agent': 'DeepSeekHarness-Desktop', Accept: 'application/vnd.github+json' }, timeout: 15000 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const d = JSON.parse(body)
          if (!d.tag_name) return resolve(null)
          // 按平台选资产:macOS→DMG,Windows→exe 安装包
          const isWin = process.platform === 'win32'
          const asset = (d.assets || []).find((a) => isWin
            ? /\.exe$/i.test(a.name)
            : /macOS-arm64.*\.dmg$/i.test(a.name))
          if (!asset) return resolve(null)
          resolve({
            tag: d.tag_name,
            version: String(d.tag_name).replace(/^v/, ''),
            assetUrl: asset.browser_download_url,
            assetName: asset.name,
            assetSize: asset.size,
          })
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('request timeout')) })
  })
}

/**
 * 下载文件到目标路径,带进度回调。
 * @param {string} url
 * @param {string} dest
 * @param {(p:{received:number,total:number,percent:number})=>void} onProgress
 */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const file = fs.createWriteStream(dest)
    // 整体超时:防止代理/网络异常导致永久挂起(用户反馈更新下不了,无反馈)
    const timer = setTimeout(() => {
      file.close(); try { fs.unlinkSync(dest) } catch {}
      req.destroy()
      reject(new Error('下载超时(120s),请检查网络或代理后重试'))
    }, 120000)
    const req = mod.get(url, { headers: { 'User-Agent': 'DeepSeekHarness-Desktop' }, timeout: 30000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // 跟随重定向(GitHub release 会 302 到 objects 存储)
        clearTimeout(timer)
        file.close()
        fs.unlinkSync(dest)
        return download(res.headers.location, dest, onProgress).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer)
        file.close()
        fs.unlinkSync(dest)
        return reject(new Error(`download failed: HTTP ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (onProgress) onProgress({ received, total, percent: total ? Math.round(received / total * 100) : 0 })
      })
      res.pipe(file)
      file.on('finish', () => { clearTimeout(timer); file.close(); resolve(dest) })
      file.on('error', (e) => { clearTimeout(timer); file.close(); fs.unlinkSync(dest); reject(e) })
    })
    req.on('error', (e) => { clearTimeout(timer); file.close(); try { fs.unlinkSync(dest) } catch {} reject(e) })
  })
}

/** 挂载 DMG,返回挂载点;失败返回 null */
function mountDmg(dmgPath) {
  const r = spawnSync('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  // 输出如: /dev/disk4 ... /Volumes/DeepSeek Harness
  const m = r.stdout.match(/\/Volumes\/[^\n]+/)
  return m ? m[0].trim() : null
}

/** 卸载 DMG */
function unmountDmg(mountPoint) {
  spawnSync('hdiutil', ['detach', mountPoint], { encoding: 'utf8' })
}

/**
 * 替换安装:从挂载点拷贝 .app 到 /Applications(替换旧版)
 * @returns {{ok:boolean, error?:string}}
 */
function installApp(mountPoint, appName = 'DeepSeekHarness.app') {
  const src = path.join(mountPoint, appName)
  const destDir = '/Applications'
  const dest = path.join(destDir, appName)
  if (!fs.existsSync(src)) return { ok: false, error: `挂载点无 ${appName}` }
  try {
    // 移除旧版(先移到废纸篓/备份,失败则直接删)
    if (fs.existsSync(dest)) {
      const backup = dest + '.old'
      spawnSync('rm', ['-rf', backup])
      spawnSync('mv', [dest, backup])   // 旧版备份,安装成功后再删
    }
    const r = spawnSync('cp', ['-R', src, dest], { encoding: 'utf8' })
    if (r.status !== 0) {
      // 回滚备份
      if (fs.existsSync(dest + '.old')) spawnSync('mv', [dest + '.old', dest])
      return { ok: false, error: `拷贝失败: ${r.stderr?.slice(0, 200)}` }
    }
    // 安装成功,清理备份
    spawnSync('rm', ['-rf', dest + '.old'])
    // 移除隔离属性(从网络下载的 app)
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', dest])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * Windows: 静默运行 Inno Setup 安装包(覆盖安装,更新用户配置保留)。
 * Inno Setup 静默参数: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER
 * @returns {{ok:boolean, error?:string}}
 */
function installWindowsExe(exePath) {
  if (process.platform !== 'win32') return { ok: false, error: '非 Windows 平台' }
  if (!fs.existsSync(exePath)) return { ok: false, error: `安装包不存在: ${exePath}` }
  try {
    const r = spawnSync(exePath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER'], { encoding: 'utf8', timeout: 300000 })
    if (r.status !== 0) return { ok: false, error: `安装退出码 ${r.status}: ${r.stderr?.slice(0, 200) || ''}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

module.exports = { localVersion, compareVersions, fetchLatestRelease, download, mountDmg, unmountDmg, installApp, installWindowsExe }
