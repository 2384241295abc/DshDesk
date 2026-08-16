'use strict'
// 克隆 deepseek-harness（锁定上游 commit）、注入 dsh-qq-bridge 插件并构建（跨平台）
//
//  - 锁定上游：默认克隆固定 SHA（47f943859bef60e4160492346772ded9b24f765a，dsh 0.1.0-rc.5），
//    可用环境变量 HARNESS_COMMIT 覆盖；仓库地址 HARNESS_REPO 可覆盖
//  - 插件注入：把 qq-bridge/plugin 作为 workspace 包打入 packages/qq/dsh-qq-bridge，
//    挂进 apps/cli 依赖（healProfilesModuleFallback 会把它软链进 profiles/node_modules），
//    并把包名追加进 PROFILE_TEMPLATES.web（新 profile 自动加载该 bundle 层）
//  - pnpm 11 + hoisted linker（与上游一致；pnpm 10 不识别 allowBuilds，会静默丢原生模块）
//  - 构建完成后删除 .git（减小打包体积）
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const proj = path.dirname(path.resolve(__dirname))
const h = path.join(proj, 'resources', 'harness')

const HARNESS_REPO = process.env.HARNESS_REPO || 'https://github.com/deepseek-ai/deepseek-harness.git'
// 锁定 dsh 0.1.0-rc.5（deepseek-harness master 2026-08 的稳定发布点）
const HARNESS_COMMIT = process.env.HARNESS_COMMIT || '47f943859bef60e4160492346772ded9b24f765a'
// 本地源覆盖：github 不可达时（如离线/受限网络），可指向本机已有 checkout
// （如 HARNESS_SOURCE=/path/to/deepseek-harness），从本地仓库克隆到锁定版本
const LOCAL_SOURCE = process.env.HARNESS_SOURCE || ''
// 存在则复用本地目录（HARNESS_FORCE=1 强制重拉）
const FORCE = process.env.HARNESS_FORCE === '1'

function run(cmd, args, cwd, { allowFail = false } = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0 && !allowFail) {
    console.error(`[build-harness] ${cmd} failed (exit ${r.status})`)
    process.exit(1)
  }
  return r.status === 0
}

// ---------- 1. 获取锁定版本的上游 ----------
if (FORCE && fs.existsSync(h)) fs.rmSync(h, { recursive: true, force: true })

if (!fs.existsSync(path.join(h, 'package.json'))) {
  if (LOCAL_SOURCE) {
    // 本地源：直接拷贝工作树（排除 .git/node_modules，随后 pnpm install/build 重建依赖）。
    // 要求本地源已检出目标版本（可用 HARNESS_COMMIT 校验提示）。
    console.log(`[build-harness] 使用本地源: ${LOCAL_SOURCE}`)
    if (!fs.existsSync(path.join(LOCAL_SOURCE, 'package.json'))) {
      console.error(`[build-harness] 本地源缺少 package.json: ${LOCAL_SOURCE}`)
      process.exit(1)
    }
    fs.cpSync(LOCAL_SOURCE, h, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src)
        return base !== '.git' && base !== 'node_modules'
      },
    })
    console.log(`harness copied from local source (lock: ${HARNESS_COMMIT})`)
  } else {
    run('git', ['init', h], proj)
    run('git', ['-C', h, 'remote', 'add', 'origin', HARNESS_REPO], proj)
    // GitHub 支持按任意 SHA 浅拉取；FETCH_HEAD 即锁定版本
    run('git', ['-C', h, 'fetch', '--depth', '1', 'origin', HARNESS_COMMIT], proj)
    run('git', ['-C', h, 'checkout', 'FETCH_HEAD'], proj)
    console.log(`harness fetched at ${HARNESS_COMMIT}`)
  }
} else {
  console.log('[build-harness] 复用现有 resources/harness（如需重拉设置 HARNESS_FORCE=1）')
}

