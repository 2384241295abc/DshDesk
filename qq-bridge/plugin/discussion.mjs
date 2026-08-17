/**
 * discussion.mjs —— 群聊"讨论"事件模式
 *
 * 触发（用户确认，每次消息后检查）：
 *   某群成员友好度总和 > 成员数量 × 80 → 进入讨论模式
 *
 * 讨论模式行为：
 *   - 进入时能量固定为 10
 *   - 每次有人发言：检测能量，<0 就回复，回复后能量重置为 30
 *   - 能量持续衰减（每秒-3、消息-10）
 *   - 能量 < -1540 → 退出讨论，恢复常态（能量重置 random(100,500)）
 *
 * 接口：
 *   createDiscussionManager({ energy, log })
 *     → shouldEnter(qqKey, groupTotal, memberCount)  是否应进入讨论
 *     → enter(qqKey) / exit(qqKey) / isActive(qqKey)
 *     → onReply(qqKey)   回复后重置能量 30（讨论模式）
 *     → onMessage(qqKey) 消息扣能等走外部 energy；此处仅处理讨论状态
 */

'use strict'

/** 讨论触发阈值系数：总友好度 > 成员数 × 系数 */
export const TRIGGER_MULTIPLIER = 80
/** 进入讨论时能量 */
export const ENTER_ENERGY = 10
/** 讨论中每次回复后重置的能量 */
export const REPLY_RESET_ENERGY = 30
/** 退出讨论的能量下限 */
export const EXIT_ENERGY = -1540

export function createDiscussionManager({ energy, log = () => {} } = {}) {
  /** qqKey -> 是否讨论中 */
  const active = new Set()

  function isActive(qqKey) {
    return active.has(qqKey)
  }

  /** 进入讨论：能量固定 10 */
  function enter(qqKey) {
    if (active.has(qqKey)) return false
    active.add(qqKey)
    energy.forceTo(qqKey, ENTER_ENERGY)   // 讨论入口能量 10
    log('info', '[qq-bridge] 群 %s 进入讨论模式（能量=%d）', qqKey, ENTER_ENERGY)
    return true
  }

  /** 退出讨论：恢复常态（重置能量由调用方处理） */
  function exit(qqKey) {
    if (!active.has(qqKey)) return false
    active.delete(qqKey)
    log('info', '[qq-bridge] 群 %s 退出讨论模式', qqKey)
    return true
  }

  /** 消息后检查：能量 < -1540 → 退出讨论 */
  function checkExit(qqKey) {
    if (!active.has(qqKey)) return false
    const e = energy.getEnergy(qqKey)
    if (e !== undefined && e < EXIT_ENERGY) {
      exit(qqKey)
      return true
    }
    return false
  }

  /** 讨论中每次回复后：能量重置 30 */
  function onReply(qqKey) {
    if (!active.has(qqKey)) return
    energy.forceTo(qqKey, REPLY_RESET_ENERGY)
  }

  /**
   * 检查是否应进入讨论（调用方传入群总友好度与成员数）。
   * @returns true=本次进入讨论
   */
  function checkEnter(qqKey, groupTotal, memberCount) {
    if (active.has(qqKey)) return false
    if (memberCount <= 0) return false
    if (groupTotal > memberCount * TRIGGER_MULTIPLIER) {
      return enter(qqKey)
    }
    return false
  }

  /** 状态快照（可视化） */
  function stats() {
    return { activeGroups: [...active] }
  }

  return { isActive, enter, exit, checkEnter, checkExit, onReply, stats }
}
