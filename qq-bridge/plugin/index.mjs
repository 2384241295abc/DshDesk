/**
 * dsh-qq-bridge —— 入口薄壳（永久不变）
 *
 * ⚠️ 本文件是 Cordis 加载的插件入口，保持极简且永不包含业务逻辑。
 * 每次 apply 都用带时间戳的 URL 动态加载 runtime.mjs，绕过 Node ESM
 * 缓存，从而实现"改代码无需重启、触发 HMR 即热更新"。
 *
 * 若需热更新生效：修改任意业务模块（runtime/config/persona/energy/...）后，
 * 只需让补丁文件内容变化一次（如 touch cordis.patch.yml）触发 HMR 重载。
 */

export const name = 'qq-bridge'
export const inject = ['apiProxy']

/** QQ 会话 → DSH 会话 id（转发到 runtime，保持接口一致）。 */
export function qqSessionId(messageType, id) {
  return `qq-${messageType}-${id}`
}

/**
 * Cordis 插件入口。apply 返回 Promise（Cordis 支持异步 apply：
 * `'then' in effect` 分支会收集 then 的结果作为 disposer）。
 * 用当前时间戳做 query，强制加载最新 runtime 及全部业务子模块。
 */
export function apply(ctx, rawConfig = {}) {
  const ts = Date.now()
  return import(`./runtime.mjs?t=${ts}`).then((m) => m.apply(ctx, rawConfig, ts))
}
