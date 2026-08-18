'use strict'

/**
 * theme.mjs —— 桌面壳皮肤接口
 *
 * 设计：将桌面壳注入的视觉（拖拽区、窗口按钮、导航条样式）集中为「皮肤」对象。
 * 当前默认皮肤 = 现有视觉（深色系，跟随 DSH Web UI 暗色主题）。
 * 未来新增皮肤只需实现同一结构并在 skinRegistry 注册，切换时重注入即可。
 */

// 皮肤注册表：name -> theme。未来皮肤（浅色/自定义）在此追加。
const skinRegistry = new Map()

/**
 * 创建默认皮肤（当前视觉基线）。
 * @param {object} opts 可选覆盖
 * @returns {{name:string, css:string, navCss:string, navBar:string, inject:Function}}
 */
function createDefaultSkin(opts = {}) {
  const accent = opts.accent || '#e81123'      // 关闭按钮红
  const navH = opts.navHeight || 40            // 顶部导航条高度
  const navBg = opts.navBg || 'rgba(20,20,24,0.92)'
  const navText = opts.navText || '#c9c9cd'
  const navActive = opts.navActive || '#ffffff'

  return {
    name: 'default',
    navHeight: navH,

    // 窗口控制按钮 + 拖拽区样式（macOS 走原生交通灯，仅非 macOS 注入按钮）
    // 导航条已移左侧竖排，顶部拖拽区恢复整行（非 macOS 右侧留 138px 给按钮）
    css: `
      .dsh-drag-region { position: fixed; top: 0; left: 48px; right: 0; height: 32px; -webkit-app-region: drag; z-index: 2147483646; }
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
      .dsh-win-controls button.dsh-close:hover { background: ${accent}; color: #fff; }
      .dsh-win-controls button.dsh-close:active { background: #c50f1f; }
    `,

    // 融入 DSH 原生左侧栏的模式（首选）：按钮 36px 方形图标，与 DSH iconButton 一致
    navNativeCss: `
      .dsh-nav-native { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0; }
      .dsh-nav-native .dsh-nav-btn {
        border: none; background: transparent; width: 36px; height: 36px;
        border-radius: 8px; font-size: 17px; line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: inherit; }
      .dsh-nav-native .dsh-nav-btn:hover { background: rgba(255,255,255,0.10); }
      .dsh-nav-native .dsh-nav-btn.active { background: rgba(255,255,255,0.16); }
    `,

    // 左侧竖排迷你导航条（activity-bar 风格，不遮页面顶部导航栏）
    // 位置：窗口左边缘，宽 48px；macOS 从交通灯下方开始(top:44px)，其余从顶部开始
    navCss: `
      .dsh-nav { position: fixed; top: 40px; left: 0; bottom: 0; width: 48px;
        display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0;
        background: ${navBg}; -webkit-app-region: drag; z-index: 2147483646;
        border-right: 1px solid rgba(255,255,255,0.06); }
      .dsh-nav button.dsh-nav-btn {
        -webkit-app-region: no-drag; border: none; background: transparent;
        color: ${navText}; font-size: 12px; width: 40px; height: 40px;
        border-radius: 8px; cursor: pointer; line-height: 1.2;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .dsh-nav button.dsh-nav-btn .dsh-nav-ico { font-size: 16px; line-height: 1; }
      .dsh-nav button.dsh-nav-btn:hover { background: rgba(255,255,255,0.08); color: ${navActive}; }
      .dsh-nav button.dsh-nav-btn.active { background: rgba(255,255,255,0.14); color: ${navActive}; }
    `,

    // macOS：左侧竖排导航条从交通灯下方开始（top:44px 避开左上角红黄绿）
    navCssMac: `
      .dsh-nav { position: fixed; top: 44px; left: 0; bottom: 0; width: 48px;
        display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0;
        background: ${navBg}; -webkit-app-region: drag; z-index: 2147483646;
        border-right: 1px solid rgba(255,255,255,0.06); }
      .dsh-nav button.dsh-nav-btn {
        -webkit-app-region: no-drag; border: none; background: transparent;
        color: ${navText}; font-size: 12px; width: 40px; height: 40px;
        border-radius: 8px; cursor: pointer; line-height: 1.2;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .dsh-nav button.dsh-nav-btn .dsh-nav-ico { font-size: 16px; line-height: 1; }
      .dsh-nav button.dsh-nav-btn:hover { background: rgba(255,255,255,0.08); color: ${navActive}; }
      .dsh-nav button.dsh-nav-btn.active { background: rgba(255,255,255,0.14); color: ${navActive}; }
    `,
  }
}

/** 注册皮肤（未来扩展入口） */
function registerSkin(skin) {
  skinRegistry.set(skin.name, skin)
}

/** 获取皮肤（默认返回 default） */
function getSkin(name = 'default') {
  return skinRegistry.get(name) || defaultSkin
}

// 默认皮肤全局单例（当前视觉基线）
const defaultSkin = createDefaultSkin()
registerSkin(defaultSkin)

module.exports = { createDefaultSkin, registerSkin, getSkin, defaultSkin }
