param(
  [int]$TargetStreak99 = 999999,
  [int]$MinScore = 99,
  [int]$MaxRuns = 100000000,
  [int]$ReportEvery = 20,
  [int]$MacroRetries = 3,
  [string]$AppUrl = "http://127.0.0.1:3000",
  [string]$Preset = "progressive"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $projectRoot "logs"
$reportDir = Join-Path $logsDir "aesthetic_loop_v5_reports"
$masterReportPath = Join-Path $reportDir "aesthetic-loop-v5-report.md"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$scores = New-Object System.Collections.Generic.List[double]
$streak99 = 0
$goodRuns = 0
$evalRuns = 0
$systemFails = 0

function Get-LatestMacroRunId {
  param([string]$BaseLogsDir)
  $latest = Get-ChildItem $BaseLogsDir -File -Filter "*__macro-*.json" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) { return $null }
  $base = [IO.Path]::GetFileNameWithoutExtension($latest.Name)
  if ($base -match "__macro-(\d{8}-\d{6})-\d{2}$") { return $Matches[1] }
  return $null
}

function Get-Trend {
  param([double]$Current, [System.Collections.Generic.List[double]]$ScoreList)
  if ($ScoreList.Count -le 1) { return "flat" }
  $prev = $ScoreList[$ScoreList.Count - 2]
  if ($Current -gt $prev) { return "up" }
  if ($Current -lt $prev) { return "down" }
  return "flat"
}

function Get-Avg5 {
  param([System.Collections.Generic.List[double]]$ScoreList)
  $take = [Math]::Min(5, $ScoreList.Count)
  if ($take -le 0) { return 0.0 }
  $sum = 0.0
  for ($i = $ScoreList.Count - $take; $i -lt $ScoreList.Count; $i++) { $sum += [double]$ScoreList[$i] }
  return [Math]::Round($sum / $take, 2)
}

