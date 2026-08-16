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
const QQ_E2E = args.includes('--qq-e2e')   // 可选：端到端验证 QQ 桥（mock OneBot + mock LLM）

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

    // ---- 3.5 可选：QQ 桥端到端（mock OneBot + mock LLM，验证注入插件在产物中可用） ----
    if (QQ_E2E && !failed) {
      // 先停掉启动检查实例（避免其插件抢占 mock OneBot 连接）
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
      } catch { /* ignore */ }
      await qqE2E(childEnv)
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

// QQ 桥端到端：mock LLM + mock OneBot → 组装产物（内置 Node + 注入插件）→ 回复回传
async function qqE2E(baseEnv) {
  const LLM_PORT = 8010
  const ONE_BOT = 6700
  const E2E_HOME = path.join(require('node:os').tmpdir(), `dsh-e2e-${process.pid}`)
  const procs = []
  const killAll = () => {
    for (const p of procs) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
        else { try { process.kill(-p.pid, 'SIGTERM') } catch {} }
      } catch { /* ignore */ }
    }
  }
  const waitFor = async (fn, ms, label) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await new Promise((r) => setTimeout(r, 1500))
    }
    console.error(`[smoke] QQ-E2E 超时: ${label}`)
    return false
  }

  console.log('[smoke] QQ-E2E: 启动 mock LLM + mock OneBot …')
  // mock LLM（用内置 Node + 产物内 llm-mock-server）
  const llm = spawn(node, ['--import', 'tsx/esm', 'packages/test-support/llm-mock-server/src/bin.ts',
    '--port', String(LLM_PORT), '--api-key', 'mock-key', '--sequence', 'success', '--repeat-last'], {
    cwd: harness, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  })
  procs.push(llm)
  let llmOut = ''
  llm.stdout.on('data', (d) => { llmOut += d })
  llm.stderr.on('data', (d) => { llmOut += d })
  const llmReady = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer mock-key' },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'ping' }] }) })
      return r.ok
    } catch { return false }
  }, 60000, 'mock LLM 就绪')
  if (!llmReady) fail('mock LLM 未就绪')

  // mock OneBot（用系统 node；ws 从产物内解析）
  const mockPath = path.join(proj, 'qq-bridge', 'test', 'mock-onebot.mjs')
  const wsProbe = [path.join(harness, 'node_modules', '.pnpm', 'node_modules', 'ws'),
    path.join(harness, 'node_modules', 'ws')].find((p) => fs.existsSync(p))
  if (!wsProbe) console.error('[smoke] QQ-E2E 警告: 未在产物中找到 ws，mock OneBot 可能无法启动')
  const onebot = spawn(process.execPath, [mockPath, '--port', String(ONE_BOT), '--script', 'private:10001:QQ桥端到端测试'], {
    cwd: proj, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...baseEnv, WS_PATH: wsProbe || '' },
  })
  procs.push(onebot)
  let oneOut = ''
  onebot.stdout.on('data', (d) => { oneOut += d })
  onebot.stderr.on('data', (d) => { oneOut += d })

  // 组装产物 harness（独立 DSH_HOME + 指向 mock LLM；插件经 DSH_QQ_ONEBOT_WS 指向 mock OneBot）
  const env = { ...baseEnv, DSH_HOME: E2E_HOME,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`, DEEPSEEK_API_KEY: 'mock-key',
    DSH_QQ_ONEBOT_WS: `ws://127.0.0.1:${ONE_BOT}` }
  const e2ePort = 3082
  const h = spawn(node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', String(e2ePort)], {
    cwd: harness, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32', env,
  })
  procs.push(h)
  let hOut = ''
  h.stdout.on('data', (d) => { hOut += d })
  h.stderr.on('data', (d) => { hOut += d })

  const gotReply = await waitFor(() => oneOut.includes('QQ 收到回复') && oneOut.includes('mock response recovered'), 180000, '等待 QQ 回复')
  if (gotReply) console.log('[smoke] QQ-E2E OK: 私聊消息 → 回复回传')
  else {
    fail(`QQ 桥端到端未收到回复\n[llm] ${llmOut.slice(-600)}\n[onebot] ${oneOut.slice(-600)}\n[harness] ${hOut.slice(-600)}`)
  }
  killAll()
}

// 原生模块/环境检查失败时直接退出（不进入启动阶段）
if (failed) process.exit(1)
