# DeepSeek Harness Desktop v0.1.1 发布说明

> 修复 v0.1.0 的桌面应用关键 bug。

## 修复

- **应用无法自启 harness（node 运行时缺失）**：`app/main.js` 的 `appResourcesDir()` 在 macOS 上拼错资源目录
  （`Contents/MacOS/resources` 小写错误层级，实际为 `Contents/Resources` 大写）。
  该 bug 在 3080 端口已有可用实例时被绕过（探测复用），仅在需要应用自行拉起后端时触发。
  现已在 macOS 平台回退到上一级 `Contents/Resources`，Windows/Linux 保持同级 `resources/`。

## 变更

- `app/package.json` 版本号 0.1.0 → 0.1.1

## 说明

- 功能与 v0.1.0 一致，仅修复上述启动路径 bug。
