<#
=============================================================================
uninstall-dsh-plugin.ps1 — 卸载 compare-text 的 DSH Skill + Plugin（Windows）

用法：
  .\scripts\uninstall-dsh-plugin.ps1                 # 卸载 skill(全局) + plugin
  .\scripts\uninstall-dsh-plugin.ps1 -Profile tui    # 指定 profile（默认 web）
=============================================================================
#>
[CmdletBinding()]
param(
  [string]$Profile = "web"
)

$ErrorActionPreference = "Stop"

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }

Write-Host "==> 卸载 Plugin: dsh-compare-text (profile '$Profile')"
if (Get-Command dsh -ErrorAction SilentlyContinue) {
  & dsh plugin --profile $Profile remove dsh-compare-text
} else {
  Write-Host "   （dsh 不在 PATH，跳过 plugin 卸载；可手动编辑 $DshHome\profiles\$Profile\package.json）"
}

Write-Host "==> 删除全局 Skill: compare-report"
$SkillPath = Join-Path $DshHome "skills\compare-report"
if (Test-Path $SkillPath) {
  Remove-Item -Recurse -Force $SkillPath
  Write-Host "   ✔ 已删除 $SkillPath"
} else {
  Write-Host "   （未找到，跳过）"
}

Write-Host "✅ 完成。重启 DSH 后生效。"
