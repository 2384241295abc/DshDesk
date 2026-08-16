/**
 * dsh-qq-bridge —— DeepSeek Harness × QQ (OneBot 11) 远程交互桥（草稿）
 *
 * 方案：in-process Cordis 插件（研究报告 ② 推荐，PLAN.md §3.2）。
 * 数据流：QQ 消息 → OneBot WS → 插件 → session.prompt（异步入队）
 *        → ctx.on('session/event') 流式事件 → 按 step 聚合 → OneBot 发回 QQ。
 *
 * 状态：DRAFT（M2 实现骨架，待挂载点决策确认后进入 monorepo 并接线）
 *
 * 依赖约定：
 *  - OneBot 客户端：qq-bridge/onebot-client.mjs（无外部依赖，Node≥22）
 *  - 宿主服务：ctx.apiProxy（sessions.create/prompt + respond）
 *  - 事件：ctx.on('session/event')（api-proxy 的 mux 即此转发，见 api-proxy.ts）
 *
 * @module dsh-qq-bridge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-apiproxy' // ctx.apiProxy
import { OneBotClient, OneBotError } from './onebot-client.js'

export const name = 'qq-bridge'
export const inject = ['apiProxy']

/** 会话映射：QQ 会话 → DSH 会话 id。固定命名，重启后复用 Web UI 会话。 */
export function qqSessionId(messageType: string, id: number | string): string {
  return `qq-${messageType}-${id}`
}

/** 一次 QQ 消息触发的回合的流式累积器。 */
interface TurnBuffer {
  sessionId: string
  qqTarget: { message_type: string; group_id?: number; user_id?: number }
  steps: string[]       // 每 step 最终文本（assistant/message）
  chunks: string[]      // 当前 step 的 text-delta 累积
  lastFlush: number
  done: boolean
}

export interface Config {
  /** OneBot 正向 WS 地址，如 ws://127.0.0.1:6700 */
  onebotWs: string
  /** OneBot access token（可选） */
  onebotToken?: string
  /** 新建 DSH 会话的工作目录 */
  sessionCwd: string
  /** 收到 QQ 消息是否先回执"已收到" */
  ack: boolean
  /** 收到消息后多久未产出新文本视为卡住（ms），超时发进度提示 */
  stallNoticeMs: number
  /** 回合结束多久未发完则强制发送（ms） */
  forceFlushMs: number
  /**
   * 模型发起 question/approval 时的策略：
   *  - 'reject'    拒绝并把问题原文发到 QQ（回合继续，推荐，默认）
   *  - 'allow-once' 自动允许一次（仅自用/可信场景）
   */
  autoAnswer: 'reject' | 'allow-once'
  /** 回复分片长度（QQ 单条消息上限附近留余量） */
  maxChunkLength: number
}

export const Config: z<Config> = z.object({
  onebotWs: z.string().required(),
  onebotToken: z.string().default(''),
  sessionCwd: z.string().default(process.cwd()),
  ack: z.boolean().default(true),
  stallNoticeMs: z.number().default(60000),
  forceFlushMs: z.number().default(30000),
  autoAnswer: z.union(['reject', 'allow-once']).default('reject'),
  maxChunkLength: z.number().default(3500),
})

/**
 * QQ → DSH 桥。
 */
export class QqBridgeService extends Service {
  static Config = Config

  private bot: OneBotClient
  private buffers = new Map<string, TurnBuffer>()   // sessionId -> 进行中回合
  private sessionIds = new Map<string, string>()    // qqKey -> sessionId（防重复建）
  private config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qqBridge')
    this.config = config
    this.bot = new OneBotClient({
      url: config.onebotWs,
      token: config.onebotToken,
    })
    this.bot.on('message', (msg) => { void this.onQqMessage(msg) })
    this.bot.on('error', (err) => ctx.logger.warn('[qq-bridge] onebot error: %s', err.message))
    this.bot.on('reconnecting', (r) => ctx.logger.info('[qq-bridge] reconnecting: %j', r))
    this.bot.connect()

