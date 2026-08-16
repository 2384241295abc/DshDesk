// v3: FAST materialize. Pre-populate root node_modules/@deepseek-ai with all
// workspace packages (real dirs), then replace every junction with a real copy
// that SKIPS the target's node_modules (deps resolve up to root). No recursion
// into node_modules => no cycles, fast.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const H = process.argv[2]
if (!H) { console.error('usage: node materialize3.js <harnessRoot>'); process.exit(1) }
const DSAI = path.join(H, 'node_modules', '@deepseek-ai')

// 命中 <任意>/node_modules/@deepseek-ai 则跳过（根 node_modules/@deepseek-ai 已含全部 workspace 包，trim 也会清）
function isDsAiRedundant(p) {
  return path.basename(p) === '@deepseek-ai' && path.basename(path.dirname(p)) === 'node_modules'
}

// 复制目录树；跳过冗余的 @deepseek-ai，其余（含嵌套 node_modules 的非提升依赖，如 esbuild）
// 全部复制——早期版本整体跳过 node_modules 会丢 tsx 的 esbuild（版本冲突未提升到根）
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isDsAiRedundant(path.join(src, e.name))) continue
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else if (e.isSymbolicLink()) {
      let r, st
      try { r = fs.realpathSync(s); st = fs.statSync(r) } catch { continue }
      st.isDirectory() ? copyDir(r, d) : fs.copyFileSync(r, d)
    } else fs.copyFileSync(s, d)
  }
}

// 1. collect workspace packages
const pkgs = []
for (const g of fs.readdirSync(path.join(H, 'packages'))) {
  const gd = path.join(H, 'packages', g)
  if (!fs.statSync(gd).isDirectory()) continue
  for (const p of fs.readdirSync(gd)) {
    const pd = path.join(gd, p)
    if (fs.statSync(pd).isDirectory() && fs.existsSync(path.join(pd, 'package.json'))) pkgs.push(pd)
  }
}
for (const v of fs.readdirSync(path.join(H, 'vendor'))) {
  const vd = path.join(H, 'vendor', v)
  if (fs.statSync(vd).isDirectory() && fs.existsSync(path.join(vd, 'package.json'))) pkgs.push(vd)
}
console.error(`workspace packages: ${pkgs.length}`)

// 2. pre-populate root node_modules/@deepseek-ai
fs.mkdirSync(DSAI, { recursive: true })
for (const e of fs.readdirSync(DSAI)) {
  const p = path.join(DSAI, e)
  try { if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { force: true }) } catch {}
}
let copied = 0
for (const p of pkgs) {
  let name
  try { name = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).name } catch {}
  if (!name) continue
  const short = name.split('/')[1]
  copyDir(p, path.join(DSAI, short))
  copied++
}
console.error(`root @deepseek-ai populated: ${copied}`)

// 3. walk the tree, replace junctions with real copies (skip node_modules)
let replaced = 0, deleted = 0
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      let r, st
      try { r = fs.realpathSync(p); st = fs.statSync(r) } catch {
        // 失效链接：Windows 上目录 junction 用 unlinkSync 可能 EPERM，统一用 rmSync
        try { fs.rmSync(p, { force: true }); deleted++ } catch {}
        continue
      }
      if (st.isDirectory()) {
        // 目录符号链接/junction：rmSync 跨平台安全删除（旧版 unlinkSync 在 Windows junction 上有 EPERM 风险）
        fs.rmSync(p, { recursive: true, force: true })
        copyDir(r, p)
        replicateVirtualSiblings(r, p)
        replaced++
      } else {
        fs.rmSync(p, { force: true })
        fs.copyFileSync(r, p)
        replaced++
      }
    } else if (e.isDirectory()) {
      walk(p)
    }
  }
})(H)

console.log(`done. replaced ${replaced} links, deleted ${deleted} broken.`)

