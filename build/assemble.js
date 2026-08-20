'use strict'
// 组装桌面应用目录（跨平台版 assemble.ps1）
//   Windows: build/DeepSeekHarnessApp/DeepSeekHarness.exe + resources/
//   macOS:   build/DeepSeekHarnessApp/DeepSeekHarness.app（图标 .icns、Info.plist、ad-hoc 签名）
//   Linux:   build/DeepSeekHarnessApp/DeepSeekHarness/（二进制 DeepSeekHarness + resources/）
// 拷贝策略：Windows 用 robocopy（快），POSIX 用 cp -aL（解引用符号链接）
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname)
const proj = path.dirname(root)
// 可选第二个参数指定输出目录（默认 build/DeepSeekHarnessApp，测试时可指向别处）
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'DeepSeekHarnessApp')
const electronDist = path.join(proj, 'node_modules', 'electron', 'dist')
const platform = process.platform

function fail(msg) { console.error(`[assemble] ${msg}`); process.exit(1) }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }
function sh(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  // 所有子命令都是真实可执行文件（robocopy/rcedit/cp/sips/...），无需 shell
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (opts.check !== false && r.status !== 0) fail(`${cmd} failed (exit ${r.status})`)
  return r
}
// 把 src 目录的【内容】拷进 dstDir
function copyContents(src, dstDir, extraArgs = []) {
  fs.mkdirSync(dstDir, { recursive: true })
  if (platform === 'win32') {
    const r = sh('robocopy', [src, dstDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', ...extraArgs], { check: false })
    if (r.status !== null && r.status >= 8) fail(`robocopy ${src} -> ${dstDir} failed (exit ${r.status})`)
  } else {
    const r = sh('cp', ['-aL', `${src}${path.sep}.`, `${dstDir}${path.sep}`], { check: false })
    if (r.status !== 0) fail(`cp ${src} -> ${dstDir} failed (exit ${r.status})`)
  }
}

// harness 专用拷贝:POSIX 用 rsync 精确排除各 workspace 包内嵌 node_modules
// (运行时只从顶层 node_modules/@deepseek-ai 解析 —— materialize3 已把全部
// workspace 包复制到顶层;packages/*/*/node_modules 是构建期残留依赖 ~1.6GB,
// 纯冗余)。不能整棵排除 node_modules:顶层 node_modules 是运行时依赖。
// Windows 无 robocopy 等价精确排除,保持全量(CI 备用,不阻塞本地 macOS 构建)。
function copyHarness(src, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  if (platform === 'win32') {
    copyContents(src, dstDir)
  } else {
    const r = sh('rsync', ['-a', '--exclude', 'packages/*/*/node_modules',
      `${src}${path.sep}`, `${dstDir}${path.sep}`], { check: false })
    if (r.status !== 0) fail(`rsync harness -> ${dstDir} failed (exit ${r.status})`)
  }
}

// ---------- 增量指纹:harness/node/electron 未变则复用已有产物,只同步 app 层 ----------
const fpFile = path.join(out, '.assemble-fingerprint.json')
function newestMtime(dir) {
  let newest = 0
  ;(function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (e.name === '.assemble-fingerprint.json') continue
      const p = path.join(d, e.name)
      if (e.isSymbolicLink()) { try { newest = Math.max(newest, fs.statSync(p).mtimeMs) } catch { /* 悬空 */ } }
      else if (e.isDirectory()) walk(p)
      else { try { newest = Math.max(newest, fs.statSync(p).mtimeMs) } catch { /* 忽略 */ } }
    }
  })(dir)
  return newest
}
function electronVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(proj, 'node_modules', 'electron', 'package.json'), 'utf8')).version } catch { return 'unknown' }
}
function loadFp() {
  try { return JSON.parse(fs.readFileSync(fpFile, 'utf8')) } catch { return null }
}
function saveFp() {
  fs.writeFileSync(fpFile, JSON.stringify({
    electron: electronVersion(),
    harnessMtime: newestMtime(path.join(proj, 'resources', 'harness')),
    nodeMtime: newestMtime(path.join(proj, 'resources', 'node')),
    appMtime: newestMtime(path.join(proj, 'app')),
  }))
}
function computeCurrent() {
  return {
    electron: electronVersion(),
    harnessMtime: newestMtime(path.join(proj, 'resources', 'harness')),
    nodeMtime: newestMtime(path.join(proj, 'resources', 'node')),
    appMtime: newestMtime(path.join(proj, 'app')),
  }
}

