'use strict'
// 冒烟测试：验证组装产物可运行（CI 每平台执行；本地也可手动跑）
//  1) 内置 Node 可执行
//  2) 原生模块存在（node-pty/koffi —— pnpm 10/11 错配会在此静默暴露）
//  3) vendored harness 用内置 Node 启动 dsh web，探测 3080 含 __DSH_BOOT__
//  4) 正常退出（进程组清理）
//
// 用法: node build/smoke-test.js [--app build/DeepSeekHarnessApp] [--port 3081]
// 退出码: 0 通过；非 0 失败（CI 据此判定）
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname)
const proj = path.dirname(root)

const args = process.argv.slice(2)
const appDir = args.includes('--app') ? path.resolve(args[args.indexOf('--app') + 1]) : path.join(root, 'DeepSeekHarnessApp')
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 3081

const resDir = process.platform === 'darwin'
  ? path.join(appDir, 'DeepSeekHarness.app', 'Contents', 'Resources')   // macOS: 资源在 .app 内
  : path.join(appDir, 'resources')                                       // win32/linux: 与应用同级
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const node = path.join(resDir, 'node', nodeName)
const harness = path.join(resDir, 'harness')
let failed = false
const fail = (msg) => { console.error(`[smoke] FAIL: ${msg}`); failed = true }

function checkExists(p, what) {
  if (!fs.existsSync(p)) { fail(`${what} 缺失: ${p}`); return false }
  return true
}

// ---- 1/2. 内置 Node + 原生模块 ----
if (!checkExists(node, '内置 Node')) process.exit(1)
if (!checkExists(path.join(harness, 'apps', 'cli', 'src', 'bin.ts'), 'harness')) process.exit(1)

console.log(`[smoke] 内置 Node: ${node}`)
// 原生模块检查：从真正依赖它们的包目录解析（hoisted 布局下根目录 resolve 不到）
//   node-pty -> packages/subprocess/subprocess-local
//   koffi    -> packages/fs/fs-local
const nativeChecks = [
  { pkg: 'packages/subprocess/subprocess-local', mod: 'node-pty', probe: 'spawn' },
  { pkg: 'packages/fs/fs-local', mod: 'koffi', probe: 'address' },
]
for (const { pkg, mod, probe } of nativeChecks) {
  const pkgDir = path.join(harness, pkg)
  if (!fs.existsSync(pkgDir)) { fail(`原生模块检查包缺失: ${pkg}`); continue }
  const r = spawnSync(node, ['-e',
    `const m=require('${mod}'); if (typeof m.${probe} !== 'function' && typeof m.${probe} !== 'object') throw new Error('probe failed'); console.log('native OK: ${mod}')`,
  ], { cwd: pkgDir, encoding: 'utf8' })
  if (r.status !== 0) {
    fail(`原生模块 ${mod} 缺失/加载失败（pnpm 构建脚本未跑?）:\n${r.stderr || r.stdout}`)
  } else {
    console.log(r.stdout.trim())
  }
}

// ---- 3. 启动 dsh web 并探测 ----
if (!failed) {
  console.log(`[smoke] 启动 dsh web (port ${port})…`)
  // DSH_HOME 透传（本地受限环境可隔离到 /tmp；CI 默认真实 home）
  const childEnv = { ...process.env }
  if (process.env.DSH_HOME) childEnv.DSH_HOME = process.env.DSH_HOME
  const child = spawn(node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', String(port)], {
    cwd: harness, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
    env: childEnv,
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })

  const marker = '__DSH_BOOT__'
  const deadline = Date.now() + 90000
  ;(async () => {
    let ok = false
    while (Date.now() < deadline && !ok && child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        if (res.ok) {
          const body = await res.text()
          if (body.includes(marker)) ok = true
        }
      } catch { /* 未就绪 */ }
      if (!ok) await new Promise((r) => setTimeout(r, 1500))
    }
    if (ok) {
      console.log(`[smoke] OK: http://127.0.0.1:${port} 返回 ${marker}`)
    } else {
      fail(`dsh web 未在 ${(deadline - Date.now() + 90000) / 1000}s 内就绪（exit=${child.exitCode}）\n${out.slice(-2000)}`)
    }
    // ---- 4. 清理（进程组）----
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        process.kill(-child.pid, 'SIGTERM')
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 4000)
      }
    } catch { /* 已退出 */ }
    setTimeout(() => { process.exit(failed ? 1 : 0) }, 4500)
  })()
}
if (failed) process.exit(1)
