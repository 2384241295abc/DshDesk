'use strict'
// 精简 harness（跨平台版 trim.ps1）
//  1. 删除残留的目标 harness（build/DeepSeekHarnessApp/resources/harness）
//  2. 删除每个包 node_modules 里冗余的 @deepseek-ai 副本
//     （根 node_modules/@deepseek-ai 已含全部 workspace 包）
//  3. web 前端产物 -> node_modules/@deepseek-ai/dsh-web-frontend
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname)
const proj = path.dirname(root)
const h = path.join(proj, 'resources', 'harness')
// 可选参数指定"残留 dest harness"清理目标（默认 build/DeepSeekHarnessApp/resources/harness）。
// 🔴 该默认目录可能是运行中应用的后端 cwd：rmSync 递归删除会先清光文件、
// 最后 rmdir cwd 才 EBUSY——catch 只防崩溃不防部分破坏现役运行时。装配到
// 暂存目录时必须传 argv[2] 指向安全路径（见 assemble.js 同款参数模式）。
const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'DeepSeekHarnessApp', 'resources', 'harness')

// 1. 删除残留的目标 harness（若被占用——如应用正在运行——则告警跳过）
try {
  fs.rmSync(out, { recursive: true, force: true })
  console.log('removed partial dest')
} catch (e) {
  console.warn(`跳过删除残留 dest（可能被占用）: ${out}\n  ${e.message}`)
}

// 2. 删除每个包 node_modules 里冗余的 @deepseek-ai
let removed = 0
function walkDirs(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (!e.isDirectory()) continue
    if (e.name === 'node_modules') {
      const dsai = path.join(p, '@deepseek-ai')
      if (fs.existsSync(dsai)) {
        fs.rmSync(dsai, { recursive: true, force: true })
        removed++
      }
    } else {
      walkDirs(p)
    }
  }
}
for (const sub of ['packages', 'apps', 'vendor', 'examples', 'website', 'native', 'python']) {
  const base = path.join(h, sub)
  if (fs.existsSync(base)) walkDirs(base)
}
console.log(`removed redundant @deepseek-ai dirs: ${removed}`)

// 3. web-app 前端产物 -> node_modules/@deepseek-ai/dsh-web-frontend
const feSrc = path.join(h, 'apps', 'web')
const feDst = path.join(h, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
if (fs.existsSync(feSrc)) {
  fs.rmSync(feDst, { recursive: true, force: true })
  fs.cpSync(feSrc, feDst, {
    recursive: true,
    dereference: true,
    filter: (s) => !s.split(path.sep).includes('node_modules'),
  })
}
console.log('web-frontend copied:', fs.existsSync(path.join(feDst, 'dist', 'index.html')))

// 4. 统计源文件数
let files = 0
;(function count(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) count(p)
    else if (e.isFile() || e.isSymbolicLink()) files++
  }
})(h)
console.log(`source after trim: ${files} files`)

// 5. 删除非运行时目录（文档/示例/测试支撑等），显著减小产物体积
// 注意：native/ 是运行时依赖（@deepseek-ai/node-addon-landlock-run，sandbox-local 无条件 import），不可删
const NON_RUNTIME_DIRS = [
  'website',        // 文档站点
  'python',         // Python SDK（桌面壳为 Node 运行时）
  'docs',           // 文档源码
  'assets',         // 文档素材
  'examples',       // 演示样例
  'scripts',        // 构建期脚本
]
let removedDirs = 0
for (const d of NON_RUNTIME_DIRS) {
  const p = path.join(h, d)
  if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removedDirs++ }
}
// 测试支撑与演示包（冒烟测试已改用内置 mock，不再依赖）
for (const d of ['test-support', 'examples']) {
  const p = path.join(h, 'packages', d)
  if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removedDirs++ }
}
if (removedDirs > 0) console.log(`trimmed non-runtime dirs: ${removedDirs}`)

// 6. 删除运行期不需要的类型声明与 sourcemap（*.d.ts / *.map 等）：
//    既缓解 Windows 打包的长路径压力，也减小产物体积
let prunedFiles = 0
;(function pruneTypes(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) pruneTypes(p)
    else if (/\.(d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(e.name) || (e.name.endsWith('.map') && !e.name.endsWith('.wasm.map'))) {
      try { fs.rmSync(p, { force: true }); prunedFiles++ } catch {}
    }
  }
})(h)
if (prunedFiles > 0) console.log(`pruned type/map files: ${prunedFiles}`)
