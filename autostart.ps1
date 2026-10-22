param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop', 'restart')]
  [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LlmGateway'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root 'server.js'
$Vbs = Join-Path $Root 'start-hidden.vbs'

function Resolve-Node {
  $candidates = @(
    'D:\Node\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw '未找到 node.exe，请先安装 Node.js'
}

function Write-HiddenLauncher {
  param([string]$NodePath)
  $vbsContent = @"
' 由 autostart.ps1 自动生成：无窗口启动 LLM Gateway
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Root"
sh.Run """$NodePath"" ""$Server""", 0, False
"@
  Set-Content -Path $Vbs -Value $vbsContent -Encoding ASCII
}

function Get-GatewayHealth {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 3
    return $r
  } catch { return $null }
}

switch ($Action) {

  'install' {
    $node = Resolve-Node
    Write-HiddenLauncher -NodePath $node
    Write-Host "Node: $node"
    Write-Host "服务目录: $Root"

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

    $actionObj = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" `
      -Argument "`"$Vbs`"" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $actionObj -Trigger $trigger `
      -Settings $settings -Principal $principal `
      -Description 'LLM Gateway - 本地大模型统一代理（开机自启）' | Out-Null

    Write-Host "已注册开机自启任务: $TaskName" -ForegroundColor Green
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    $h = Get-GatewayHealth
    if ($h) { Write-Host "服务已启动: http://127.0.0.1:8787/  (active=$($h.active))" -ForegroundColor Green }
    else { Write-Host "任务已启动但健康检查未通过，请查看 data\requests.log 或手动运行 node server.js 排查" -ForegroundColor Yellow }
  }

  'uninstall' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "已移除开机自启任务: $TaskName" -ForegroundColor Green
    } else {
      Write-Host "未找到任务 $TaskName"
    }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*$Server*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  'status' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
      $i = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Host "任务: $TaskName  状态: $($t.State)  上次运行: $($i.LastRunTime)  结果: $($i.LastTaskResult)"
    } else {
      Write-Host "任务未注册"
    }
    $h = Get-GatewayHealth
    if ($h) { Write-Host "HTTP: OK  active=$($h.active)  providers=$($h.providers)  uptime=$($h.uptime)s" -ForegroundColor Green }
    else { Write-Host "HTTP: 不可达 (127.0.0.1:8787)" -ForegroundColor Yellow }
  }

  'start'   { Start-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 2; & $PSCommandPath -Action status }
  'stop'    { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Write-Host '已停止' }
  'restart' { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; Start-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 2; & $PSCommandPath -Action status }
}
