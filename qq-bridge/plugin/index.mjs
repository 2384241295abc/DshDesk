/**
 * dsh-qq-bridge —— DeepSeek Harness × QQ (OneBot 11) 远程交互桥（MVP，纯 JS ESM，免构建）
 *
 * 方案 A：in-process Cordis 插件（研究报告 ② 推荐，用户已确认，PLAN.md §3.2）。
 * 数据流：QQ 消息 → OneBot WS → 本插件 → ctx.apiProxy.sessions.prompt（异步入队）
 *        → ctx.on('session/event') 流式事件 → 按 step 聚合 → OneBot 发回 QQ。
 *
 * 依赖：
 *  - OneBot 客户端：./onebot-client.mjs（无外部依赖，Node≥22 内置 WebSocket）
 *  - 宿主服务：ctx.apiProxy（sessions.create/prompt + respond）
 *  - 事件：ctx.on('session/event')（api-proxy 的 mux 即此转发）
 */

import { randomUUID } from 'node:crypto'
import { OneBotClient, OneBotError } from './onebot-client.mjs'

export const name = 'qq-bridge'
export const inject = ['apiProxy']

const DEFAULTS = {
  onebotWs: 'ws://127.0.0.1:6700',
  onebotToken: '',
  sessionCwd: '',
  ack: true,
  stallNoticeMs: 60000,
  forceFlushMs: 30000,
  autoAnswer: 'reject',        // 'reject' | 'allow-once'
  maxChunkLength: 3500,
}

/** QQ 会话 → DSH 会话 id（固定命名，重启后复用 Web UI 会话）。 */
export function qqSessionId(messageType, id) {
  return `qq-${messageType}-${id}`
}

