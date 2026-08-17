/**
 * energy.mjs —— 群聊能量阈值机制（独立模块，便于单测与可视化调试）
 *
 * 原理：模拟真人"不是每条都回"的社交节奏。
 *   - 每次回复后，能量重置为随机区间值（默认 100~500）
 *   - 每秒能量 -decayPerSec（时间衰减，默认 3）
 *   - 群内每条消息 -msgCost（活跃度衰减，默认 10）
 *   - 能量 < 0 时触发回复（携带最近 contextWindow 条消息上下文）
 *
 * 对外接口（供 index.mjs 调用）：
 *   createEnergyManager({ global, log }) → { feed(qqKey, user, text), shouldReply, getContext, reset, dispose, stats }
 *
 * 纯逻辑、无 IO，便于未来可视化配置界面直接调用/预览。
 */

'use strict'

/** 默认参数（与 config.mjs 的 DEFAULTS.energy 一致，可被覆盖） */
const DEFAULT_ENERGY = {
  enabled: true,
  range: [100, 500],
  decayPerSec: 3,
  msgCost: 10,
  contextWindow: 8,
}

export function createEnergyManager({ energy = {}, log = () => {} } = {}) {
  const opts = { ...DEFAULT_ENERGY, ...energy }
  /** qqKey -> { energy, history: [{user, text, at}] } */
  const states = new Map()

  /** 每秒衰减定时器 */
  const timer = setInterval(() => {
    for (const [, st] of states) {
      st.energy -= opts.decayPerSec
    }
  }, 1000)

  function reset(qqKey) {
    const st = states.get(qqKey)
    if (!st) return
    const [lo, hi] = opts.range
    st.energy = lo + Math.floor(Math.random() * (hi - lo + 1))
    return st.energy
  }

  /**
   * 记录群消息并扣能量。
   * @returns {boolean} true = 达到触发阈值（应回复）
   */
  function feed(qqKey, user, text) {
    let st = states.get(qqKey)
    if (!st) {
      st = { energy: opts.range[0], history: [] }
      states.set(qqKey, st)
    }
    st.history.push({ user, text, at: Date.now() })
    const keep = opts.contextWindow
    if (st.history.length > keep) st.history = st.history.slice(-keep)
    st.energy -= opts.msgCost
    log('info', '[qq-bridge] 群 %s 能量 %d (消息 -%d)', qqKey, st.energy, opts.msgCost)
    return st.energy < 0
  }

  /** 当前是否应回复（能量 < 0） */
  function shouldReply(qqKey) {
    return (states.get(qqKey)?.energy ?? 0) < 0
  }

  /** 取某群最近聊天记录（供 prompt 上下文） */
  function getContext(qqKey) {
    const st = states.get(qqKey)
    if (!st || !st.history.length) return ''
    const lines = st.history.map((m) => `${m.user}: ${m.text}`).join('\n')
    return `（以下是该群最近的聊天记录，请基于这些内容自然地接话，不要复述记录本身：\n${lines}）`
  }

  /** 当前能量值（供可视化/调试） */
  function getEnergy(qqKey) {
    return states.get(qqKey)?.energy
  }

  /** 全部群状态快照（供可视化界面） */
  function stats() {
    return Object.fromEntries([...states.entries()].map(([k, v]) => [k, { energy: v.energy, historyLen: v.history.length }]))
  }

  function dispose() {
    clearInterval(timer)
    states.clear()
  }

  return { feed, shouldReply, getContext, reset, getEnergy, stats, dispose }
}
