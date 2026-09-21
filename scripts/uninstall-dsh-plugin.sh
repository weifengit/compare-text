#!/usr/bin/env bash
# =============================================================================
# uninstall-dsh-plugin.sh — 卸载 compare-text 的 DSH Skill + Plugin（macOS/Linux）
#
# 用法：
#   scripts/uninstall-dsh-plugin.sh                # 卸载 skill(全局) + plugin
#   scripts/uninstall-dsh-plugin.sh --profile web  # 指定 profile（默认 web）
# =============================================================================
set -euo pipefail

PROFILE="web"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    -h|--help) echo "用法: $0 [--profile <name>]"; exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

echo "==> 卸载 Plugin: dsh-compare-text (profile '$PROFILE')"
command -v dsh >/dev/null 2>&1 && dsh plugin --profile "$PROFILE" remove dsh-compare-text \
  || echo "   （dsh 不在 PATH，跳过 plugin 卸载；可手动编辑 $DSH_HOME/profiles/$PROFILE/package.json）"

echo "==> 删除全局 Skill: compare-report"
if [[ -d "$DSH_HOME/skills/compare-report" ]]; then
  rm -rf "$DSH_HOME/skills/compare-report"
  echo "   ✔ 已删除 $DSH_HOME/skills/compare-report"
else
  echo "   （未找到，跳过）"
fi

echo "✅ 完成。重启 DSH 后生效。"