// ---- 0. 校验 ----
const resDir = path.join(out, 'resources')
if (platform === 'win32') {
  if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) fail(`electron dist 不存在: ${electronDist}`)
  if (!fs.existsSync(path.join(proj, 'resources', 'node', 'node.exe'))) fail('node.exe 不存在: resources\\node')
} else if (platform === 'darwin') {
  if (!fs.existsSync(path.join(electronDist, 'Electron.app'))) fail(`Electron.app 不存在: ${electronDist}`)
} else {
  if (!fs.existsSync(path.join(electronDist, 'electron'))) fail(`electron dist 不存在: ${electronDist}`)
}
if (!fs.existsSync(path.join(proj, 'resources', 'harness', 'apps', 'cli', 'src', 'bin.ts'))) {
  fail('harness 目录不完整: resources\\harness')
}

const nodeSrc = path.join(proj, 'resources', 'node')
const harnessSrc = path.join(proj, 'resources', 'harness')
const appSrc = path.join(proj, 'app')

// 增量判定:产物存在 + 指纹匹配(electron/harness/node 均未变)→ 只更新 app 层,复用其余
const prev = loadFp()
const cur = computeCurrent()
const appDir = platform === 'darwin' ? path.join(out, 'DeepSeekHarness.app') : null
// app 内容统一放在 Contents/Resources/app(darwin)或 resources/app(win/linux)
const appResDir = platform === 'darwin'
  ? path.join(appDir, 'Contents', 'Resources', 'app')
  : path.join(resDir, 'app')
const appUpToDate = prev && prev.appMtime === cur.appMtime && fs.existsSync(appResDir)
const full = process.argv.includes('--full') || !prev ||
  prev.electron !== cur.electron ||
  prev.harnessMtime !== cur.harnessMtime ||
  prev.nodeMtime !== cur.nodeMtime ||
  !fs.existsSync(appDir ? path.join(appDir, 'Contents', 'Info.plist') : out)

if (!full && appUpToDate) {
  console.log('[assemble] 增量模式:harness/node/electron/app 均未变,复用现有产物,跳过全部拷贝')
} else if (!full) {
  console.log('[assemble] 增量模式:仅 app 层变化,复用 harness/node/electron,只同步 app')
  fs.mkdirSync(out, { recursive: true })
  // 同步 app 层(壳内视图页面等)
  const dstApp = platform === 'win32' ? path.join(resDir, 'app') : appResDir
  if (platform === 'win32') copyContents(appSrc, dstApp)
  else {
    fs.mkdirSync(dstApp, { recursive: true })
    const r = sh('rsync', ['-a', `${appSrc}${path.sep}`, `${dstApp}${path.sep}`], { check: false })
    if (r.status !== 0) fail(`rsync app -> ${dstApp} failed (exit ${r.status})`)
  }
} else {
  console.log('[assemble] 全量模式:harness/node/electron 有变化或首次构建')
  rmrf(out)
  fs.mkdirSync(out, { recursive: true })
  if (platform === 'darwin') fs.mkdirSync(path.join(out, 'DeepSeekHarness.app'), { recursive: true })
}

