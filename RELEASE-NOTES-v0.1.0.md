# DeepSeek Harness Desktop v0.1.0 发布说明（草稿）

> 供 GitHub Release 使用；发布前按实际调整。

## 简介

DeepSeek Harness 桌面版：Electron 壳 + 内置 Node 24 + 完整 Harness 环境，双击即用；内置 OneBot 11 QQ 桥，可通过 QQ 远程向 Harness 发任务并接收流式回复。

## 主要特性

- **一键启动**：内置 Node 运行时，无需安装 Node.js；自动拉起 Harness 并打开 Web UI
- **三平台安装包**：Windows（Inno Setup）、macOS（DMG）、Linux（tar.gz / deb）
- **QQ 远程交互**（OneBot 11）：私聊与群消息各自映射独立会话，与 Web UI 完全共享，回复流式回传；连续消息按序回复不丢失
- **内置冒烟 + QQ 端到端测试**：每次构建自动验证产物可启动、原生模块完整、QQ 桥全链路可用

## 变更摘要（自 0.1.0-rc 基线）

- 锁定上游 deepseek-harness 至 dsh 0.1.0-rc.5（commit 47f9438），构建可复现
- 对齐 pnpm 11 + `allowBuilds`，修复 node-pty/koffi 原生模块静默缺失
- 物化流程修复：解引用 pnpm 虚拟依赖后的解析断裂（esbuild/typebox/@koromix/@opentelemetry 等）
- 安全加固：导航限制、sandbox 显式化、POSIX 进程组终止、SHASUMS 校验
- 死代码清理、README 修正、卸载停服

## 已知限制（MVP 范围）

- QQ 端提问/审批默认自动拒绝并提示（`autoAnswer: reject`）
- 构建产物较大（约 9-12GB 解压体积，含完整 Harness 依赖）
- macOS 产物为 ad-hoc 签名（首次打开需右键 → 打开）

## 使用

见 README「使用」与「QQ 远程交互」章节（NapCat 部署清单）。
