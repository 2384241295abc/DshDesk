'use strict'
// 统一打包 DMG:assemble 产物 → hdiutil 压缩 → 校验 → 清理旧版
// 用法: node build/make-dmg.js [版本号]  (缺省读 package.json version)
// 保护: 只在产物校验通过后才删除旧版 DMG,避免误删/删错
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname)
const proj = path.dirname(root)
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(proj, 'app', 'package.json'), 'utf8')).version
const out = path.join(proj, 'build', 'DeepSeekHarnessApp')
const appDir = path.join(out, 'DeepSeekHarness.app')
const installers = path.join(proj, 'installers')
const dmg = path.join(installers, `DeepSeekHarness-macOS-arm64-${version}.dmg`)

function fail(msg) { console.error(`[make-dmg] ${msg}`); process.exit(1) }
function sh(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) fail(`${cmd} failed (exit ${r.status})`)
  return r
}

// 0. 前置校验
if (!fs.existsSync(path.join(appDir, 'Contents', 'Info.plist'))) fail(`产物不存在: ${appDir} (先跑 assemble)`)
const prodVer = JSON.parse(fs.readFileSync(path.join(appDir, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')).version
if (prodVer !== version) fail(`产物版本 ${prodVer} 与参数 ${version} 不一致`)

// 1. 打包
fs.mkdirSync(installers, { recursive: true })
if (fs.existsSync(dmg)) fs.rmSync(dmg)
sh('hdiutil', ['create', '-volname', 'DeepSeek Harness', '-srcfolder', out, '-ov', '-format', 'UDZO', dmg])

// 2. 校验:挂载 → md5 对比 app 层 → 卸载
const MP = '/Volumes/DeepSeek Harness'
sh('hdiutil', ['attach', dmg, '-nobrowse', '-quiet'])
try {
  const src = path.join(proj, 'app')
  const dst = path.join(MP, 'DeepSeekHarness.app', 'Contents', 'Resources', 'app')
  const files = ['main.js', 'theme.js', 'pages.js', 'renderer/shell.js', 'renderer/shell.html', 'renderer/shell-preload.js', 'package.json']
  for (const f of files) {
    const s = spawnSync('md5', ['-q', path.join(src, f)], { encoding: 'utf8' }).stdout.trim()
    const p = spawnSync('md5', ['-q', path.join(dst, f)], { encoding: 'utf8' }).stdout.trim()
    if (s !== p) fail(`md5 不一致: ${f} (${s} vs ${p})`)
  }
  console.log(`[make-dmg] 校验通过: ${dmg}`)
} finally {
  sh('hdiutil', ['detach', MP, '-quiet'])
}

// 3. 校验通过后才清理旧版(只删同架构的旧版本 DMG,保留当前)
const keep = `DeepSeekHarness-macOS-arm64-${version}.dmg`
for (const f of fs.readdirSync(installers)) {
  if (/^DeepSeekHarness-macOS-arm64-.*\.dmg$/.test(f) && f !== keep) {
    fs.rmSync(path.join(installers, f), { force: true })
    console.log(`[make-dmg] 清理旧版: ${f}`)
  }
}
console.log(`[make-dmg] 完成,installers 保留: ${keep}`)
