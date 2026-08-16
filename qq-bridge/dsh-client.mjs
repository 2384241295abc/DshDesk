/**
 * DeepSeek Harness /api 客户端（浏览器同款协议，实测于 2025-08-16）
 *
 * 协议要点（packages/client/connection 实证）：
 *  - 路径式路由：POST /api/<method>，body 为 client-request 信封
 *  - 响应：{"type":"server-response","rpcId":...,"result":{"ok":true,"value":...} | {"ok":false,"error":...}}
 *  - 事件：ws://host/api/events.mux 下行 server-request 信封（payload.type 为事件类型）
 *  - 信任栅栏：Host 必须为 loopback 或 trustedHosts（本机 127.0.0.1 天然满足）
 *
 * 依赖：Node ≥ 22 内置 fetch 与全局 WebSocket，无外部依赖。
 */
'use strict'

import { EventEmitter } from 'node:events'

export class DshRpcError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`)
    this.code = code
    this.details = details
  }
}

export class DshClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl='http://127.0.0.1:3080']
   * @param {boolean} [opts.autoSubscribe=true] 连接时自动订阅 events.mux
   */
  constructor(opts = {}) {
    super()
    this.baseUrl = opts.baseUrl ?? 'http://127.0.0.1:3080'
    this.autoSubscribe = opts.autoSubscribe ?? true
    this.ws = null
    this.wsOpen = false
    this.rpcSeq = 0
  }

  /**
   * 调用一个 RPC 方法。
   * @param {string} method 如 'session.list'、'session.prompt'
   * @param {object} payload
   * @returns {Promise<any>} result.value
   */
  async call(method, payload = {}) {
    const rpcId = `qq-${Date.now()}-${this.rpcSeq++}`
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    if (!res.ok) throw new DshRpcError('http', `HTTP ${res.status}: ${await res.text()}`)
    const body = await res.json()
    if (body.type !== 'server-response' || body.rpcId !== rpcId) {
      throw new DshRpcError('protocol', 'unexpected response envelope')
    }
    if (!body.result.ok) {
      const err = body.result.error ?? {}
      throw new DshRpcError(err.code || 'rpc', err.message || 'rpc failed', err.details)
    }
    return body.result.value
  }

  /** 会话列表（只读）。 */
  listSessions() { return this.call('session.list', {}) }

  /**
   * 向会话注入一条用户消息。
   * @param {string} sessionId
   * @param {string} text
   * @param {'queue'|'steer'} [mode='queue']
   */
  prompt(sessionId, text, mode = 'queue') {
    return this.call('session.prompt', {
      sessionId, mode,
      content: [{ type: 'text', text }],
    })
  }

  /** 订阅事件流（events.mux）。事件以 'event' 事件发出，payload.type 区分类型。 */
  subscribe() {
    if (this.ws) return this
    const url = this.baseUrl.replace(/^http/, 'ws') + '/api/events.mux'
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => { this.wsOpen = true; this.emit('ws-open') }
    ws.onmessage = (ev) => {
      let frame
      try { frame = JSON.parse(String(ev.data)) } catch { return }
      // server-request 信封：method === payload.type
      if (frame && frame.type === 'server-request' && frame.payload) {
        this.emit('event', frame.payload)
        this.emit(frame.payload.type, frame.payload)
      }
    }
    ws.onclose = () => { this.wsOpen = false; this.ws = null; this.emit('ws-close') }
    ws.onerror = (ev) => this.emit('ws-error', new Error(ev.message || 'events.mux error'))
    return this
  }

  close() {
    if (this.ws) { try { this.ws.close() } catch { /* ignore */ } this.ws = null }
    this.wsOpen = false
  }
}