function copyOne(src, dst) {
  try {
    const st = fs.lstatSync(src)
    if (st.isSymbolicLink()) {
      const r = fs.realpathSync(src)
      fs.statSync(r).isDirectory() ? copyDir(r, dst) : fs.copyFileSync(r, dst)
    } else if (st.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
    return true
  } catch { return false }
}

// 把 scope 目录（@x）的缺失子包合并进已存在的目标 scope 目录
function mergeScope(srcScope, dstScope) {
  let entries
  try { entries = fs.readdirSync(srcScope, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const d2 = path.join(dstScope, e.name)
    if (fs.existsSync(d2)) continue
    copyOne(path.join(srcScope, e.name), d2)
  }
}

// 复制 pnpm 虚拟 node_modules 的兄弟依赖：目标被解引用后，其依赖
// 位于 .pnpm/<pkg>/node_modules/ 下（兄弟条目而非包内），需复制到目标位置的
// 对应 node_modules，否则 Node 向上查找依赖会失败。
// 处理两种布局：非 scoped 包（兄弟在虚拟 node_modules 层）与
// scoped 包（scope 层兄弟 + 虚拟 node_modules 层兄弟）。
function replicateVirtualSiblings(realDir, destDir) {
  const realScope = path.dirname(realDir)
  const realIsScope = path.basename(realScope).startsWith('@')
  const destScope = path.dirname(destDir)
  const destIsScope = path.basename(destScope).startsWith('@')
  const realVNM = realIsScope ? path.dirname(realScope) : realScope
  const destVNM = destIsScope ? path.dirname(destScope) : destScope
  if (path.basename(realVNM) !== 'node_modules') return

  // 1) scope 层兄弟（scoped store 包）：@scope 内的其他子包 → 目标 scope 目录
  if (realIsScope && destIsScope && realScope !== destScope) {
    let entries
    try { entries = fs.readdirSync(realScope, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === path.basename(realDir)) continue
      const d = path.join(destScope, e.name)
      if (fs.existsSync(d)) continue
      copyOne(path.join(realScope, e.name), d)
    }
  }

  // 2) 虚拟 node_modules 层兄弟 → 目标 node_modules（scope 目录已存在则合并）
  let entries
  try { entries = fs.readdirSync(realVNM, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === '.bin' || e.name === '@deepseek-ai') continue
    if (realIsScope && e.name === path.basename(realScope)) continue
    const s = path.join(realVNM, e.name)
    const d = path.join(destVNM, e.name)
    if (fs.existsSync(d)) {
      if (e.isDirectory() && e.name.startsWith('@') && fs.existsSync(s)) mergeScope(s, d)
      continue
    }
    copyOne(s, d)
  }
}

// 4. 修复 koffi 平台包解析：materialize 把 .pnpm 符号链接解引用为实体副本后，
//    koffi 加载器用 `../../../@koromix/koffi-<platform>` 相对 .pnpm 布局解析原生模块，
//    副本位置下会失效（报 "Cannot find the native Koffi module"）。
//    把 .pnpm store 中的平台包实体副本复制到每个 koffi 消费方副本的 node_modules/@koromix/ 下。
function replicateKoromix() {
  const platform = `${process.platform}-${process.arch}`
  const pnpmRoot = path.join(H, 'node_modules', '.pnpm')
  const storeDirs = fs.readdirSync(pnpmRoot).filter((n) => n.startsWith('@koromix+koffi-'))
  const storeDir = storeDirs.find((n) => n.includes(`koffi-${platform}`))
  if (!storeDir) return
  const srcPkg = path.join(pnpmRoot, storeDir, 'node_modules', '@koromix', `koffi-${platform}`)
  if (!fs.existsSync(srcPkg)) return
  let n = 0
  ;(function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (!e.isDirectory()) continue
      // 命中 node_modules/koffi（实体副本），在其旁复制 @koromix 平台包
      if (e.name === 'koffi' && path.basename(dir) === 'node_modules') {
        const dest = path.join(dir, '@koromix', `koffi-${platform}`)
        if (!fs.existsSync(dest)) {
          fs.cpSync(srcPkg, dest, { recursive: true })
          n++
        }
      } else {
        scan(p)
      }
    }
  })(H)
  if (n > 0) console.log(`replicated @koromix/koffi-${platform} next to ${n} koffi copies`)
}
replicateKoromix()

