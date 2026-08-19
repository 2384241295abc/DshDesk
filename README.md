# DeepSeek Harness 桌面版

将 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 打包成三平台桌面应用：
**Electron 桌面壳 + 内置 Node 运行时 + 完整 Harness 环境**，双击即用。

![DeepSeek](log.svg)

## ✨ 特性

- **启动页 + 工作台**：启动页展示 logo/版本/检查更新，点击「进入」切换到工作台（可随时返回启动窗口）
- **一键启动**：双击应用 → 自动拉起后端 → 进入 DeepSeek Harness Web UI
- **自动更新**：启动页「检查更新」→ 从 GitHub Release 拉取最新版 → 下载 → 自动替换安装
- **多页面**：主界面（DSH）/ NapCat（WebUI 自动 token 登录），顶栏切换
- **皮肤系统**：深色/浅色/自定义三套皮肤；自定义支持导入启动图、工作台图、主色基调（原生菜单操作，所见即所得）
- **内置 Node 24**：自包含运行时，用户无需安装 Node.js
- **完整环境**：打包了 Harness 全部依赖
- **单实例**：重复启动不会拉起多个后端
- **QQ 远程交互**：内置 OneBot 11 桥（`@dsh-qq/qq-bridge`），配置 NapCat 后可通过 QQ 向 Harness 发任务并接收回复（见 [QQ 远程交互](#qq-远程交互)）

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
  main.js                 主进程：启动后端、多页面、皮肤、更新、原生菜单
  theme.js                皮肤接口（colors + images + animations）
  pages.js                页面注册表（registerPage 接入新页面）
  updater.js              自动更新（GitHub Release → 下载 DMG → 替换）
  napcat-auth.js          NapCat WebUI token 读取
  renderer/               壳 UI（主窗口）
    shell.html/js        顶栏 + 启动页 + iframe 工作台
    shell-preload.js     preload（IPC 桥）
    splash.html          启动加载页
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
hdiutil create -volname "DeepSeek Harness" -srcfolder build/DeepSeekHarnessApp/DeepSeekHarness.app -ov -format UDZO installers/DeepSeekHarness-macOS-$(uname -m)-<ver>.dmg
# Linux
tar -C build/DeepSeekHarnessApp -czf installers/DeepSeekHarness-linux-<ver>.tar.gz DeepSeekHarness
```

> **注意**：每次代码更新后，需同步改动文件到产物（`build/DeepSeekHarnessApp/.../Resources/app/`）并验证 md5 一致（见 `mist.md` 规则 7），再打包带新版本号的 DMG。

## 🚀 使用

1. 安装对应平台产物（macOS 双击 `.dmg` 拖入 Applications）
2. 打开应用 → 启动页显示（logo/版本/检查更新/进入）
3. 首次使用：点「进入」→ 在 Web 界面设置 **DeepSeek API Key**
4. 顶栏齿轮 = 设置（皮肤切换/定制、回到主界面、返回启动窗口）

## ⚠️ 注意

- 用户数据存放在 `~/.dsh`（与安装目录分离），卸载后保留
- 服务监听 `http://127.0.0.1:3080`
- **关闭窗口 = 隐藏**，Dock 点击恢复；Cmd+Q / Dock 右键退出才真正停服
- 启动页「检查更新」从 GitHub Release 拉取最新 DMG（需网络；Release 需有对应版本资产）

## QQ 远程交互

> QQ 桥插件（`@dsh-qq/qq-bridge`）已独立成单独项目，见私有仓库 **WanShengling**（本地 `~/Documents/DshDesktop/dsh-qq-bridge/`），本仓库通过构建脚本从独立仓库注入。配置 NapCat 后即可通过 QQ 向 Harness 发任务并接收回复。

### 部署 NapCat（macOS 注入版，当前运行方式）

> macOS 上 NapCat Shell 版无法独立运行（`wrapper.node` 是 QQ 的 Electron 原生模块，纯 Node 加载崩溃；官方仅 Win/Linux 支持 Shell）。macOS 唯一可行路径 = **注入/Framework 方式**，详见 `napcat/README.md`。

1. **准备一个 QQ 号**（建议小号），并在该 QQ 登录的设备上完成扫码/验证
2. **注入 NapCat 到 QQ 2.app**：运行 `~/Downloads/NapCatQQ-4.18.19/macos-install.sh`（修改 `/Applications/QQ 2.app` 的 `package.json` main 指向 NapCat 加载器）
3. **启动 QQ 2.app**：`open -a QQ 2.app` → NapCat 随 QQ 启动，正向 WS 监听 `127.0.0.1:3001`（token 见配置）
4. **恢复原版**：`cp "/Applications/QQ 2.app/Contents/Resources/app/package.json.bak" "/Applications/QQ 2.app/Contents/Resources/app/package.json"`

> Windows/Linux 可用 NapCat Shell 版（`node napcat.mjs` 扫码登录，WebUI 开正向 WS），桥地址/端口按实际配置。

### 部署 NapCat（Windows Shell 版）

> Windows 是 NapCat **官方第一支持平台**（Shell 独立运行，无需注入 QQ）。桌面壳启动时自动从本机 NapCat onebot 配置读 token 注入桥（`DSH_QQ_ONEBOT_TOKEN`），无需手填。

**安装包自带 node.exe 与 `napcat-win.bat` 一键脚本 —— 用户无需手动安装 Node.js。**

1. **安装 DeepSeek Harness**：运行 `DeepSeekHarnessSetup-*.exe`，安装目录含 `napcat-win.bat`
2. **下载 NapCat(首次)**：双击运行 `napcat-win.bat install` → 自动下载解压 `NapCat.Shell` 到 `%USERPROFILE%\.napcat`(或手动从 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.zip`)
3. **启动 NapCat**：双击 `napcat-win.bat` → 用**未登录的 QQ 小号**扫码登录
4. **配置 OneBot 11**：WebUI(`http://127.0.0.1:6099/webui`)或 `config/onebot11_<qq>.json`，开**正向 WebSocket** 监听 `127.0.0.1:3001`，token 自定
5. **连接桥**：桌面壳自动读该 token 注入（无需改代码/配置）；若想手填，见下节"连接桥"

> 脚本使用应用内置的 `resources/node/node.exe`，不依赖系统 Node.js；全程零额外安装。

### 连接桥

1. 设置桥的 WS 地址（任选其一）：
   - **环境变量（推荐）**：桌面壳透传 `DSH_QQ_ONEBOT_WS=ws://127.0.0.1:3001`、`DSH_QQ_ONEBOT_TOKEN=<token>`
   - **profile 补丁**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，覆盖 `qq-bridge` 行的 `onebotWs`/`onebotToken`
2. 重启应用后，向该 QQ 号发消息即触发 Harness 会话：私聊与每个群各自映射独立会话，回复经 QQ 回传

### 行为说明

- 会话与 Web UI **完全共享**（同一 harness 实例），QQ 里发起/继续的会话在浏览器中可见、可续
- 群聊有能量/冷却节奏（不是每条都回）、人设（万生玲）、图片识别、文件记忆（chatlog/profiles）
- 私聊以 `!` 开头走**工作指令**（真实 DSH 代理，独立会话）；其余走人设
- 模型发起的**提问/审批**在 QQ 端默认自动拒绝并提示（`autoAnswer: reject`）

## 📄 许可

MIT。Harness 本体版权归 [DeepSeek AI](https://deepseek.com) 所有，见上游仓库。