// ---- 1. Electron 运行时 + 应用 + node + harness ----
if (platform === 'win32') {
  if (full) {
    copyContents(electronDist, out, ['/XF', 'electron.exe'])
    fs.copyFileSync(path.join(electronDist, 'electron.exe'), path.join(out, 'DeepSeekHarness.exe'))
    copyContents(nodeSrc, path.join(resDir, 'node'))
    copyHarness(harnessSrc, path.join(resDir, 'harness'))
    copyContents(appSrc, path.join(resDir, 'app'))   // 🔴 full 模式必须拷 app 层,否则 Electron 显示默认页
  }
  if (!full && !appUpToDate) copyContents(appSrc, path.join(resDir, 'app'))
  // 便携版托盘图标：appIcon() 在 exe 同目录找 app.ico
  const ico = path.join(root, 'app.ico')
  if (fs.existsSync(ico)) fs.copyFileSync(ico, path.join(out, 'app.ico'))
  // Windows NapCat 一键启动脚本(用内置 node,用户免装 Node.js)
  const napcatBat = path.join(root, 'napcat-win.bat')
  if (fs.existsSync(napcatBat)) fs.copyFileSync(napcatBat, path.join(out, 'napcat-win.bat'))
  else console.warn('[assemble] 未找到 build/app.ico，便携版托盘图标将为空')
} else if (platform === 'darwin') {
  const macosDir = path.join(appDir, 'Contents', 'MacOS')
  // 复制 Electron.app 必须用 ditto（保留符号链接）：框架内部依赖
  // Versions/Current 等符号链接结构，cp -aL 解引用会破坏 .framework 布局，
  // 导致 codesign 报 "bundle format is ambiguous"
  if (full) {
    const staging = path.join(out, '_Electron.app')
    fs.mkdirSync(staging, { recursive: true })
    const d = sh('ditto', [path.join(electronDist, 'Electron.app'), staging], { check: false })
    if (d.status !== 0) fail(`ditto Electron.app failed (exit ${d.status})`)
    fs.renameSync(staging, appDir)
    fs.renameSync(path.join(macosDir, 'Electron'), path.join(macosDir, 'DeepSeekHarness'))
    copyContents(nodeSrc, path.join(appDir, 'Contents', 'Resources', 'node'))
    copyHarness(harnessSrc, path.join(appDir, 'Contents', 'Resources', 'harness'))
    copyContents(appSrc, appResDir)
  } else if (!appUpToDate) {
    fs.mkdirSync(appResDir, { recursive: true })
    const r = sh('rsync', ['-a', `${appSrc}${path.sep}`, `${appResDir}${path.sep}`], { check: false })
    if (r.status !== 0) fail(`rsync app -> ${appResDir} failed (exit ${r.status})`)
  }

  // 图标：icon-1024.png -> icon.icns（sips + iconutil），另放 PNG 供托盘使用
  // 缓存：icon-1024.png 未变且 icon.icns 已存在则跳过重建（sips×10 + iconutil 每次省数秒）
  const src1024 = path.join(root, 'icon-1024.png')
  if (!fs.existsSync(src1024)) fail(`缺少 ${src1024}（先运行 convert-icon.js）`)
  const icnsOut = path.join(root, 'icon.icns')
  const iconset = path.join(root, 'icon.iconset')
  const iconStale = !fs.existsSync(icnsOut) ||
    fs.statSync(src1024).mtimeMs > fs.statSync(icnsOut).mtimeMs
  if (iconStale) {
    rmrf(iconset)
    fs.mkdirSync(iconset, { recursive: true })
  const sizes = [
    ['16', '16', 'icon_16x16.png'], ['32', '32', 'icon_16x16@2x.png'],
    ['32', '32', 'icon_32x32.png'], ['64', '64', 'icon_32x32@2x.png'],
    ['128', '128', 'icon_128x128.png'], ['256', '256', 'icon_128x128@2x.png'],
    ['256', '256', 'icon_256x256.png'], ['512', '512', 'icon_256x256@2x.png'],
    ['512', '512', 'icon_512x512.png'], ['1024', '1024', 'icon_512x512@2x.png'],
  ]
  for (const [w, h, name] of sizes) {
    sh('sips', ['-z', w, h, src1024, '--out', path.join(iconset, name)])
  }
  sh('iconutil', ['-c', 'icns', iconset, '-o', icnsOut])
  rmrf(iconset)
  } else {
    console.log('[assemble] icon.icns 已是最新，跳过重建')
  }
  fs.copyFileSync(icnsOut, path.join(appResDir, 'icon.icns'))
  fs.copyFileSync(path.join(root, 'icon-256.png'), path.join(appResDir, 'icon.png'))

  // Info.plist
  const plist = path.join(appDir, 'Contents', 'Info.plist')
  sh('plutil', ['-replace', 'CFBundleName', '-string', 'DeepSeek Harness', plist])
  sh('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'DeepSeek Harness', plist])
  sh('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.deepseekai.harness.desktop', plist])
  sh('plutil', ['-replace', 'CFBundleExecutable', '-string', 'DeepSeekHarness', plist])
  sh('plutil', ['-replace', 'CFBundleIconFile', '-string', 'icon', plist])

  // ad-hoc 签名（Apple Silicon 必需，否则启动即被杀）。
  // macOS 15 上 codesign 对 Electron 的 .framework 报 "bundle format is ambiguous"：
  // 根因是框架 Info.plist 缺 CFBundlePackageType。处理：
  //  1) 给每个 .framework 补 CFBundlePackageType=FMWK
  //  2) 跳过符号链接，只签真实文件（.dylib/.node/无扩展名 Mach-O，深→浅）
  //  3) 再签 framework bundle → helper .app → 主程序 → 外层 app bundle
  function patchFrameworkTypes(frameworksDir) {
    if (!fs.existsSync(frameworksDir)) return
    for (const e of fs.readdirSync(frameworksDir, { withFileTypes: true })) {
      if (!(e.isDirectory() && e.name.endsWith('.framework'))) continue
      for (const pl of [
        path.join(frameworksDir, e.name, 'Resources', 'Info.plist'),
        path.join(frameworksDir, e.name, 'Versions', 'A', 'Resources', 'Info.plist'),
      ]) {
        if (!fs.existsSync(pl)) continue
        let r = sh('plutil', ['-insert', 'CFBundlePackageType', '-string', 'FMWK', pl], { check: false })
        if (r.status !== 0) sh('plutil', ['-replace', 'CFBundlePackageType', '-string', 'FMWK', pl])
      }
    }
  }
  function isMachO(p) {
    try {
      const fd = fs.openSync(p, 'r')
      const b = Buffer.alloc(4)
      fs.readSync(fd, b, 0, 4, 0)
      fs.closeSync(fd)
      const m = b.readUInt32BE(0)
      return m === 0xFEEDFACE || m === 0xFEEDFACF || m === 0xCAFEBABE ||
        m === 0xBEBAFECA || m === 0xCFFAEDFE || m === 0xCEFAEDFE || m === 0xFEEDFA11
    } catch { return false }
  }
  function adhocSign(appDir) {
    const files = []
    const frameworks = []
    const apps = []
    ;(function walk(dir) {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue // 符号链接跳过，真实文件会在原路径被遍历到
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name.endsWith('.framework')) frameworks.push(p)
          else if (e.name.endsWith('.app') && dir !== appDir) apps.push(p)
          walk(p)
        } else if (e.name.endsWith('.dylib') || e.name.endsWith('.node') || isMachO(p)) {
          files.push(p)
        }
      }
    })(appDir)
    patchFrameworkTypes(path.join(appDir, 'Contents', 'Frameworks'))
    files.sort((a, b) => b.length - a.length) // 深→浅
    for (const p of files) sh('codesign', ['--force', '-s', '-', p])
    for (const f of frameworks) sh('codesign', ['--force', '-s', '-', f])
    for (const a of apps) sh('codesign', ['--force', '-s', '-', a])
    sh('codesign', ['--force', '-s', '-', path.join(appDir, 'Contents', 'MacOS', 'DeepSeekHarness')])
    sh('codesign', ['--force', '-s', '-', appDir])
    console.log(`codesign: ${files.length} files + ${frameworks.length} frameworks + ${apps.length} apps + main + bundle`)
  }
  if (full || !appUpToDate) {
    adhocSign(appDir)
  } else {
    console.log('[assemble] 增量模式:app 未变,跳过 adhoc 签名(签名仍有效)')
  }
} else {
  if (full) {
    copyContents(electronDist, out)
    fs.renameSync(path.join(out, 'electron'), path.join(out, 'DeepSeekHarness'))
    copyContents(nodeSrc, path.join(resDir, 'node'))
    copyHarness(harnessSrc, path.join(resDir, 'harness'))
    copyContents(appSrc, path.join(resDir, 'app'))   // 🔴 full 模式必须拷 app 层(同 win32)
  }
  if (!full && !appUpToDate) copyContents(appSrc, path.join(resDir, 'app'))
  fs.copyFileSync(path.join(root, 'icon-256.png'), path.join(resDir, 'icon.png'))
}

