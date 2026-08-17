# DeepSeek Harness Desktop v0.1.2 发布说明

> 修复 v0.1.1 的退出问题，新增关闭提示。

## 修复

- **应用无法退出（Dock/Cmd+Q 无效）**：`before-quit` 未置 `isQuitting=true`，导致
  `app.quit()` 触发窗口 close 时被 `preventDefault()` 拦截，只能强杀进程。
  现已在 `before-quit` 中置位，所有退出路径（Dock 右键退出 / Cmd+Q / 应用菜单 / 托盘）均可正常退出。

## 新增

- 点窗口关闭（✕）首次隐藏到托盘时，弹出系统通知提示「窗口已最小化到系统托盘，右键托盘图标可退出应用」。

## 变更

- `app/package.json` 版本号 0.1.1 → 0.1.2
