# DeepSeek Harness 桌面版

将 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 打包成三平台桌面应用：
**Electron 桌面壳 + 内置 Node 运行时 + 完整 Harness 环境**，双击即用。

![DeepSeek](log.svg)

## ✨ 特性

- **一键启动**：双击 `DeepSeekHarness.exe` → 自动拉起后端 → 直接打开 DeepSeek Harness Web UI
- **内置 Node 24**：自包含运行时，用户无需安装 Node.js
- **完整环境**：打包了 Harness 全部依赖（链接已物化为真实文件）
- **无边框窗口**：UI 铺满窗口，右上角内嵌最小化 / 最大化 / 关闭按钮
- **单实例**：重复启动不会拉起多个后端
- **免管理员**：Windows 安装到 `%LocalAppData%\Programs\DeepSeek Harness`
- **QQ 远程交互**：内置 OneBot 11 桥（`@dsh-qq/qq-bridge`），配置 NapCat/Lagrange 后即可通过 QQ 向 Harness 发任务并接收回复（见 [QQ 远程交互](#qq-远程交互)）

## 📦 产物

| 平台 | 文件 | 说明 |
|------|------|------|
| Windows | `installers/DeepSeekHarnessSetup-*.exe` | Inno Setup 一键安装包 |
| Windows | `build/DeepSeekHarnessApp/DeepSeekHarness.exe` | 免安装版（直接运行） |
| macOS | `installers/DeepSeekHarness-macOS-<arch>-<ver>.dmg` | 应用镜像（.app，ad-hoc 签名） |
| Linux | `installers/DeepSeekHarness-linux-<arch>-<ver>.tar.gz` | 免安装压缩包（解压即用） |
| Linux | `installers/deepseek-harness_<ver>_<arch>.deb` | Debian/Ubuntu 安装包 |

> 三平台均由 GitHub Actions 自动构建（`.github/workflows/build.yml` 矩阵），
> 推送 `v*` 标签时自动发布到 Release；也可 `workflow_dispatch` 手动触发。

## 🗂 目录结构

```
app/                      Electron 桌面应用源码
  main.js                 主进程：启动后端、注入窗口控制按钮
  titlebar-preload.js     preload 脚本（窗口控制 IPC）
  renderer/               渲染页面（splash 启动页）
build/                    构建脚本与产物（跨平台，Node 实现）
  build-harness.js        克隆 deepseek-harness（锁定 commit）+ 注入 QQ 桥插件（独立仓库）+ pnpm 构建
  materialize3.js         node_modules 链接物化（消除 junction/符号链接）
  download-node.js        按平台下载内置 Node 运行时（含 SHASUMS 校验）
  trim.js                 精简 harness（跨平台版 trim.ps1）
  assemble.js             组装应用目录（Windows robocopy / POSIX cp -aL）
  convert-icon.js         SVG -> ICO（png-to-ico）+ PNG 源图
  smoke-test.js           CI/本地冒烟测试（产物启动 + 3080 探测 + 原生模块检查）
setup.iss                 Inno Setup 安装脚本（本地/CI 均可用）
log.svg                   应用图标（DeepSeek logo）
```

## 🔧 构建流程

> 本地需要：Node.js ≥ 22、[pnpm 11](https://pnpm.io/)（上游 harness 已用 pnpm 11 的
> `allowBuilds` 机制；pnpm 10 会静默跳过原生模块构建，**必须用 pnpm 11**）；
> Windows 额外需要 [Inno Setup 6](https://jrsoftware.org/isdl.php)。
> CI 三平台全自动，无需本地环境。

### 1. 准备 Harness 依赖（pnpm 11 + hoisted）

```bash
node build/build-harness.js        # 克隆(锁定 commit 47f9438, dsh 0.1.0-rc.5) → 注入插件 → .npmrc(hoisted) → pnpm install → pnpm build
# 覆盖锁定版本：HARNESS_COMMIT=<sha> node build/build-harness.js；强制重拉：HARNESS_FORCE=1
```

### 2. 物化链接 + 精简

```bash
node build/materialize3.js resources/harness   # junction/符号链接 → 真实文件
node build/trim.js                             # 删除冗余 @deepseek-ai 副本、拷贝 web 前端
```

### 3. 运行时 + 组装 + 冒烟

```bash
node build/download-node.js v24.14.0           # 内置 Node（按当前平台/架构，含 SHASUMS 校验）
npm install                                    # electron + sharp + png-to-ico
node build/convert-icon.js                     # log.svg -> build/app.ico + PNG 源图
node build/assemble.js                         # 组装到 build/DeepSeekHarnessApp
node build/smoke-test.js --app build/DeepSeekHarnessApp   # 冒烟：产物启动 + 3080 探测 + 原生模块
```

### 4. 打包

```bash
# Windows
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "/DProjectDir=$((Get-Location).Path)" setup.iss
# macOS
hdiutil create -volname "DeepSeek Harness" -srcfolder build/DeepSeekHarnessApp/DeepSeekHarness.app -ov -format UDZO installers/DeepSeekHarness-macOS-$(uname -m).dmg
# Linux
tar -C build/DeepSeekHarnessApp -czf installers/DeepSeekHarness-linux.tar.gz DeepSeekHarness
```

## 🚀 使用

1. 双击 `DeepSeekHarnessSetup-*.exe` 安装（免管理员，自动建桌面快捷方式）
2. 双击桌面「DeepSeek Harness」图标
3. 首次使用：在 Web 界面设置 **DeepSeek API Key**

## ⚠️ 注意

- 用户数据存放在 `~/.dsh`（与安装目录分离），卸载后保留
- 服务监听 `http://127.0.0.1:3080`；**关闭窗口仅隐藏到托盘，服务继续运行**，托盘「退出」才真正停服

## QQ 远程交互

> QQ 桥插件（`@dsh-qq/qq-bridge`）已独立成单独项目，见私有仓库 **WanShengling**（本地 `~/Documents/DshDesktop/dsh-qq-bridge/`），本仓库通过构建脚本从独立仓库注入。配置 NapCat/Lagrange 后即可通过 QQ 向 Harness 发任务并接收回复。

### 部署 NapCat（一次性准备，约 10 分钟）

1. **准备一个 QQ 号**（建议小号），并在该 QQ 登录的设备上完成扫码/验证
2. **安装 NapCat**（Shell 包，跨平台，macOS/Windows/Linux 通用）：
   - 到 [NapCat 仓库 Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.zip`（注意：**无 `brew cask`**，`brew install --cask napcat` 不存在，此前的指引有误）
   - 解压后进入目录，用系统 Node.js（≥22）运行 `node napcat.mjs`（无需安装/注入任何东西）
3. **启动并登录**：`node napcat.mjs` → 终端出现二维码 → 用准备好的 QQ 号扫码登录
4. **开启正向 WebSocket**：NapCat 设置 → 网络配置 → 新建 **WebSocket 服务器**（正向）→ 端口填 `6700`（默认即可）→ 可选设置 access token → 保存
5. **记录地址**：`ws://127.0.0.1:6700`（若改了端口/token 按实际记录）

### 连接桥

1. 设置桥的 WS 地址（任选其一）：
   - **环境变量（推荐）**：桌面壳透传 `DSH_QQ_ONEBOT_WS=ws://127.0.0.1:6700`、`DSH_QQ_ONEBOT_TOKEN=<token>`
   - **profile 补丁**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，覆盖 `qq-bridge` 行的 `onebotWs`/`onebotToken`
   - 不配置时使用默认值 `ws://127.0.0.1:6700`（与 NapCat 默认一致）
2. 重启应用（或等待 profile 热重载）后，向该 QQ 号发消息即触发 Harness 会话：私聊与每个群各自映射独立会话，回复经 QQ 回传

### 行为说明

- 会话与 Web UI **完全共享**（同一 harness 实例），QQ 里发起/继续的会话在浏览器中可见、可续
- 回复按步骤聚合后发送；回合结束（含错误）会附加状态说明
- 模型发起的**提问/审批**在 QQ 端默认自动拒绝并提示（`autoAnswer: reject`），如需自动放行改为 `allow-once`（仅限可信场景）

> MVP 范围：发任务 + 流式回复。更丰富的审批交互与命令面板为后续迭代项。

## 📄 许可

MIT。Harness 本体版权归 [DeepSeek AI](https://deepseek.com) 所有，见上游仓库。
