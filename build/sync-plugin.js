'use strict'
// 一键同步 WanShengling 插件到 DshDesk 内嵌副本（改插件代码后必跑，防 healProfilesModuleFallback 拉回旧版）
//
// 单一事实来源：~/Documents/DshDesktop/dsh-qq-bridge/plugin（WanShengling 独立仓库，git 历史所在）
// 同步目标（全部为 gitignore/未跟踪、可再生的内嵌副本，rm+cp 保证与源完全一致）：
//   resources/harness/packages/qq/dsh-qq-bridge  —— 桌面打包唯一来源（assemble.js 拷入 app 的 Resources/harness）
//   build/packages/qq/dsh-qq-bridge              —— 上次构建的中间产物（存在则同步，杜绝 stale 残留）
// 用法：node build/sync-plugin.js
//
// 说明：build-harness.js 全量构建时也会重新注入插件；本脚本只做增量同步（快、不重跑 pnpm）。
// 若 resources/harness 内的 tsdown 桩文件（lib/types/*）被本脚本清掉，重跑 build-harness.js 会按需重新生成。
const fs = require('node:fs')
const path = require('node:path')

const proj = path.dirname(path.resolve(__dirname))
const pluginSrc = path.join(path.dirname(proj), 'dsh-qq-bridge', 'plugin')

const targets = [
  path.join(proj, 'resources', 'harness', 'packages', 'qq', 'dsh-qq-bridge'),
  path.join(proj, 'build', 'packages', 'qq', 'dsh-qq-bridge'),
]

if (!fs.existsSync(pluginSrc)) {
  console.error(`[sync-plugin] 插件源缺失: ${pluginSrc}（WanShengling 独立仓库未检出?）`)
  process.exit(1)
}

let synced = 0
for (const dest of targets) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(pluginSrc, dest, { recursive: true })
  console.log(`[sync-plugin] 已同步: ${dest}`)
  synced++
}
console.log(`[sync-plugin] 完成：${synced} 处副本 <- ${pluginSrc}`)