// ---------- 2. 注入 dsh-qq-bridge 插件（workspace 包） ----------
const pluginSrc = path.join(proj, 'qq-bridge', 'plugin')
const pluginDest = path.join(h, 'packages', 'qq', 'dsh-qq-bridge')
if (fs.existsSync(pluginSrc)) {
  fs.rmSync(pluginDest, { recursive: true, force: true })
  fs.cpSync(pluginSrc, pluginDest, { recursive: true })
  console.log('[build-harness] 插件已注入 -> packages/qq/dsh-qq-bridge')

  // tsdown 根构建会把每个 workspace 包当目标（entry: lib/types/{index,invariant,startup}.js）。
  // 插件是纯 JS ESM（真实入口 index.mjs），补桩文件让根构建通过；tsdown 产物不使用。
  const stubDir = path.join(pluginDest, 'lib', 'types')
  fs.mkdirSync(stubDir, { recursive: true })
  const stubNote = '// stub: 让根 tsdown 构建通过（真实入口 index.mjs，不经 tsdown 打包）\n'
  fs.writeFileSync(path.join(stubDir, 'index.js'), stubNote)
  fs.writeFileSync(path.join(stubDir, 'invariant.js'), stubNote)
  fs.writeFileSync(path.join(stubDir, 'startup.js'), stubNote)
  console.log('[build-harness] 插件 tsdown 桩文件已生成')

  // apps/cli 依赖：healProfilesModuleFallback 以 apps/cli/package.json 为锚点
  // BFS 依赖闭包并软链进 $DSH_HOME/profiles/node_modules，插件由此可被 Loader 解析
  const cliPkgPath = path.join(h, 'apps', 'cli', 'package.json')
  const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf8'))
  cliPkg.dependencies = cliPkg.dependencies || {}
  cliPkg.dependencies['@dsh-qq/qq-bridge'] = 'workspace:^'
  fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + '\n')
  console.log('[build-harness] apps/cli 依赖已挂 @dsh-qq/qq-bridge')

  // PROFILE_TEMPLATES.web：新 profile 自动带上本 bundle 层（默认配置可被用户补丁覆盖）
  const profileTs = path.join(h, 'packages', 'boot', 'app-boot', 'src', 'profile.ts')
  const marker = "web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],"
  let src = fs.readFileSync(profileTs, 'utf8')
  if (!src.includes('@dsh-qq/qq-bridge')) {
    if (!src.includes(marker)) {
      console.error('[build-harness] profile.ts 结构变化，无法自动注册插件 bundle（需手动核对）')
      process.exit(1)
    }
    src = src.replace(marker, "web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-qq/qq-bridge'],")
    fs.writeFileSync(profileTs, src)
    console.log('[build-harness] PROFILE_TEMPLATES.web 已含 @dsh-qq/qq-bridge')
  }

  // tsdown 根配置：排除纯 JS 插件包（它没有 lib/types/* 入口，会被根构建当成目标而失败）
  const tsdownCfg = path.join(h, 'tsdown.config.ts')
  let tsrc = fs.readFileSync(tsdownCfg, 'utf8')
  if (!tsrc.includes('dsh-qq-bridge')) {
    const wm = "workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],"
    if (!tsrc.includes(wm)) {
      console.error('[build-harness] tsdown.config.ts 结构变化，无法排除插件包（需手动核对）')
      process.exit(1)
    }
    tsrc = tsrc.replace(wm,
      "workspace: ['vendor/*', 'packages/*/*', 'apps/cli'].filter((p) => !p.includes('dsh-qq-bridge')),")
    fs.writeFileSync(tsdownCfg, tsrc)
    console.log('[build-harness] tsdown workspace 已排除 @dsh-qq/qq-bridge')
  }
} else {
  console.warn('[build-harness] 未找到 qq-bridge/plugin，跳过插件注入')
}

// ---------- 3. pnpm 11 + hoisted ----------
fs.writeFileSync(path.join(h, '.npmrc'), 'manage-package-manager-versions=false\nnode-linker=hoisted\n')
run('pnpm', ['install', '--no-frozen-lockfile'], h)
run('pnpm', ['run', 'build'], h)

fs.rmSync(path.join(h, '.git'), { recursive: true, force: true })
console.log('harness ready:', h)
