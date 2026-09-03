# DeepSeek Harness 桌面版 — 桌面端交接文档 (HANDOFF-DESKTOP)

> **维护指令**:每次更新本文件时,在回复中输出一行 `666`(与根目录 HANDOFF.md 统一)。

> **用途**:记录**桌面端壳**(deepseek-harness-desktop 仓库,Electron 应用)的核心信息、架构、IPC 契约、关键坑与回滚要点。与根目录 `HANDOFF.md`(QQ 桥为主)互补:本文件专注壳本身。
> **生成时间**:2026-08-19(v0.2.6 原生优先架构定型后交接;同日复核:theme.js CSS 变量数 19→20,维护指令统一 666;晚场更新:额度壳内页面 v0.2.11 + assemble 增量模式;**2026-09-03 更新:v0.2.22→v0.3.1,上游并入 rc.2,见 §8-8**)
> **关联**:`README.md`(特性/构建)、`PRINCIPLES.md`(理念,含 8b 复查三遍)、根目录 `HANDOFF.md`(QQ 桥/整体运行状态)

---

## 1. 仓库与版本

| 项 | 值 |
|----|-----|
| 仓库 | `https://github.com/2384241295abc/DshDesk.git`(公开;remote 名为 `DshDesk`,注意大小写) |
| 本地路径 | `/Users/fuyunhuancheng/Documents/DshDesktop/deepseek-harness-desktop/` |
| 当前版本 | **v0.3.1**(package.json `version`;含 main.js refs 凭据补丁;v0.3.1 已装 `/Applications/DeepSeekHarness.app` + adhoc 重签,**尚未切换现役**) |
| 上游 harness | deepseek-harness **0.1.1-rc.2**(锁定 commit `b150a551`,build-harness.js 默认 HARNESS_COMMIT;旧 apiproxy 架构,QQ 桥免移植) |
| 架构 | Electron 37 + **同层 iframe** 壳(顶栏/启动页/工作台都在 shell.html 一个 web 内容里) |

**⚠️ 版本指纹铁律(规则 7)**:每次更新必须迭代 `package.json` version → 产物(assemble 后的 app)与源码 md5 一致 → DMG 以新版本命名。避免"改了代码打包的是旧产物"。

## 2. 架构总览(v0.2.6,iframe 同层)

```
┌──────────────────────────────────────────┐
│ 顶部导航栏(壳原生 UI:shell.html)           │ ← 页面切换/设置齿轮,始终可交互
├──────────────────────────────────────────┤
│ 启动页(launcher) / iframe(工作台 app-view) │ ← 同层:iframe 与壳同一 web 内容
└──────────────────────────────────────────┘
```

- **WebContentsView 已废弃**:原生层会盖住壳 web 内容(顶栏点不到/启动页残留),v0.2.6 改为 iframe 同层。
- **主窗口只有一个**(`shell.html`):顶栏 + 启动页 + iframe;DSH/NapCat 通过 iframe 嵌入(与壳同层,顶栏不被遮挡)。
- **CSP**(shell.html):`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://127.0.0.1:* http://localhost:*`
  - 🔴 **必须含 `img-src data:`**(否则皮肤 logo/背景图空白)与 **`frame-src http://127.0.0.1:*`**(否则 iframe DSH 被拦 → 黑屏/卡死)。两个都踩过坑。

## 3. 文件清单与职责

