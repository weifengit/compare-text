#!/usr/bin/env bash
# =============================================================================
# package-offline-bundle.sh — 打一个离线安装包，方便拷到新电脑（不公开安装）。
#
# 产物：dist-dsh-offline/compare-text-dsh-plugin-<日期>.tar.gz
# 内容：
#   - 整个项目（含 .dsh/skills、plugins/dsh-compare-text、serve.js、
#     tools/dsh-report.js、tools/render.js、lib/、src/、index.html、styles.css）
#   - scripts/ 安装/卸载脚本
#   - docs/dsh-offline-install.md 说明文档
#   - 一个 INSTALL.txt 快捷指引
#
# 用法：
#   scripts/package-offline-bundle.sh              # 打包到 dist-dsh-offline/
#   scripts/package-offline-bundle.sh -o /path/out # 指定输出目录
# =============================================================================
set -euo pipefail

OUT_DIR="${1:-dist-dsh-offline}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) echo "用法: $0 [-o <输出目录>]"; exit 0 ;;
    *) OUT_DIR="$1"; shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR_ABS="$(cd "$PROJECT_ROOT" && mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
ARCHIVE="$OUT_DIR_ABS/compare-text-dsh-plugin-$STAMP.tar.gz"

echo "==> 打包项目（排除 node_modules / .git / 临时产物）..."
tar --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.dsh-tmp' \
    --exclude='.spike-out' \
    --exclude='.probe-out3b' \
    --exclude='dist' \
    --exclude='src-tauri/target' \
    --exclude='demo' \
    -czf "$ARCHIVE" \
    -C "$PROJECT_ROOT" \
    .dsh/skills plugins serve.js tools lib src index.html styles.css \
    scripts docs/dsh-offline-install.md package.json README.md LICENSE 2>/dev/null

# 生成快捷指引
cat > "$OUT_DIR_ABS/INSTALL.txt" <<'EOF'
======================== 离线安装 compare-text 到 DeepSeek Harness ========================

【新电脑步骤】（已装 Node + pnpm + dsh 的情况下）

1. 解压本包到固定路径，例如：
   macOS:   ~/code/compare-text
   Windows: D:\code\compare-text

2. 安装（在解压后的项目根目录执行）：
   macOS / Linux:  bash scripts/install-dsh-plugin.sh
   Windows:        powershell -ExecutionPolicy Bypass -File .\scripts\install-dsh-plugin.ps1

   脚本会：① 复制技能到 ~/.dsh/skills/compare-report
           ② 执行 dsh plugin --profile web add ./plugins/dsh-compare-text
           ③ 用 dsh --profile web --dump-config 验证

3. 重启 DSH：dsh web，打开 http://127.0.0.1:3080
   聊天输入框工具行出现「⇄ 文本对比」入口 = 插件 OK（想换位置改
   plugins/dsh-compare-text/cordis.patch.yml 的 config.entry）；
   对话里说「对比这两个文件夹的合同，出报告」= 技能 OK。

4. 卸载：bash scripts/uninstall-dsh-plugin.sh
         或 .\scripts\uninstall-dsh-plugin.ps1

详细文档见 docs/dsh-offline-install.md
========================================================================================
EOF

echo "==> 已生成:"
echo "    $ARCHIVE"
echo "    $OUT_DIR_ABS/INSTALL.txt"
echo ""
echo "把这两个文件拷到新电脑即可（U盘 / 局域网 / 网盘）。"
