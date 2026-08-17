# DeepSeek Harness Desktop v0.1.3 发布说明

> 修复 v0.1.2 的 Dock 图标恢复问题。

## 修复

- **窗口隐藏到托盘后，点击 Dock 图标无法恢复窗口**：缺少 `app.on('activate')` 处理。
  macOS 上窗口隐藏后，点击 Dock 图标依赖 `activate` 事件（而非 `second-instance`），
  此前未处理导致只能从访达重新打开。现已补上，点击 Dock 图标即可恢复窗口。

## 变更

- `app/package.json` 版本号 0.1.2 → 0.1.3
