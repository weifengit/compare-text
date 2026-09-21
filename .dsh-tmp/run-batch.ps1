$ErrorActionPreference = 'Continue'
$root = 'E:\code\compare-text\docs'
$render = 'E:\code\compare-text\tools\render.js'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$workDir = 'E:\code\compare-text'
$temp = Join-Path $env:TEMP ("dsh-batch-" + $PID)
New-Item -ItemType Directory -Path $temp -Force | Out-Null

$jobs = New-Object System.Collections.ArrayList   # each: { name, cmdLine, outFile, errFile, output }

# ---------- 构建所有任务 ----------
$aDirs = Get-ChildItem -Path $root -Directory
foreach ($a in $aDirs) {
  foreach ($sub in (Get-ChildItem -Path $a.FullName -Directory)) {
    $files = @(Get-ChildItem -Path $sub.FullName -File)
    $gd = @($files | Where-Object { $_.Name -like '*广东确定*' })
    if ($gd.Count -ne 1) { continue }
    $others = @($files | Where-Object { $_.Name -notlike '*广东确定*' })
    if ($others.Count -eq 0) { continue }
    $pairs = @()
    foreach ($o in $others) {
      $pairs += , @{ left = $gd[0].FullName; right = $o.FullName }
    }
    $volCount = [math]::Ceiling($pairs.Count / 10.0)
    for ($v = 0; $v -lt $volCount; $v++) {
      $volPairs = @($pairs | Select-Object -Skip ($v * 10) -First 10)
      $base = $sub.Name
      $outName = if ($volCount -eq 1) { "$base.html" } else { "$base-$($v+1).html" }
      $output = Join-Path $a.FullName $outName
      $title = if ($volCount -eq 1) { "$base（基准：广东确定）" } else { "$base（基准：广东确定）（$($v+1)/$volCount）" }
      $task = @{
        title  = $title
        output = $output.Replace('\', '/')
        pairs  = $volPairs
      } | ConvertTo-Json -Depth 6
      $taskFile = Join-Path $temp ("task-" + [System.Guid]::NewGuid().ToString('N') + '.json')
      [System.IO.File]::WriteAllText($taskFile, $task, (New-Object System.Text.UTF8Encoding($false)))
      $outFile = Join-Path $temp ("out-" + [System.Guid]::NewGuid().ToString('N') + '.log')
      $errFile = Join-Path $temp ("err-" + [System.Guid]::NewGuid().ToString('N') + '.log')
      $cmdLine = '""' + $nodeExe + '" "' + $render + '" --task "' + $taskFile + '" > "' + $outFile + '" 2> "' + $errFile + '""'
      [void]$jobs.Add([pscustomobject]@{
        name = "$($a.Name)/$base"
        cmdLine = $cmdLine
        outFile = $outFile; errFile = $errFile; output = $output
      })
    }
  }
}

Write-Output "任务总数: $($jobs.Count)"

# ---------- 并发执行（最多 4 个；全部走 cmd 文件重定向，避免管道捕获） ----------
$maxConc = 4
$running = @{}   # pid -> job
$queue = New-Object System.Collections.Queue
foreach ($j in $jobs) { $queue.Enqueue($j) }
$results = New-Object System.Collections.ArrayList

while ($queue.Count -gt 0 -or $running.Count -gt 0) {
  while ($running.Count -lt $maxConc -and $queue.Count -gt 0) {
    $j = $queue.Dequeue()
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c ' + $j.cmdLine
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $true
    $psi.CreateNoWindow = $true
    try {
      $p = [System.Diagnostics.Process]::Start($psi)
      $running[$p.Id] = [pscustomobject]@{ proc = $p; job = $j }
      Write-Output ("开始: " + $j.name)
    } catch {
      [void]$results.Add([pscustomobject]@{ 品名 = $j.name; 状态 = '启动失败'; 输出 = ''; 说明 = $_.Exception.Message })
    }
  }
  if ($running.Count -eq 0) { break }
  $toRemove = @()
  foreach ($k in $running.Keys) {
    $r = $running[$k]
    try { $r.proc.Refresh() } catch {}
    if ($r.proc.HasExited) {
      $j = $r.job
      # 进程已结束：读结果文件
      $outText = ''
      if (Test-Path $j.outFile) { $outText = [System.IO.File]::ReadAllText($j.outFile, [System.Text.Encoding]::UTF8) }
      $lastLine = ($outText -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
      $ok = $false; $st = ''; $warns = ''
      if ($lastLine) {
        try {
          $j2 = $lastLine | ConvertFrom-Json
          $ok = $j2.ok
          $st = "pairs=$($j2.stats.pairs) added=$($j2.stats.added) removed=$($j2.stats.removed) changed=$($j2.stats.changed)"
          $warns = ($j2.warnings -join ' | ')
        } catch { $warns = '解析输出失败' }
      }
      $fileExists = Test-Path $j.output
      $status = if ($fileExists) { if ($ok) { '成功' } else { '部分失败' } } else { '无报告' }
      [void]$results.Add([pscustomobject]@{ 品名 = $j.name; 状态 = $status; 输出 = $j.output; 说明 = "$st ; $warns" })
      Write-Output ("完成: " + $j.name + " => " + $status + " | " + $st)
      $toRemove += $k
    }
  }
  foreach ($k in $toRemove) {
    try { $running[$k].proc.Dispose() } catch {}
    $running.Remove($k)
  }
  if ($running.Count -gt 0) { Start-Sleep -Milliseconds 1500 }
}

# ---------- 汇总 ----------
$csv = Join-Path $temp 'results.csv'
$results | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
$summary = Join-Path $env:TEMP 'dsh-batch-summary.txt'
$results | Format-Table -AutoSize -Wrap | Out-String -Width 250 | Set-Content -Path $summary -Encoding UTF8
Write-Output "===== 汇总 ====="
Write-Output "成功: $(@($results | Where-Object 状态 -eq '成功').Count)"
Write-Output "部分失败: $(@($results | Where-Object 状态 -eq '部分失败').Count)"
Write-Output "无报告: $(@($results | Where-Object 状态 -eq '无报告').Count)"
Write-Output "跳过: $(@($results | Where-Object 状态 -eq '跳过').Count)"
Write-Output "启动失败: $(@($results | Where-Object 状态 -eq '启动失败').Count)"
Write-Output "CSV: $csv"
Write-Output "SUMMARY: $summary"