function Write-CheckpointReports {
  param(
    [string]$BaseLogsDir,
    [string]$BaseReportDir,
    [string]$MasterPath,
    [int]$Window
  )
  $evalFiles = Get-ChildItem $BaseLogsDir -File -Filter "macro-eval-*.json" | Sort-Object LastWriteTime -Descending
  if (-not $evalFiles -or $evalFiles.Count -eq 0) { return $null }
  $take = [Math]::Min($Window, $evalFiles.Count)
  $selected = @($evalFiles | Select-Object -First $take | Sort-Object Name)
  $runErrorMap = @{}
  $globalErrorMap = @{}
  $runLines = New-Object System.Collections.Generic.List[string]
  $allRows = New-Object System.Collections.Generic.List[object]
  foreach ($f in $selected) {
    try {
      $eval = Get-Content $f.FullName -Raw | ConvertFrom-Json
    } catch {
      continue
    }
    $runId = [string]$eval.runId
    if (-not $runId) {
      $base = [IO.Path]::GetFileNameWithoutExtension($f.Name)
      if ($base -match "^macro-eval-(\d{8}-\d{6})$") { $runId = $Matches[1] } else { $runId = $base }
    }
    $rows = @($eval.rows)
    foreach ($r in $rows) { $allRows.Add($r) | Out-Null }
    $score = if ($rows.Count -gt 0) { [Math]::Round((($rows | Measure-Object -Property aestheticScore -Average).Average), 2) } else { 0.0 }
    $local = @{}
    foreach ($r in $rows) {
      foreach ($e in @($r.criticalErrors)) {
        if (-not $local.ContainsKey($e)) { $local[$e] = 0 }
        $local[$e]++
        if (-not $globalErrorMap.ContainsKey($e)) { $globalErrorMap[$e] = 0 }
        $globalErrorMap[$e]++
      }
    }
    $runErrorMap[$runId] = $local
    $top = if ($local.Count -eq 0) { "none" } else { ($local.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 5 | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ", " }
    $runLines.Add("- runId $runId | avgScore=$score | rows=$($rows.Count) | topErrors={$top}") | Out-Null
  }

  $overall = if ($allRows.Count -gt 0) { [Math]::Round((($allRows | Measure-Object -Property aestheticScore -Average).Average), 2) } else { 0.0 }
  $music = @($allRows | Where-Object { [string]$_.verdict -in @("Музыка", "Music") }).Count
  $calc = $allRows.Count - $music
  $topGlobalLines = if ($globalErrorMap.Count -eq 0) {
    @("- none")
  } else {
    @($globalErrorMap.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 | ForEach-Object { "- $($_.Key): $($_.Value)" })
  }
  $genIso = (Get-Date).ToString("s")
  $contentLines = @(
    "# AESTHETIC LOOP V5 REPORT",
    "",
    "- generatedAt: $genIso",
    "- source-evals: $($selected.Count)",
    "- totalRows: $($allRows.Count)",
    "- overallAvgScore: $overall",
    "- verdicts: Music=$music, Calc=$calc",
    "",
    "## Runs"
  )
  $contentLines += $runLines
  $contentLines += @("", "## Top errors (global)")
  $contentLines += $topGlobalLines
  $contentLines += @("")
  $content = $contentLines -join "`n"
  $content | Set-Content -Path $MasterPath -Encoding UTF8

  $rangeStart = [Math]::Max(1, $evalRuns - $selected.Count + 1)
  $rangeEnd = [Math]::Max($rangeStart, $evalRuns)
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $batchName = "aesthetic-loop-v5-report-runs-{0:D4}-{1:D4}__{2}.md" -f $rangeStart, $rangeEnd, $stamp
  $batchPath = Join-Path $BaseReportDir $batchName
  $content | Set-Content -Path $batchPath -Encoding UTF8
  return $batchPath
}

function Update-BridgeAutoGuard {
  param([string]$BaseLogsDir)
  $since = (Get-Date).AddHours(-1)
  $files = Get-ChildItem $BaseLogsDir -File -Filter "macro-eval-*.json" | Where-Object { $_.LastWriteTime -ge $since } | Sort-Object LastWriteTime
  if (-not $files -or $files.Count -eq 0) {
    Remove-Item Env:MACRO_BRIDGE_WHITELIST -ErrorAction SilentlyContinue
    return @{ mode = "normal"; avg = $null; rows = 0 }
  }
  $scores = New-Object System.Collections.Generic.List[double]
  foreach ($f in $files) {
    try {
      $eval = Get-Content $f.FullName -Raw | ConvertFrom-Json
    } catch {
      continue
    }
    foreach ($r in @($eval.rows)) {
      $scores.Add([double]($r.aestheticScore)) | Out-Null
    }
  }
  if ($scores.Count -eq 0) {
    Remove-Item Env:MACRO_BRIDGE_WHITELIST -ErrorAction SilentlyContinue
    return @{ mode = "normal"; avg = $null; rows = 0 }
  }
  $avg = [Math]::Round((($scores | Measure-Object -Average).Average), 2)
  # Softer auto-tuning: activate only on sustained weak period with enough samples.
  if ($scores.Count -ge 30 -and $avg -lt 65) {
    $env:MACRO_BRIDGE_WHITELIST = "7,5"
    return @{ mode = "guard_7_5"; avg = $avg; rows = $scores.Count }
  }
  Remove-Item Env:MACRO_BRIDGE_WHITELIST -ErrorAction SilentlyContinue
  return @{ mode = "normal"; avg = $avg; rows = $scores.Count }
}

Write-Host "AESTHETIC_LOOP_V5 start | targetStreak99=$TargetStreak99 | minScore=$MinScore | reportEvery=$ReportEvery"

for ($run = 1; $run -le $MaxRuns; $run++) {
  $guard = Update-BridgeAutoGuard -BaseLogsDir $logsDir
  $ok = $false
  for ($attempt = 1; $attempt -le $MacroRetries; $attempt++) {
    $env:APP_URL = $AppUrl
    $env:MACRO_COUNT = "1"
    $env:MACRO_PRESET = $Preset
    # Rollback seed replay mode: loop always runs on fresh random seeds unless explicitly started outside this script.
    Remove-Item Env:MACRO_REPLAY_SEEDS_FILE -ErrorAction SilentlyContinue
    npm run macro:progressive-logs
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Start-Sleep -Seconds 2
  }

  if (-not $ok) {
    $systemFails++
    Write-Host "RUN $run | score=NA | rate=NA | avg5=NA | trend=flat | fails=1 | streak99=$streak99 | sysFails=$systemFails | macro-failed"
    continue
  }

  $runId = Get-LatestMacroRunId -BaseLogsDir $logsDir
  if (-not $runId) {
    $systemFails++
    Write-Host "RUN $run | score=NA | rate=NA | avg5=NA | trend=flat | fails=1 | streak99=$streak99 | sysFails=$systemFails | runId-missing"
    continue
  }

  $env:MACRO_RUN_ID = $runId
  $env:MACRO_EVAL_NAME = "macro-eval-$runId"
  npm run macro:evaluate
  if ($LASTEXITCODE -ne 0) {
    $systemFails++
    Write-Host "RUN $run | runId=$runId | score=NA | rate=NA | avg5=NA | trend=flat | fails=1 | streak99=$streak99 | sysFails=$systemFails | eval-failed"
    continue
  }

  $evalPath = Join-Path $logsDir ("macro-eval-$runId.json")
  if (-not (Test-Path $evalPath)) {
    $systemFails++
    Write-Host "RUN $run | runId=$runId | score=NA | rate=NA | avg5=NA | trend=flat | fails=1 | streak99=$streak99 | sysFails=$systemFails | eval-missing"
    continue
  }

  $eval = Get-Content $evalPath -Raw | ConvertFrom-Json
  $rows = @($eval.rows)
  $score = [double](($rows | Measure-Object -Property aestheticScore -Average).Average)
  if (-not $score) { $score = 0.0 }
  $score = [Math]::Round($score, 2)
  $fails = @($rows | ForEach-Object { @($_.criticalErrors).Count } | Measure-Object -Sum).Sum

  $scores.Add($score)
  $evalRuns++
  $isGood = ($score -ge $MinScore -and $fails -eq 0)
  if ($isGood) { $streak99++; $goodRuns++ } else { $streak99 = 0 }
  $rate = if ($evalRuns -gt 0) { [Math]::Round(100.0 * $goodRuns / $evalRuns, 1) } else { 0.0 }
  $avg5 = Get-Avg5 -ScoreList $scores
  $trend = Get-Trend -Current $score -ScoreList $scores
  $guardMode = [string]$guard.mode
  $guardAvg = if ($null -ne $guard.avg) { [string]$guard.avg } else { "NA" }
  $guardRows = [int]$guard.rows
  Write-Host "RUN $run | runId=$runId | score=$score | rate=$rate% | avg5=$avg5 | trend=$trend | fails=$fails | streak99=$streak99 | sysFails=$systemFails | guard=$guardMode | hourAvg=$guardAvg | hourRows=$guardRows"

  if ($ReportEvery -gt 0 -and ($run % $ReportEvery -eq 0)) {
    npx tsx scripts/extract-golden-dna.ts --save | Out-Null
    $batchPath = Write-CheckpointReports -BaseLogsDir $logsDir -BaseReportDir $reportDir -MasterPath $masterReportPath -Window $ReportEvery
    if ($batchPath) {
      Write-Host "[report] cycle checkpoint at run=$run | batch=$(Split-Path -Leaf $batchPath)"
    } else {
      Write-Host "[report] cycle checkpoint at run=$run | no-evals"
    }
  }
}
