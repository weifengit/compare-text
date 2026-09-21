#!/usr/bin/env bash
# =============================================================================
# install-dsh-plugin.sh — 把 compare-text 的 DSH Skill + Plugin 离线装进
# DeepSeek Harness（macOS / Linux）。
#
# 用法：
#   scripts/install-dsh-plugin.sh                # 安装 skill(全局) + plugin
#   scripts/install-dsh-plugin.sh --skill-only   # 只装 skill
#   scripts/install-dsh-plugin.sh --plugin-only  # 只装 plugin
#   scripts/install-dsh-plugin.sh --profile web  # 指定 profile（默认 web）
#
# 全程本地文件操作，不发布 npm / GitHub，不联网。
# =============================================================================
set -euo pipefail

# ---- 参数 ----
PROFILE="web"
MODE="all"          # all | skill | plugin
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --skill-only) MODE="skill"; shift ;;
    --plugin-only) MODE="plugin"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

# ---- 定位项目根（本脚本所在目录的上级） ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_SRC="$PROJECT_ROOT/.dsh/skills/compare-report"
PLUGIN_DIR="$PROJECT_ROOT/plugins/dsh-compare-text"

echo "==> 项目根: $PROJECT_ROOT"

# ---- 前置检查 ----
check_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "✗ 缺少 $1，请先安装（见 docs/dsh-offline-install.md 第 2 节）"; exit 1; }; }

if [[ "$MODE" != "skill" ]]; then
  check_cmd node
  check_cmd pnpm
  check_cmd dsh
fi

# ---- 计算 DSH_HOME（与 dsh 一致：$DSH_HOME 优先，否则 ~/.dsh） ----
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
echo "==> DSH_HOME: $DSH_HOME"

# ============ 1) Skill ============
if [[ "$MODE" == "all" || "$MODE" == "skill" ]]; then
  echo ""
  echo "==> 安装 Skill: compare-report"
  if [[ ! -f "$SKILL_SRC/SKILL.md" ]]; then
    echo "✗ 找不到技能文件: $SKILL_SRC/SKILL.md"; exit 1
  fi
  mkdir -p "$DSH_HOME/skills"
  cp -R "$SKILL_SRC" "$DSH_HOME/skills/compare-report"
  echo "   ✔ 已复制到 $DSH_HOME/skills/compare-report/SKILL.md"
  echo "   （新开会话后技能列表应出现 compare-report；若会话工作目录在项目内，本步其实可省）"
fi

# ============ 2) Plugin ============
if [[ "$MODE" == "all" || "$MODE" == "plugin" ]]; then
  echo ""
  echo "==> 安装 Plugin: dsh-compare-text -> profile '$PROFILE'"
  if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
    echo "✗ 找不到插件包: $PLUGIN_DIR/package.json"; exit 1
  fi
  # 在项目根执行，用相对路径让 dsh 以项目根为基准解析
  ( cd "$PROJECT_ROOT" && dsh plugin --profile "$PROFILE" add "./plugins/dsh-compare-text" )
  echo ""
  echo "==> 验证（应看到 # == dsh-compare-text 层）"
  dsh --profile "$PROFILE" --dump-config | grep -i "compare" || {
    echo "✗ 未在配置树里找到 dsh-compare-text，请检查上面 dsh plugin 的输出"; exit 1; }
  echo "   ✔ 插件已注册到 profile '$PROFILE'"
fi

# ============ 3) 收尾 ============
echo ""
echo "✅ 完成。下一步："
echo "   1) 重启 DSH：dsh web"
echo "   2) 打开 http://127.0.0.1:3080，聊天输入框工具行会出现「⇄ 文本对比」入口"
echo "   3) 对话里说「对比这两个文件夹的合同，出报告」即可用 compare-report 技能"
echo ""
echo "卸载：dsh plugin --profile $PROFILE remove dsh-compare-text && rm -rf $DSH_HOME/skills/compare-report"