export function apply(ctx, rawConfig = {}) {
  // 配置优先级：环境变量（桌面壳透传）> 补丁配置 > 默认值
  const config = {
    ...DEFAULTS,
    ...rawConfig,
    onebotWs: process.env.DSH_QQ_ONEBOT_WS || rawConfig.onebotWs || DEFAULTS.onebotWs,
    onebotToken: process.env.DSH_QQ_ONEBOT_TOKEN || rawConfig.onebotToken || DEFAULTS.onebotToken,
  }
  const bot = new OneBotClient({
    url: config.onebotWs,
    token: config.onebotToken,
  })

  /** sessionId -> 缓冲队列（连续消息各自成条目，回合结束消费队头） */
  const buffers = new Map()
  /** qqKey -> sessionId（幂等建会话） */
  const sessionIds = new Map()

  /** 取会话的活跃缓冲（队头未完成条目）；无则返回 undefined */
  function activeBuffer(sessionId) {
    const list = buffers.get(sessionId)
    if (!list) return undefined
    return list.find((b) => !b.done)
  }

  // ---------- QQ → DSH ----------

  async function onQqMessage(msg) {
    const text = OneBotClient.extractText(msg.message)
    if (!text) return
    const target = {
      message_type: msg.message_type,          // 'group' | 'private'
      group_id: msg.group_id,
      user_id: msg.user_id,
    }
    const qqKey = qqSessionId(msg.message_type, msg.group_id ?? msg.user_id)
    try {
      let sessionId = sessionIds.get(qqKey)
      if (!sessionId) {
        sessionId = await ensureSession(qqKey, config.sessionCwd)
        sessionIds.set(qqKey, sessionId)
      }
      if (config.ack) {
        await bot.sendText(target, '📥 已收到，开始处理…').catch(() => {})
      }
      // 异步入队（accepted 即返回；回复走事件流）。带 rpcId（契约要求）+ 对瞬时拒绝重试。
      let lastErr = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const { result } = await ctx.apiProxy.sessions.prompt({
          rpcId: randomUUID(),
          payload: {
            sessionId, mode: 'queue',
            content: [{ type: 'text', text }],
          },
        })
        if (result.ok) {
          // 入队：连续消息各自一个缓冲条目，回复按序回传（不会被后到的消息覆盖）
          const list = buffers.get(sessionId) || []
          list.push({ sessionId, qqTarget: target, steps: [], chunks: [], lastFlush: Date.now(), done: false })
          buffers.set(sessionId, list)
          ctx.logger.info('[qq-bridge] queued "%s" -> %s (buffers=%d)', text.slice(0, 40), sessionId, list.length)
          return
        }
        lastErr = result.error
        const retryable = lastErr?.code === 'model-unavailable' || lastErr?.code === 'agent-busy' || lastErr?.code === 'session-not-found'
        if (!retryable || attempt === 2) break
        ctx.logger.warn('[qq-bridge] prompt %s (attempt %d)，重试…', lastErr?.code, attempt + 1)
        await new Promise((r) => setTimeout(r, 800))
      }
      throw new Error(`${lastErr?.code || 'unknown'}: ${lastErr?.message || JSON.stringify(lastErr) || 'prompt rejected'}`)
    } catch (err) {
      ctx.logger.warn('[qq-bridge] prompt failed: %s', err.message)
      await bot.sendText(target, `⚠️ 发送失败：${err.message}`).catch(() => {})
    }
  }

  async function ensureSession(qqKey, cwd) {
    const api = ctx.apiProxy
    const { result } = await api.sessions.list({ rpcId: randomUUID(), payload: {} })
    const items = result.ok ? result.value.items : []
    const found = items.find((it) => it.sessionId === qqKey)
    if (found) return found.sessionId
    const created = await api.sessions.create({
      rpcId: randomUUID(),
      payload: { sessionId: qqKey, cwd: cwd || process.cwd(), blank: true },
    })
    if (!created.result.ok) throw new Error(`${created.result.error?.code}: ${created.result.error?.message || 'session.create failed'}`)
    return created.result.value.sessionId
  }

  // ---------- DSH → QQ ----------

  async function onSessionEvent(sessionId, event) {
    switch (event.type) {
      case 'assistant/chunk': {
        const buf = activeBuffer(sessionId)
        if (!buf || event.data.chunk.type !== 'text-delta') return
        buf.chunks.push(event.data.chunk.text)
        if (Date.now() - buf.lastFlush > config.forceFlushMs) await flush(buf, false)
        break
      }
      case 'assistant/message': {
        const buf = activeBuffer(sessionId)
        if (!buf) return
        const text = (event.data.message?.content ?? [])
          .filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
        if (text) buf.steps.push(text)
        buf.chunks = []
        buf.lastFlush = Date.now()
        break
      }
      case 'turn/end': {
        const list = buffers.get(sessionId)
        const buf = list && list.shift()   // 队头 = 当前回合
        if (!buf) return
        buf.done = true
        await flush(buf, true, event.data.reason?.kind)
        if (list.length === 0) buffers.delete(sessionId)
        break
      }
      case 'question/requested': await onQuestion(sessionId, event.data); break
      case 'approval/requested': await onApproval(sessionId, event.data); break
    }
  }

  async function flush(buf, done, reason) {
    const text = buf.steps.join('\n\n').trim() || buf.chunks.join('').trim()
    if (!text) return
    if (done) {
      for (let i = 0; i < text.length; i += config.maxChunkLength) {
        await bot.sendText(buf.qqTarget, text.slice(i, i + config.maxChunkLength)).catch(() => {})
      }
      if (reason && reason !== 'completed') {
        await bot.sendText(buf.qqTarget, `（回合结束：${reason}）`).catch(() => {})
      }
    } else {
      await bot.sendText(buf.qqTarget, `…（已产出 ${text.length} 字，继续处理中）`).catch(() => {})
    }
    buf.lastFlush = Date.now()
  }

  /** question/requested：必须应答否则回合挂起；按 autoAnswer 策略。 */
  async function onQuestion(sessionId, data) {
    const buf = activeBuffer(sessionId)
    const target = buf?.qqTarget
    const allow = config.autoAnswer === 'allow-once'
    const question = data.question?.text ?? JSON.stringify(data).slice(0, 200)
    try {
      await ctx.apiProxy.respond({
        rpcId: randomUUID(),
        payload: {
          sessionId,
          answer: {
            answers: (data.question?.answers ?? []).map((a) => ({
              id: a.id,
              selected: allow ? [a.answers?.[0]?.id].filter(Boolean) : [],
            })),
          },
        },
      })
    } catch (err) {
      ctx.logger.warn('[qq-bridge] respond(question) failed: %s', err.message)
    }
    if (target) {
      await bot.sendText(target, allow
        ? `🤖 已自动回答提问：${question}`
        : `⚠️ 模型在等您确认（QQ 端暂不支持提问）：${question}\n已按"拒绝"继续。请到 Web 界面处理。`).catch(() => {})
    }
  }

  /** approval/requested：按 autoAnswer 策略自动应答。 */
  async function onApproval(sessionId, data) {
    const buf = activeBuffer(sessionId)
    const target = buf?.qqTarget
    const allow = config.autoAnswer === 'allow-once'
    try {
      await ctx.apiProxy.respond({
        rpcId: randomUUID(),
        payload: { sessionId, approvalId: data.approvalId, outcome: allow ? 'allowed-once' : 'rejected' },
      })
    } catch (err) {
      ctx.logger.warn('[qq-bridge] respond(approval) failed: %s', err.message)
    }
    if (target) {
      await bot.sendText(target, allow
        ? '🤖 已自动允许本次工具调用。'
        : '⚠️ 模型请求了工具调用审批（QQ 端暂不支持），已自动拒绝。请到 Web 界面处理。').catch(() => {})
    }
  }

  // ---------- 接线 ----------

  bot.on('message', (msg) => { void onQqMessage(msg) })
  bot.on('error', (err) => ctx.logger.warn('[qq-bridge] onebot: %s', err.message))
  bot.on('reconnecting', (r) => ctx.logger.info('[qq-bridge] 重连中: %j', r))
  bot.connect()

  ctx.on('session/event', (session, event) => {
    void onSessionEvent(session.id, event).catch((err) =>
      ctx.logger.warn('[qq-bridge] event: %s', err.message))
  })

  ctx.on('dispose', () => { bot.close() })

  ctx.logger.info('[qq-bridge] 已启动，OneBot WS: %s', config.onebotWs)
}