| 文件 | 职责 | 关键点 |
|------|------|--------|
| `app/main.js`(498 行) | 主进程:启动后端/页面/皮肤/更新/IPC/原生菜单 | 见 §4 |
| `app/theme.js`(123 行) | 皮肤接口:createSkin/registerSkin/deleteSkin/getSkin/listSkins;默认深色 + 浅色 | colors=20 个 CSS 变量(含 `--nav-h` 高度);images={logo, launcherBg, topbarBg};animations 预留;DEFAULT_LOGO 为 dataURI SVG |
| `app/pages.js`(38 行) | 页面注册表:registerPage/listPages/getPage | 页面 url 支持函数(惰性求值,NapCat token 即此) |
| `app/updater.js`(157 行) | 自动更新:fetchLatestRelease/download/mountDmg/installApp | 仅查 **macOS-arm64 DMG** 资产;REPO=`2384241295abc/DshDesk` |
| `app/napcat-auth.js`(41 行) | 读 NapCat WebUI token | 读 `webui.json`(port 6099,token) |
| `app/renderer/shell.html`(156 行) | 壳 UI:顶栏/启动页/iframe/CSP | nav-slot 需 `display:flex`(否则页面按钮纵向堆叠) |
| `app/renderer/shell.js`(215 行) | 壳渲染逻辑:LAYOUT 模块化、renderNav、视图切换、皮肤应用 | 见 §5 |
| `app/renderer/shell-preload.js`(33 行) | contextBridge 暴露 `window.dshShell.*`(IPC 封装) | |
| `app/renderer/splash.html`(58 行) | 启动加载页(透明小窗,后端就绪即关) | |

## 4. 主进程(main.js)关键流程

### 4.1 启动序列
```
app.whenReady → loadSkinState() → createSplash() → startHarness()
  → probeServer(3080 含 __DSH_BOOT__ 标记) 已就绪则跳过
  → portInUse 但非 DSH → 报错退出(提示 lsof kill)
  → spawn 内置 Node apps/cli/lib/bin.js web(detached,日志重定向 userData)
  → 轮询 probeServer(超时 120s) → splashDone → openUi
```
- **单实例锁**:`requestSingleInstanceLock`;二次启动 → `showUi()`(隐藏窗恢复)。
- **退出**:`before-quit` 置 isQuitting → `stopHarness()`(macOS kill 进程组 SIGTERM→SIGKILL 兜底;win32 taskkill /T /F)→ 真正 quit。窗口 ✕ = 仅隐藏(托盘常驻通知),Dock 点击 `activate` 恢复。

### 4.2 进程管理关键函数
- `appResourcesDir()`:macOS 是 `Contents/Resources`(**大写 R**——曾拼成 MacOS/resources 导致 node 运行时缺失)。
- `nodeExe()`:`Resources/node/node`(或 node.exe)。
- `harnessDir()`:`Resources/harness`(含 apps/cli/lib/bin.js)。
- `killGroup/groupAlive`:进程组管理(detached 的 node 会带子进程,需整组杀)。