    // 流式事件：聚合 assistant 文本，回合结束发送
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session.id, event).catch((err) =>
        ctx.logger.warn('[qq-bridge] event handler: %s', err.message))
    })
  }

  // ---------- QQ → DSH ----------

  private async onQqMessage(msg: any): Promise<void> {
    const text = OneBotClient.extractText(msg.message)
    if (!text) return
    const target = {
      message_type: msg.message_type,             // 'group' | 'private'
      group_id: msg.group_id,
      user_id: msg.user_id,
    }
    const qqKey = qqSessionId(msg.message_type, msg.group_id ?? msg.user_id)
    const ctxLogger = this.ctx.logger

    try {
      // 1. 幂等取得 DSH 会话
      let sessionId = this.sessionIds.get(qqKey)
      if (!sessionId) {
        sessionId = await this.ensureSession(qqKey, this.config.sessionCwd)
        this.sessionIds.set(qqKey, sessionId)
      }
      // 2. 回执
      if (this.config.ack) {
        await this.bot.sendText(target, `📥 已收到，开始处理…`)
      }
      // 3. 异步入队（accepted 即返回；回复走事件流）
      await this.ctx.apiProxy.sessions.prompt({
        payload: {
          sessionId, mode: 'queue',
          content: [{ type: 'text', text }],
        },
      })
      ctxLogger.info('[qq-bridge] queued "%s" -> %s', text.slice(0, 40), sessionId)
    } catch (err) {
      ctxLogger.warn('[qq-bridge] prompt failed: %s', err.message)
      await this.bot.sendText(target, `⚠️ 发送失败：${err.message}`).catch(() => {})
    }
  }

  /** 查找或创建会话。优先复用 Web UI 已建会话（同 qqKey 名），否则新建。 */
  private async ensureSession(qqKey: string, cwd: string): Promise<string> {
    const api = this.ctx.apiProxy
    // 先查已存在的会话
    const { items } = await api.sessions.list({ payload: {} })
    const found = items.find((it: any) => it.sessionId === qqKey || it.title === qqKey)
    if (found) return found.sessionId
    // 新建
    const created = await api.sessions.create({
      payload: { sessionId: qqKey, cwd, blank: true },
    })
    return created.sessionId
  }

  // ---------- DSH → QQ ----------

  private async onSessionEvent(sessionId: string, event: SessionEvent): Promise<void> {
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta') return
        const buf = this.buffers.get(sessionId)
        if (!buf) return
        buf.chunks.push(chunk.text)
        // 兜底：长时间无终结时强制发送（防丢回复）
        if (Date.now() - buf.lastFlush > this.config.forceFlushMs) {
          await this.flush(buf, false)
        }
        break
      }
      case 'assistant/message': {
        const buf = this.buffers.get(sessionId)
        if (!buf) return
        const text = (event.data.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text).join('').trim()
        if (text) buf.steps.push(text)
        buf.chunks = []
        buf.lastFlush = Date.now()
        break
      }
      case 'turn/end': {
        const buf = this.buffers.get(sessionId)
        if (!buf) return
        buf.done = true
        const reason = event.data.reason?.kind ?? 'unknown'
        await this.flush(buf, true, reason)
        this.buffers.delete(sessionId)
        break
      }
      case 'question/requested': {
        await this.onQuestion(sessionId, event.data)
        break
      }
      case 'approval/requested': {
        await this.onApproval(sessionId, event.data)
        break
      }
    }
  }

  /** 发送累积文本。done=true 时整体发送（分片），否则发进度摘要。 */
  private async flush(buf: TurnBuffer, done: boolean, reason?: string): Promise<void> {
    const text = buf.steps.join('\n\n').trim() || buf.chunks.join('').trim()
    if (!text) return
    if (done) {
      for (let i = 0; i < text.length; i += this.config.maxChunkLength) {
        await this.bot.sendText(buf.qqTarget, text.slice(i, i + this.config.maxChunkLength))
      }
      if (reason && reason !== 'completed') {
        await this.bot.sendText(buf.qqTarget, `（回合结束：${reason}）`)
      }
    } else {
      await this.bot.sendText(buf.qqTarget, `…（已产出 ${text.length} 字，继续处理中）`)
    }
    buf.lastFlush = Date.now()
  }

  /** question/requested：按策略应答（必须应答，否则回合挂起）。 */
  private async onQuestion(sessionId: string, data: any): Promise<void> {
    const buf = this.buffers.get(sessionId)
    const target = buf?.qqTarget
    const question = data.question?.text ?? JSON.stringify(data).slice(0, 200)
    const allow = this.config.autoAnswer === 'allow-once'
    await this.ctx.apiProxy.respond({
      payload: {
        sessionId,
        answer: {
          answers: (data.question?.answers ?? []).map((a: any) => ({
            id: a.id, selected: allow ? [a.answers?.[0]?.id].filter(Boolean) : [],
          })),
        },
      },
    })
    if (target) {
      await this.bot.sendText(target, allow
        ? `🤖 已自动回答提问：${question}`
        : `⚠️ 模型在等您确认（QQ 端暂不支持提问）：${question}\n请到 Web 界面处理，已按"拒绝"继续。`)
    }
  }

  /** approval/requested：自动按策略应答。 */
  private async onApproval(sessionId: string, data: any): Promise<void> {
    const buf = this.buffers.get(sessionId)
    const target = buf?.qqTarget
    const allow = this.config.autoAnswer === 'allow-once'
    await this.ctx.apiProxy.respond({
      payload: {
        sessionId,
        approvalId: data.approvalId,
        outcome: allow ? 'allowed-once' : 'rejected',
      },
    })
    if (target) {
      await this.bot.sendText(target, allow
        ? '🤖 已自动允许本次工具调用。'
        : '⚠️ 模型请求了工具调用审批（QQ 端暂不支持），已自动拒绝，请到 Web 界面处理。')
    }
  }
}

/** 注册插件。 */
export function apply(ctx: Context, config: Config): void {
  ctx.service('qqBridge', (c) => new QqBridgeService(c, config))
  ctx.on('dispose', () => {
    const svc = ctx.get('qqBridge') as QqBridgeService | undefined
    svc?.stop?.()
  })
}
