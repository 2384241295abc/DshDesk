'use strict'

/**
 * theme.js —— 桌面壳皮肤接口
 *
 * 皮肤 = 壳的完整视觉方案,分三类资源:
 *   colors     颜色(壳 UI 的 CSS 变量,注入 shell.html :root)
 *   images     图片资源(启动页 logo/背景等,dataURI 或路径)
 *   animations 动画接口(预留:皮肤可声明进入/切换动画,后续优化)
 *
 * 与 Web(DSH)完全解耦——皮肤只影响桌面壳自己的界面。
 *
 * 用法:
 *   const skin = getSkin('default')
 *   skin.colors        // { '--nav-bg': ... }
 *   skin.images        // { logo: dataURI, launcherBg: ... }
 *   skin.animations    // { ... } 预留
 *   registerSkin(createSkin({...}))
 */

const skinRegistry = new Map()

/**
 * 创建皮肤。
 * @param {object} opts
 *   colors 相关:navBg/navText/... 见下方
 *   images: { logo, launcherBg, ... }  图片资源(dataURI/路径)
 *   animations: { enter: {...}, switch: {...} }  预留动画定义
 * @returns {{name, label, colors, images, animations}}
 */
function createSkin(opts = {}) {
  // ---------- 颜色(CSS 变量) ----------
  const colors = {
    '--nav-h': `${opts.navH ?? 44}px`,
    '--nav-bg': opts.navBg || 'rgba(18,18,22,0.97)',
    '--nav-text': opts.navText || '#c9c9cd',
    '--nav-active': opts.navActive || '#ffffff',
    '--nav-hover-bg': opts.navHoverBg || 'rgba(255,255,255,0.08)',
    '--nav-active-bg': opts.navActiveBg || 'rgba(255,255,255,0.14)',
    '--title-color': opts.titleColor || '#8a8a90',
    '--version-color': opts.versionColor || 'rgba(255,255,255,0.35)',
    '--win-btn-color': opts.winBtnColor || '#8a8a90',
    '--win-btn-hover': opts.winBtnHover || 'rgba(255,255,255,0.10)',
    '--win-close-bg': opts.winCloseBg || '#e81123',
    '--app-bg': opts.appBg || '#101014',
    '--border': opts.border || 'rgba(255,255,255,0.08)',
    // 启动页
    '--launcher-title': opts.launcherTitleColor || '#ffffff',
    '--launcher-sub': opts.launcherSubColor || '#8a8a90',
    '--launcher-btn-bg': opts.launcherBtnBg || '#4D6BFE',
    '--launcher-btn-text': opts.launcherBtnText || '#ffffff',
    '--launcher-btn-ghost': opts.launcherBtnGhost || 'rgba(255,255,255,0.08)',
    '--launcher-accent': opts.launcherAccent || '#4D6BFE',
  }

  // ---------- 图片资源(皮肤可定制) ----------
  // logo:启动页主 logo(默认用项目既有 MD3 蓝色图标 dataURI)
  const images = {
    logo: opts.logo || DEFAULT_LOGO,
    launcherBg: opts.launcherBg || null,   // 启动页背景图(可选)
    topbarBg: opts.topbarBg || null,       // 顶栏背景图(可选)
  }

  // ---------- 动画接口(预留,后续优化) ----------
  // 皮肤可声明动画:进入/切换/进度等;当前仅占位,消费方按需实现
  const animations = opts.animations || {}

  return { name: opts.name || 'default', label: opts.label || '默认', colors, images, animations }
}

function registerSkin(skin) {
  skinRegistry.set(skin.name, skin)
}

function deleteSkin(name) {
  if (name === 'default') return   // 默认皮肤不可删
  skinRegistry.delete(name)
}

function getSkin(name = 'default') {
  return skinRegistry.get(name) || defaultSkin
}

function listSkins() {
  return [...skinRegistry.values()]
}

// 默认启动页 logo:项目既有 MD3 风格蓝色图标(dataURI 便于皮肤内嵌)
// 来源:原 splash.html 的 SVG(项目 M3 阶段设计语言)
const DEFAULT_LOGO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE"/></svg>`
  )

// 默认皮肤(深色,当前视觉基线)
const defaultSkin = createSkin({ name: 'default', label: '深色' })
registerSkin(defaultSkin)

// 浅色皮肤
const lightSkin = createSkin({
  name: 'light',
  label: '浅色',
  navBg: 'rgba(245,245,247,0.98)',
  navText: '#4a4a52',
  navActive: '#111114',
  navHoverBg: 'rgba(0,0,0,0.06)',
  navActiveBg: 'rgba(0,0,0,0.10)',
  titleColor: '#8a8a92',
  versionColor: 'rgba(0,0,0,0.35)',
  winBtnColor: '#6a6a72',
  winBtnHover: 'rgba(0,0,0,0.08)',
  winCloseBg: '#e81123',
  appBg: '#f2f2f4',
  border: 'rgba(0,0,0,0.10)',
  launcherTitleColor: '#111114',
  launcherSubColor: '#8a8a92',
  launcherBtnBg: '#4D6BFE',
  launcherBtnGhost: 'rgba(0,0,0,0.06)',
})
registerSkin(lightSkin)

module.exports = { createSkin, registerSkin, deleteSkin, getSkin, listSkins, defaultSkin, DEFAULT_LOGO }