### 4.3 页面与导航
- `registerBuiltinPages()`:注册 `main`(http://127.0.0.1:3080)与 `napcat`(url 函数读 WebUI token 拼 `?token=`)。新页面 = `registerPage({id,label,url})` + 自动出现在顶栏。
- `navigateTo(pageId)`:查页 → 回发 `shell:page-url` + `shell:active` → 壳设 iframe.src。
- `enterApp()` / `returnToLauncher()`:回发 `shell:entered` / `shell:return-launcher`,壳做 display 切换。

### 4.4 皮肤系统(原生菜单,无独立 web 窗口)
- 状态持久化:`userData/skin.json`(`{skin: name}`),启动 loadSkinState,切换 saveSkinState。
- `applySkin(name)`:存状态 + 回发 `shell:theme`(colors)+ `shell:skins`(全量,含当前名)。
- **定制入口 = 原生菜单**(`shell:open-skin-menu` IPC → `Menu.buildFromTemplate` popup):
  - 皮肤单选(radio)
  - 导入启动/工作台图(`dialog.showOpenDialog` → dataURI 存入 custom skin)
  - 主色基调(8 个预设 hex → `setSkinColor` 改 `--launcher-btn-bg/--launcher-accent`)
  - 应用自定义/恢复默认(`deleteSkin('custom')`)
  - 回到主界面 / 返回启动窗口
- 🔴 **铁律(原生优先,PRINCIPLES #2)**:壳自己的 UI(设置/皮肤定制/对话框)必须原生 Menu/dialog,**绝不开独立 web 窗口**。skineditor.html/js/preload 已删除——它就是反面教材(取消卡死/CSP 拦截/窗口互扰)。

### 4.5 自动更新
- IPC `shell:check-update` → `runUpdate()`:fetchLatestRelease → compareVersions → download(进度回调)→ mountDmg → installApp → unmountDmg → **只重启运行部分**(stopHarness+startHarness+刷新 iframe),不重启壳。
- `installApp`:mv 旧版为 .old 备份 → cp -R → 成功删 .old,失败回滚 → `xattr -dr com.apple.quarantine`(去隔离属性,网络下载必做)。
- 状态回发 `shell:update-status`(phase: checking/found/uptodate/downloading/installing/done/error)。

### 4.6 IPC 契约一览
| 方向 | 通道 | 载荷 |
|------|------|------|
| 壳→主 | `win:navigate` | pageId |
| 壳→主 | `win:get-page-url` | pageId(主进程回发 shell:page-url) |
| 壳→主 | `shell:set-skin` | skinName |
| 壳→主 | `shell:open-skin-menu` | —(主进程弹原生菜单) |
| 壳→主 | `shell:check-update` | — |
| 壳→主 | `shell:enter-app` | — |
| 壳→主 | `win:minimize/maximize/close`、`win:isMaximized`(handle) | — |
| 主→壳 | `shell:theme` | colors(20 CSS 变量) |
| 主→壳 | `shell:skins` | 全量 skins + 当前名 |
| 主→壳 | `shell:pages` | pages + active + version |
| 主→壳 | `shell:active` | pageId |
| 主→壳 | `shell:page-url` | pageId, url |
| 主→壳 | `shell:entered` / `shell:return-launcher` | — |
| 主→壳 | `shell:update-status` | {phase,text,percent?} |

## 5. 壳渲染(shell.js)要点

- **LAYOUT 模块化**:topbar/nav/settings/winControls,为未来自定义布局预留(show/order)。
- **视图状态机**:launcher ⇄ workspace(`showLauncher`/`showWorkspace`),display:none 切换;**nav 仅 body.entered 时渲染**(启动页不显示)。
- **皮肤应用**:`applySkinAssets(colors, images)` → CSS 变量注入 :root + launcher 背景图(backgroundImage cover)。
- **设置齿轮交互坑**:用 `pointerdown`(非 click)+ `e.preventDefault/stopPropagation`,否则与页面点击/重复触发冲突(曾反复出"打不开/点了没反应")。
- **preload 暴露**:`window.dshShell`(navigate/getPageUrl/checkUpdate/enterApp/openSkinMenu/minimize/maximize/close + on* 事件订阅),contextIsolation: true, nodeIntegration: false, sandbox: true。

## 6. 构建与产物(详见 README,此处只列铁律)

```bash
# 只改应用层(app/)时,无需重跑 harness 管线:
node build/assemble.js build/DeepSeekHarnessApp   # 约 3-5 分钟
hdiutil create -volname "DeepSeek Harness" -srcfolder build/DeepSeekHarnessApp/DeepSeekHarness.app -ov -format UDZO installers/DeepSeekHarness-macOS-<arch>-<ver>.dmg
```
- 🔴 **改插件后同步副本**(见根 HANDOFF §3.2):跑 `node build/sync-plugin.js` 一键同步 `dsh-qq-bridge/plugin` → resources/harness + build/packages 两处内嵌副本(rm+cp,与主仓库 HEAD 完全一致);`build/DeepSeekHarnessApp` 是 stale 可再生产物,已被删除,由 `node build/assemble.js` 从 resources/harness 重新生成,不会引入旧插件。否则 healProfiles 拉回旧版。
- 冒烟:`node build/smoke-test.js --app ...`(需 danger-full-access,修 ~/.dsh symlink)。
- CI:push `v*` tag 触发;三平台矩阵上传 artifact → 单一 release 作业收口(防竞态,c35da2b)。
- 发布:`git tag v0.2.x && git push origin v0.2.x`。

## 7. 回滚要点

| 场景 | 操作 |
|------|------|
| 壳 bug | 旧 DMG 在 `installers/`;或 git checkout 旧 tag |
| git 误操作 | **不要点 GitHub Desktop 的 Undo/Discard/Revert/Delete branch**;用 reflog/对象库恢复(mist.md 🔴) |
| 皮肤卡死/异常 | 删 `userData/skin.json` 回默认;或菜单"恢复默认" |
| 更新装坏 | 旧版备份在安装时 `.old` 目录;或重新下 DMG 手动装 |
| 后端 3080 残留 | `lsof -ti:3080 \| xargs kill -9` 后重开应用 |

## 8. 未决事项 / 下一步建议

1. **CI 验证**:v0.2.x tag 发布后确认 Release 资产齐全(4/4)与单一 release 作业无竞态。
2. **皮肤动画**:`animations` 接口已预留但未消费(进入/切换动画)。
3. **自定义布局**:LAYOUT 模块化已就绪,可做用户可编辑布局。
4. **重启优化**:`.mjs` 改动需用户手动重启 3080(restart-3080.sh 已废弃),后续可做壳内"重启运行部分"按钮(更新流程已有 stopHarness/startHarness 现成逻辑)。
5. **验证清单**:改壳后必查——①顶栏可点(iframe 不遮挡)②皮肤图片不空白(img-src data:)③iframe 能加载(frame-src)④nav-slot 不纵向堆叠(display:flex)⑤齿轮 pointerdown 不重复触发。
6. **✅ v0.2.11 已落地**:①**额度壳内页面**(pages.js 支持无 url 壳内视图 → balance 页与主界面/NapCat 并列顶部栏;shell.html `#balance-view` 居中卡片;shell.js `switchPage()` 三处联动(entered/active/page-url);数据走 `balance:get` IPC,密钥不落渲染器)。②**assemble 增量模式**:`.assemble-fingerprint.json` 指纹 → 未变 3 秒/仅 app 变 ~1 分钟/`--full` 全量;⚠️ 修复增量初版 appResDir 误指 Resources 顶层导致结构污染(固定 `Contents/Resources/app`)。③**产物瘦身**:harness rsync 排除 `packages/*/*/node_modules` → 4.5GB→3.0GB。④installers 已清旧仅留 0.2.11。**待办**:0.2.12 DMG 未打包、git 未提交(未决由用户决定)。
7. **✅ v0.2.12→v0.2.19 改动链(2026-08-20)**:
   - **v0.2.12**:额度页独立顶部栏(0.2.11 的延续打包)+ assemble 增量模式 + 产物瘦身
   - **v0.2.13**:修复**导航双触发致 iframe 反复重载崩溃** —— navigateTo 发 page-url+active 双事件,onActive 又调 switchPage→getPageUrl 回发,iframe 反复重载 DSH SPA → Chromium 崩溃。修复:setFrameUrl 同 URL 去重(lastFrameUrl)+ 职责分离(onActive 仅显示切换,iframe 加载唯一由 onPageUrl)+ 删除冗余 win:get-page-url IPC + 死代码 loadPageIntoFrame
   - **v0.2.14**:custom 皮肤持久化 —— saveCustomSkin/loadCustomSkin 到 userData/custom-skin.json(主色+launcherBg+appBg),启动 loadCustomSkin 先于 loadSkinState
   - **v0.2.15**:iframe sandbox 加 allow-clipboard-read/write(复制问题第一轮尝试,未根治)
   - **v0.2.16**:主进程放行剪贴板权限 —— 首版用 web-contents-created + contents.setPermissionRequestHandler,**启动崩溃**(splash 窗口的 webContents 无此方法);改 session.defaultSession.setPermissionRequestHandler
   - **v0.2.17**:session 级权限处理器(修复 0.2.16 崩溃);make-dmg.js 动态取挂载点(修复固定卷路径验证到旧版)
   - **v0.2.18**:修复 **custom 皮肤注册 bug** —— theme.getSkin(name) 对未注册皮肤返回 defaultSkin(真值兜底),customSkinDraft 用 if(!s) 永不创建 → 配置落到 defaultSkin、skin.json 恒写 default。修复:theme.js 新增 hasSkin(),customSkinDraft/saveCustomSkin/clearSkinImage 改用
   - **v0.2.19**:**复制重构根治** —— sandbox+permission handler 均无效(Chromium iframe async clipboard 权限不可靠),改为注入 polyfill 覆盖 navigator.clipboard.writeText → postMessage → 壳 → IPC clipboard:write → 主进程 clipboard.writeText。**更新按钮反馈修复**:uptodate 显示"已是最新"+disabled、idle 重置文案、error 可重试
   - **v0.2.20(未发布,CI #21 进行中)**:修复 **CI 发布失败根因** —— build-harness.js 插件路径 bug(path.dirname(proj) 少一层,插件源解析失败)+ CI 无 dsh-qq-bridge 仓库(WanShengling 公开,workflow 新增匿名克隆步骤)
   - **v0.2.21**:Windows 系统托盘(app/tray.js:Tray+菜单,仅 win32;macOS 走 Dock)
   - **v0.2.22**:updater Windows 分支(按平台选 DMG/exe 资产 + installWindowsExe 静默)+ README Windows NapCat 部署小节 + **smoke 原生模块探针改指顶层 @deepseek-ai 副本**(修复瘦身后 CI 冒烟失败根因;本地全量产物冒烟+QQ-E2E 全绿)
   - **新增 build/make-dmg.js**:统一打包+挂载 md5 校验+通过后才清理旧版(防误删;规则 10 血泪教训:手动 rm 曾误清 installers)
   - **版本**:0.2.11 → 0.2.22,installers 通常仅留最新 DMG
   - **⚠️ 已知**:CI v0.1.3 后一直红(v0.2.20/0.2.22 修),远端 Release 停在 v0.1.3 → 更新按钮对本地 0.2.x 恒显示"已是最新";待 CI #22(v0.2.22)发布成功后旧版可自动更新
   - **✅ 2026-08-20 Windows 移植准备**:①托盘(v0.2.21)②updater Windows 分支(v0.2.22)③NapCat Windows 文档 ④窗口/进程 win32 分支已有 ⑤CI 冒烟修复(smoke 探针→顶层副本,本地全量产物模拟 CI 全绿)。待 CI #22 验证发布链路。

---

*交接文档结束。接管者建议:先读 `PRINCIPLES.md`(理念)→ `app/main.js`(主进程)→ `app/renderer/shell.js`(壳渲染)→ 本文件 §4.6 IPC 契约,再动手改。*

## 9. 2026-09-03 变更(0.2.22→v0.3.1)

8. **✅ 上游并入 rc.2 + 版本 v0.3.0→v0.3.1**:①上游锁定从 rc.5(47f9438)→ **dsh-v0.1.1-rc.2**(b150a551)(避开 0.1.2 的 ApiProxy 删除迁移;入口 `apps/cli/lib/bin.js`、tsdown、profile.ts 旧格式在 rc.2 均未变,注入脚本仅需改锁点;profile.ts 的 `web:`→`bundles:` 改版只影响 0.1.2+ 的注入需另适配)。②**build-harness.js 新增**:rc.2 起 dsh-web-app 运行期 `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` → prod 剪枝后顶层缺失 → 同 landlock 先例拷贝 apps/web(13M)补齐。③**materialize3.js 修复(rc.2 依赖图变化暴露)**:replicateAllVirtualSiblings 原只沿 node_modules 链下钻,组目录(如 apps/cli)的 importer 嵌套依赖链补不到(readdirp 断链)→ 新增 `scanPackageRoots` 组根"包感知下探"(backfill 780→1866);顺带修 scan IIFE 作用域 bug(`scan is not defined`→声明式函数+scan(H))。④**trim.js**:加 argv[2] 残留 dest 目标参数——默认 dest 可能是运行中应用 cwd,递归 rm 会先清文件后 rmdir EBUSY,`catch` 只防崩溃不防部分破坏现役。⑤**main.js refs 凭据补丁合回仓库**(并行线在已装 .app 上的补丁,md5 0ee2c3a1):读取先认 `refs:` 缩进键、写入清除顶层行并写 refs 段(新版 credentials-local 只认 version/refs/records 顶层)。⑥**验证全绿**:注入锚点 md5 一致 → 隔离实例 boot+QQ 双消息 → 产物 smoke(内置 node/native/__DSH_BOOT__/QQ-E2E)exit 0 → DMG VALID。⑦安装:`/Applications/DeepSeekHarness.app` = v0.3.1(main.js+package.json 同步+adhoc 重签);`installers/0.3.1.dmg` 唯一留档。⑧**⏳ 未切换现役**(挂载卷实例运行中,非必要不重启;切换=用户手动退出挂载卷应用→启动 /Applications)。
