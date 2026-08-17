/**
 * friend.mjs —— 成员友好度系统
 *
 * 目标：让万生玲对每个成员有"熟悉度"，影响她的反应与能量消耗。
 *
 * 核心规则（用户确认）：
 *   - 友好度按【用户维度】跨群共享（同一 QQ 号在所有群同一友好度）
 *   - 初始友好度 0
 *   - 万生玲每次发言，其【前后各 5 条】消息内的发言者友好度 +1（同人多条多次 +1）
 *   - 被 @ 时，@ 万生玲的用户友好度额外 +5
 *   - 等级：<80 陌生 | 80~160 认识 | 160~240 熟悉 | >240 挚友
 *   - 挚友：每句话减少 7 能量
 *
 * 接口：
 *   createFriendsManager({ log })
 *     → feedWindow(qqKey, userId)    万生玲发言时调用，结算前后5句窗口内成员 +1
 *     → recordMessage(qqKey, userId) 记录一条消息到窗口（供 feedWindow 用）
 *     → boost(qqKey, userId)         @ 万生玲的用户 +5
 *     → get(userId)                  取用户友好度
 *     → level(userId)                取等级（'stranger'|'acquaintance'|'familiar'|'best'）
 *     → friendEnergyBonus(userId)    挚友能量减免（挚友返回 7，否则 0）
 *     → groupTotal(qqKey)            某群成员友好度总和
 *     → stats()                      状态快照（可视化）
 */

'use strict'

/** 等级阈值 */
export const LEVELS = [
  { threshold: 240, level: 'best', label: '挚友' },
  { threshold: 160, level: 'familiar', label: '熟悉' },
  { threshold: 80, level: 'acquaintance', label: '认识' },
  { threshold: -Infinity, level: 'stranger', label: '陌生' },
]

/** 前后窗口大小（万生玲发言前/后各 N 条） */
export const WINDOW = 5
/** 窗口内每条发言的友好度增量 */
export const PER_MSG_GAIN = 1
/** @ 万生玲的友好度增量 */
export const AT_GAIN = 5
/** 挚友每句能量减免 */
export const BEST_FRIEND_ENERGY_BONUS = 7

export function createFriendsManager({ log = () => {} } = {}) {
  /** userId -> { value, firstSeen, lastSeen }（跨群共享） */
  const users = new Map()
  /** qqKey -> [{userId, at}] 最近消息窗口（供 feedWindow 结算） */
  const windows = new Map()
  /** qqKey -> Set<userId> 该群全部成员（供 groupTotalAll 精确计算） */
  const groupMemberSets = new Map()

  /** 取用户友好度（不存在则初始 0） */
  function get(userId) {
    return users.get(String(userId))?.value ?? 0
  }

  /** 等级判定 */
  function level(userId) {
    const v = get(userId)
    for (const l of LEVELS) if (v >= l.threshold) return l
    return LEVELS[LEVELS.length - 1]
  }

  /** 记录一条群消息到窗口（滚动保留 WINDOW*2 条） */
  function recordMessage(qqKey, userId) {
    let w = windows.get(qqKey)
    if (!w) { w = []; windows.set(qqKey, w) }
    w.push({ userId: String(userId), at: Date.now() })
    // 保留窗口大小（前后各 WINDOW，最多 WINDOW*2 条）
    if (w.length > WINDOW * 2) w.splice(0, w.length - WINDOW * 2)
  }

  /**
   * 万生玲发言时调用：结算窗口 —— 窗口内所有发言者 +1（同人多条多次 +1）
   * @returns 本次增加的用户友好度明细 [{userId, gain}]
   */
  function feedWindow(qqKey, selfId) {
    const w = windows.get(qqKey)
    if (!w || !w.length) return []
    const gained = []
    const seen = new Map()
    for (const m of w) {
      if (String(m.userId) === String(selfId)) continue  // 自己不算
      seen.set(m.userId, (seen.get(m.userId) || 0) + PER_MSG_GAIN)
    }
    for (const [userId, gain] of seen) {
      add(userId, gain)
      gained.push({ userId, gain })
    }
    // 结算后清空窗口（一次发言结算一次）
    windows.delete(qqKey)
    return gained
  }

  /** 给某用户加友好度 */
  function add(userId, gain) {
    const id = String(userId)
    let u = users.get(id)
    const now = Date.now()
    if (!u) { u = { value: 0, firstSeen: now, lastSeen: now }; users.set(id, u) }
    u.value += gain
    u.lastSeen = now
    return u.value
  }

  /** @ 万生玲的用户 +5 */
  function boost(userId) {
    return add(userId, AT_GAIN)
  }

  /** 挚友能量减免：挚友返回 7，否则 0 */
  function friendEnergyBonus(userId) {
    return level(userId).level === 'best' ? BEST_FRIEND_ENERGY_BONUS : 0
  }

  /**
   * 生成"与当前说话人的熟悉度"认知（注入 prompt）
   * @param {string} currentUserId 当前发言者（触发本条回复的人）
   */
  function buildContext(qqKey, selfId, currentUserId) {
    if (!currentUserId) return ''
    const v = get(currentUserId)
    const l = level(currentUserId)
    return `（你对当前说话者（${currentUserId}）的友好度为 ${v}，关系判定：${l.label}。${l.label === '挚友' ? '对他可以完全放开，随便开玩笑。' : l.label === '熟悉' ? '对他比较熟，可以开玩笑吐槽。' : l.label === '认识' ? '对他不算熟，保持礼貌距离，别太热情。' : '和他不熟，回复保持简短冷淡，别太热情。'}）`
  }

  /** 某群成员友好度总和（讨论触发判定用，窗口回退） */
  function groupTotal(qqKey) {
    const w = windows.get(qqKey)
    if (!w) return 0
    const ids = new Set(w.map((m) => m.userId))
    let sum = 0
    for (const id of ids) sum += get(id)
    return sum
  }

  /** 记录该群全部成员（同步成员列表后调用，供精确计算总友好度） */
  function setGroupMembers(qqKey, userIds) {
    let set = groupMemberSets.get(qqKey)
    if (!set) { set = new Set(); groupMemberSets.set(qqKey, set) }
    for (const id of userIds) set.add(String(id))
  }

  /** 群成员友好度总和（基于完整成员列表；未同步时回退窗口） */
  function groupTotalAll(qqKey) {
    const set = groupMemberSets.get(qqKey)
    if (!set || !set.size) return groupTotal(qqKey)
    let sum = 0
    for (const id of set) sum += get(id)
    return sum
  }

  /** 等级中文标签 */
  function levelLabel(userId) {
    return level(userId).label
  }

  /** 状态快照（可视化/调试） */
  function stats() {
    const out = {}
    for (const [id, u] of users) out[id] = { value: u.value, level: level(id).label }
    return out
  }

  return { get, level, levelLabel, recordMessage, feedWindow, boost, add, friendEnergyBonus, groupTotal, groupTotalAll, setGroupMembers, buildContext, stats }
}
