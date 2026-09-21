<#
=============================================================================
install-dsh-plugin.ps1 — 把 compare-text 的 DSH Skill + Plugin 离线装进
DeepSeek Harness（Windows PowerShell 5.1+ / PowerShell 7）。

用法：
  .\scripts\install-dsh-plugin.ps1                 # 安装 skill(全局) + plugin
  .\scripts\install-dsh-plugin.ps1 -SkillOnly      # 只装 skill
  .\scripts\install-dsh-plugin.ps1 -PluginOnly     # 只装 plugin
  .\scripts\install-dsh-plugin.ps1 -Profile tui    # 指定 profile（默认 web）

全程本地文件操作，不发布 npm / GitHub，不联网。
=============================================================================
#>
[CmdletBinding()]
param(
  [string]$Profile = "web",
  [switch]$SkillOnly,
  [switch]$PluginOnly
)

$ErrorActionPreference = "Stop"

# ---- 定位项目根（本脚本所在目录的上级） ----
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$SkillSrc = Join-Path $ProjectRoot ".dsh\skills\compare-report"
$PluginDir = Join-Path $ProjectRoot "plugins\dsh-compare-text"

Write-Host "==> 项目根: $ProjectRoot"

$Mode = if ($SkillOnly) { "skill" } elseif ($PluginOnly) { "plugin" } else { "all" }

# ---- 前置检查 ----
function Check-Cmd($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "✗ 缺少 $Name，请先安装（见 docs\dsh-offline-install.md 第 2 节）" -ForegroundColor Red
    exit 1
  }
}

if ($Mode -ne "skill") {
  Check-Cmd "node"
  Check-Cmd "pnpm"
  Check-Cmd "dsh"
}

# ---- 计算 DSH_HOME（与 dsh 一致：$DSH_HOME 优先，否则 %USERPROFILE%\.dsh） ----
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
Write-Host "==> DSH_HOME: $DshHome"

# ============ 1) Skill ============
if ($Mode -eq "all" -or $Mode -eq "skill") {
  Write-Host ""
  Write-Host "==> 安装 Skill: compare-report"
  if (-not (Test-Path (Join-Path $SkillSrc "SKILL.md"))) {
    Write-Host "✗ 找不到技能文件: $SkillSrc\SKILL.md" -ForegroundColor Red
    exit 1
  }
  New-Item -ItemType Directory -Force (Join-Path $DshHome "skills") | Out-Null
  Copy-Item -Recurse -Force $SkillSrc (Join-Path $DshHome "skills\compare-report")
  Write-Host "   ✔ 已复制到 $DshHome\skills\compare-report\SKILL.md"
  Write-Host "   （新开会话后技能列表应出现 compare-report；若会话工作目录在项目内，本步其实可省）"
}

# ============ 2) Plugin ============
if ($Mode -eq "all" -or $Mode -eq "plugin") {
  Write-Host ""
  Write-Host "==> 安装 Plugin: dsh-compare-text -> profile '$Profile'"
  if (-not (Test-Path (Join-Path $PluginDir "package.json"))) {
    Write-Host "✗ 找不到插件包: $PluginDir\package.json" -ForegroundColor Red
    exit 1
  }
  # 在项目根执行，用相对路径让 dsh 以项目根为基准解析
  Push-Location $ProjectRoot
  try {
    & dsh plugin --profile $Profile add ".\plugins\dsh-compare-text"
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
  Write-Host ""
  Write-Host "==> 验证（应看到 # == dsh-compare-text 层）"
  $dump = & dsh --profile $Profile --dump-config 2>&1 | Out-String
  if ($dump -match "dsh-compare-text") {
    Write-Host "   ✔ 插件已注册到 profile '$Profile'"
  } else {
    Write-Host "✗ 未在配置树里找到 dsh-compare-text，请检查上面 dsh plugin 的输出" -ForegroundColor Red
    exit 1
  }
}

# ============ 3) 收尾 ============
Write-Host ""
Write-Host "✅ 完成。下一步：" -ForegroundColor Green
Write-Host "   1) 重启 DSH：dsh web"
Write-Host "   2) 打开 http://127.0.0.1:3080，聊天输入框工具行会出现「⇄ 文本对比」入口"
Write-Host "   3) 对话里说「对比这两个文件夹的合同，出报告」即可用 compare-report 技能"
Write-Host ""
Write-Host "卸载：dsh plugin --profile $Profile remove dsh-compare-text ; Remove-Item -Recurse -Force $DshHome\skills\compare-report"