// 5. 最终补齐：walk 时序下部分虚拟兄弟依赖（如 scoped 包的 typebox）未被复制。
//    物化完成后重扫一遍：对每个 <node_modules>/<pkg> 实体包副本，从 .pnpm 虚拟目录
//    补齐缺失的兄弟依赖（esbuild/typebox/@koromix 等未提升项）。
function replicateAllVirtualSiblings() {
  const pnpmRoot = path.join(H, 'node_modules', '.pnpm')
  if (!fs.existsSync(pnpmRoot)) return
  // 预索引 .pnpm 虚拟 node_modules：name@version -> 真实目录（精确匹配，避免版本歧义）
  const storeIndex = new Map()
  for (const store of fs.readdirSync(pnpmRoot)) {
    const nm = path.join(pnpmRoot, store, 'node_modules')
    if (!fs.existsSync(nm)) continue
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      const base = e.isDirectory() ? e.name : null
      if (!base) continue
      const p = path.join(nm, base)
      if (base.startsWith('@')) {
        // scope 目录（无 package.json）：索引其下的 scoped 子包
        for (const e2 of fs.readdirSync(p, { withFileTypes: true })) {
          if (!e2.isDirectory()) continue
          const q = path.join(p, e2.name)
          const qj = path.join(q, 'package.json')
          if (!fs.existsSync(qj)) continue
          let v2
          try { v2 = JSON.parse(fs.readFileSync(qj, 'utf8')).version } catch { continue }
          storeIndex.set(`${base}/${e2.name}@${v2}`, q)
        }
      } else {
        const pj = path.join(p, 'package.json')
        if (!fs.existsSync(pj)) continue
        let ver
        try { ver = JSON.parse(fs.readFileSync(pj, 'utf8')).version } catch { continue }
        storeIndex.set(`${base}@${ver}`, p)
      }
    }
  }
  let replicated = 0
  ;(function scan(dir) {
    // 跳过 .pnpm store 自身与根 node_modules/@deepseek-ai 镜像（它们是源，无需补齐）
    if (path.basename(dir) === '.pnpm') return
    if (dir === DSAI) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      const parentIsNM = path.basename(dir) === 'node_modules'
      const parentIsScope = !parentIsNM && path.basename(path.dirname(dir)) === 'node_modules'
      if ((parentIsNM || parentIsScope) && fs.existsSync(path.join(p, 'package.json'))) {
        // p 是实体包副本（含 scoped 包）；用 name@version 精确找 .pnpm 源
        let name = parentIsNM ? e.name : `${path.basename(dir)}/${e.name}`
        let ver
        try { ver = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version } catch { ver = null }
        const real = ver ? storeIndex.get(`${name}@${ver}`) : undefined
        if (real && real !== p) {
          const before = fs.readdirSync(path.dirname(p)).length
          replicateVirtualSiblings(real, p)
          replicated += fs.readdirSync(path.dirname(p)).length - before
        }
      } else {
        scan(p)
      }
    }
  })(H)
  if (replicated > 0) console.log(`virtual siblings backfilled: ${replicated} entries`)
}
replicateAllVirtualSiblings()

// 5. 删除 .pnpm 虚拟 store：walk 已把全部符号链接解引用为实体副本，
//    依赖也已补齐到各消费方 node_modules，store 不再被引用——删除可省约一半体积
//    （缓解 CI 14GB 磁盘上限与产物体积）。
const pnpmStoreDir = path.join(H, 'node_modules', '.pnpm')
if (fs.existsSync(pnpmStoreDir)) {
  fs.rmSync(pnpmStoreDir, { recursive: true, force: true })
  console.log('removed node_modules/.pnpm store')
}

// verify: count reparse points
let links = 0
;(function scan(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) links++
    else if (e.isDirectory()) { try { scan(path.join(d, e.name)) } catch {} }
  }
})(H)
console.log(`remaining reparse points: ${links}`)
