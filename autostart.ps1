param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop', 'restart')]
  [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LlmGateway'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root 'server.js'
$Vbs = Join-Path $Root 'start-hidden.vbs'

# 端口以 data\config.json 为准（缺失时回落 8787）
$Port = 8787
$cfgPath = Join-Path $Root 'data\config.json'
if (Test-Path $cfgPath) {
  try {
    $cfgObj = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfgObj.port) { $Port = [int]$cfgObj.port }
  } catch { }
}

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
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    return $r
  } catch { return $null }
}

# 找出真正跑本项目的 node 进程（VBS 是非等待启动，wscript 早已退出，
# 所以 Stop-ScheduledTask 停不掉服务，必须按命令行匹配后结束进程）
function Get-GatewayProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Server*" }
}

function Stop-Gateway {
  $procs = @(Get-GatewayProcess)
  if ($procs.Count -eq 0) { return $false }
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return $true }
  }
  return $true
}

# 轮询健康检查，避免固定 sleep 太短导致误报失败
function Wait-Gateway {
  param([int]$TimeoutSec = 15)
  for ($i = 0; $i -lt ($TimeoutSec * 2); $i++) {
    $h = Get-GatewayHealth
    if ($h) { return $h }
    Start-Sleep -Milliseconds 500
  }
  return $null
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
    # 登录后延迟 8s 再拉起：等服务目录就绪，避免与桌面/同步工具抢 IO
    try { $trigger.Delay = 'PT8S' } catch { }
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $actionObj -Trigger $trigger `
      -Settings $settings -Principal $principal `
      -Description 'LLM Gateway - 本地大模型统一代理（开机自启）' | Out-Null

    Write-Host "已注册开机自启任务: $TaskName" -ForegroundColor Green
    # 先清掉可能残留的旧实例，避免端口占用导致新实例启动失败
    if (Stop-Gateway) { Write-Host "已结束旧的服务进程" }
    Start-ScheduledTask -TaskName $TaskName
    $h = Wait-Gateway -TimeoutSec 15
    if ($h) { Write-Host "服务已启动: http://127.0.0.1:$Port/  (active=$($h.active))" -ForegroundColor Green }
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
    if (Stop-Gateway) { Write-Host "已结束服务进程" -ForegroundColor Green }
  }

  'status' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
      $i = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Host "任务: $TaskName  状态: $($t.State)  上次运行: $($i.LastRunTime)  结果: $($i.LastTaskResult)"
      $delay = $null
      if ($t.Triggers -and $t.Triggers[0].Delay) { $delay = $t.Triggers[0].Delay }
      Write-Host ("触发器: 用户登录后启动" + $(if ($delay) { "（延迟 $delay）" } else { '' }))
    } else {
      Write-Host "任务未注册"
    }
    $procs = @(Get-GatewayProcess)
    if ($procs.Count -gt 0) { Write-Host "进程: PID $($procs.ProcessId -join ', ')" } else { Write-Host "进程: 未运行" -ForegroundColor Yellow }
    $h = Get-GatewayHealth
    if ($h) { Write-Host "HTTP: OK  active=$($h.active)  providers=$($h.providers)  uptime=$($h.uptime)s" -ForegroundColor Green }
    else { Write-Host "HTTP: 不可达 (127.0.0.1:$Port)" -ForegroundColor Yellow }
  }

  'start' {
    if (Get-GatewayHealth) { Write-Host '服务已在运行' -ForegroundColor Yellow }
    else { Start-ScheduledTask -TaskName $TaskName; [void](Wait-Gateway -TimeoutSec 15) }
    & $PSCommandPath -Action status
  }

  'stop' {
    # 停任务只对「任务仍在运行」有效；真正的 node 进程要单独结束
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (Stop-Gateway) { Write-Host '已停止服务（含 node 进程）' -ForegroundColor Green }
    else { Write-Host '服务本来就没在运行' -ForegroundColor Yellow }
  }

  'restart' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    [void](Stop-Gateway)
    Start-ScheduledTask -TaskName $TaskName
    [void](Wait-Gateway -TimeoutSec 15)
    & $PSCommandPath -Action status
  }
}