// ---- 2. Windows 图标替换（rcedit，可选）----
if (platform === 'win32') {
  const rcedit = path.join(root, 'rcedit-x64.exe')
  const exe = path.join(out, 'DeepSeekHarness.exe')
  const ico = path.join(root, 'app.ico')
  if (fs.existsSync(rcedit) && fs.existsSync(ico)) {
    const r = sh(rcedit, [exe, '--set-icon', ico], { check: false })
    console.log(r.status === 0 ? 'rcedit: 图标已替换' : `rcedit: 退出码 ${r.status}（忽略）`)
  } else {
    console.log('rcedit 不存在，跳过图标替换')
  }
}

// ---- 3. 清理调试与冗余内容 ----
for (const p of [
  path.join(resDir, 'harness', '.dsh'),
  path.join(resDir, 'harness', '.turbo'),
  path.join(resDir, 'harness', 'pnpm-debug.log'),
]) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
}

// ---- 4. 报告(增量模式用 du 快速统计,避免逐文件遍历 10 万文件) ----
if (full) {
  let files = 0
  let size = 0
  ;(function scan(d) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) scan(p)
      else if (e.isFile() || e.isSymbolicLink()) {
        files++
        try { size += fs.statSync(p).size } catch { /* 忽略 */ }
      }
    }
  })(out)
  console.log('组装完成:', out)
  console.log(`  文件数: ${files}`)
  console.log(`  大小:   ${(size / 1024 / 1024).toFixed(1)} MB`)
} else {
  const r = spawnSync('du', ['-sk', out], { encoding: 'utf8' })
  const mb = r.stdout ? (parseInt(r.stdout.split(/\s+/)[0], 10) / 1024).toFixed(1) : '?'
  console.log('组装完成(增量):', out)
  console.log(`  大小:   ${mb} MB`)
}

// 写入指纹(增量模式依据;harness/node/electron/app 的 mtime + electron 版本)
saveFp()
console.log('[assemble] 指纹已保存,下次未变则走增量模式')
