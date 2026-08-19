@echo off
rem ============================================================
rem  DeepSeek Harness — Windows NapCat 一键启动(Shell 版)
rem  使用应用内置的 node.exe,用户无需安装 Node.js
rem  用法:  napcat.bat               启动(首次需扫码登录)
rem         napcat.bat install       下载 NapCat.Shell 到 %USERPROFILE%\.napcat
rem ============================================================
setlocal
set "APP_DIR=%~dp0.."
set "NODE=%APP_DIR%\resources\node\node.exe"
set "NAPCAT_DIR=%USERPROFILE%\.napcat"
set "NAPCAT_ZIP=%NAPCAT_DIR%\NapCat.Shell.zip"
set "NAPCAT_URL=https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip"

if not exist "%NODE%" (
  echo [ERROR] 未找到内置 Node: %NODE%
  echo 请确认从 DeepSeek Harness 安装目录运行(安装包自带 node,无需手动装)。
  pause
  exit /b 1
)

rem ---- install: 下载并解压 NapCat Shell ----
if /i "%~1"=="install" (
  if not exist "%NAPCAT_DIR%" mkdir "%NAPCAT_DIR%"
  echo 正在下载 NapCat.Shell...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri '%NAPCAT_URL%' -OutFile '%NAPCAT_ZIP%'"
  if errorlevel 1 ( echo [ERROR] 下载失败,请检查网络或手动下载后放至 %NAPCAT_ZIP% & pause & exit /b 1 )
  echo 解压中...
  powershell -NoProfile -Command "Expand-Archive -Path '%NAPCAT_ZIP%' -DestinationPath '%NAPCAT_DIR%\shell' -Force"
  echo 完成。运行 napcat.bat 启动。
  pause
  exit /b 0
)

rem ---- 检查 NapCat 是否已下载 ----
if not exist "%NAPCAT_DIR%\shell\napcat.mjs" (
  echo 首次运行需要下载 NapCat。请先执行: napcat.bat install
  pause
  exit /b 1
)

rem ---- 启动 NapCat(用内置 node) ----
echo 启动 NapCat(内置 Node: %NODE%)
echo 首次启动会显示二维码,用要作为机器人的 QQ 号扫码登录。
cd /d "%NAPCAT_DIR%\shell"
"%NODE%" napcat.mjs
