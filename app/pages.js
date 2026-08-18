'use strict'

/**
 * pages.mjs —— 桌面壳多页面注册表
 *
 * 设计：把桌面壳可切换的页面抽象为「页面描述对象」，集中注册。
 * 新增页面只需 registerPage({ id, label, url, auth?, onEnter? })，无需改主逻辑。
 *
 * 页面对象字段：
 *   id       唯一标识（导航切换用）
 *   label    导航栏显示名
 *   url      加载地址（http 或 file）
 *   auth     { type:'token', source:'file', path, tokenField } 可选：进入页面时自动注入 token 登录
 *   onEnter  (win) => void  可选：进入页面时回调（如探活、提示）
 */

const pages = new Map()

/**
 * 注册页面
 * @param {object} p { id, label, url, auth?, onEnter? }
 */
function registerPage(p) {
  if (!p || !p.id || !p.url) throw new Error(`pages: 页面需 id 与 url (got ${JSON.stringify(p)})`)
  pages.set(p.id, p)
}

/** 获取全部页面（按注册顺序） */
function listPages() {
  return [...pages.values()]
}

/** 按 id 取页面 */
function getPage(id) {
  return pages.get(id)
}

module.exports = { registerPage, listPages, getPage }
