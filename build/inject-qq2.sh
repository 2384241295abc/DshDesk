#!/bin/bash
# 针对 QQ 2.app (7.0.0-52194) 的 NapCat 注入脚本
# 用法: sudo bash inject-qq2.sh
# 作用:
#   1. 备份 QQ 2.app 原版 package.json -> package.json.bak
#   2. 修改 main 入口指向容器内 loadNapCat.js
#   3. 修正 loadNapCat.js 的 fallback 路径(从 QQ.app 改为相对路径,避免失败时启动错版本)
set -euo pipefail

APP_DIR="/Applications/QQ 2.app/Contents/Resources/app"
PKG="$APP_DIR/package.json"
DOC="$HOME/Library/Containers/com.tencent.qq/Data/Documents"
LOADER="$DOC/loadNapCat.js"

echo "=== NapCat 注入 QQ 2.app (7.0.0) ==="

echo "1) 检查文件..."
for f in "$LOADER" "$DOC/napcat/napcat.mjs" "$PKG"; do
  [ -f "$f" ] || { echo "   ❌ 缺少: $f"; exit 1; }
done
echo "   OK"

echo "2) 备份原入口..."
if [ -f "$PKG.bak" ]; then
  echo "   已存在备份 $PKG.bak（跳过）"
else
  cp "$PKG" "$PKG.bak" && echo "   已备份 -> $PKG.bak"
fi

echo "3) 修改 QQ 2.app main 入口..."
REL=$(node -e "process.stdout.write(require('path').relative('$APP_DIR','$LOADER'))")
node -e "
const fs = require('fs');
const p = '$PKG';
const o = JSON.parse(fs.readFileSync(p, 'utf8'));
o.main = '$REL';
fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
console.log('   main =', o.main);
"

echo "4) 修正 loadNapCat.js fallback(相对路径,指向 QQ 2.app 原版入口)..."
# fallback: 从 loadNapCat.js 所在位置出发,经 QQ 2.app 的 main 原入口
# 原版 main 是 ./application.asar/app_launcher/index.js,用绝对路径写死更稳妥
cat > "$LOADER" << 'EOF'
// NapCat loader for QQ (macOS) —— 注入 QQ 2.app (7.0.0)
const fs = require('fs');
(async () => {
  try {
    await import('file:///Users/fuyunhuancheng/Library/Containers/com.tencent.qq/Data/Documents/napcat/napcat.mjs');
  } catch (e) {
    // 加载失败时回退到原版 QQ 2.app 入口，避免白屏
    try {
      require('/Applications/QQ 2.app/Contents/Resources/app/application.asar/app_launcher/index.js');
    } catch (e2) { }
  }
})();
EOF
echo "   已更新"

echo ""
echo "=== 注入完成！ ==="
echo "  启动 QQ 2.app(NapCat): open -a 'QQ 2' --args --no-sandbox"
echo "  或 Finder 打开 /Applications/QQ 2.app"
echo "  恢复原版: sudo bash ~/Downloads/NapCatQQ-4.18.19/macos-restore.sh(改回 QQ.app 时用)"
echo "  NapCat WebUI: http://127.0.0.1:6099"
