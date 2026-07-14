# korina 启动（强制前台，新可见窗口，Alt+Tab 切回）
# v0.9.3: 删除后台模式 — 只保留前台，korina 必须在可见窗口跑

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$nodePath = "D:\nodejs\node-v20.11.0-win-x64\node.exe"
# 兜底：node 在 PATH 里就用 node.exe
if (-not (Test-Path $nodePath)) { $nodePath = "node.exe" }

# 优雅关闭旧实例
$korinaPort = if ($env:KORINA_PORT) { [int]$env:KORINA_PORT } else { 9999 }
$old = Get-NetTCPConnection -LocalPort $korinaPort -State Listen -ErrorAction SilentlyContinue
if ($old) {
  Write-Host "关闭旧 korina (PID $($old.OwningProcess))..." -ForegroundColor Yellow

  # 先尝试 graceful shutdown（HTTPRouter 需要 Basic auth；不打印密码）
  try {
    $headers = @{}
    $pwdFile = "$root\logs\oc-password.txt"
    if (Test-Path $pwdFile) {
      $pwd = (Get-Content -LiteralPath $pwdFile -Raw | ConvertFrom-Json).password
      if ($pwd) {
        $auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pwd"))
        $headers.Authorization = "Basic $auth"
      }
    }
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$korinaPort/shutdown" -Method POST -Headers $headers -TimeoutSec 5
    Write-Host "  已发送 shutdown 请求" -ForegroundColor Gray
  } catch { Write-Host "  shutdown 端点不可用，直接关闭" -ForegroundColor Gray }

  # 等最多 15 秒让它自己退出（gracefulShutdown 会等待 sidecar 最多约 5 秒）
  $waited = 0
  while ($waited -lt 15) {
    $still = Get-Process -Id $old.OwningProcess -ErrorAction SilentlyContinue
    if (-not $still) { Write-Host "  旧进程已退出" -ForegroundColor Green; break }
    Start-Sleep -Seconds 1
    $waited++
  }

  # 还没退就强杀
  $still = Get-Process -Id $old.OwningProcess -ErrorAction SilentlyContinue
  if ($still) {
    Write-Host "  优雅关闭超时，强制终止" -ForegroundColor Red
    Stop-Process -Id $old.OwningProcess -Force
    Start-Sleep -Seconds 2
  }
}

# 清空 stderr 日志
$stderrLog = "$root\logs\korina-stderr.log"
if (Test-Path $stderrLog) { Clear-Content $stderrLog -ErrorAction SilentlyContinue }

# KORINA_PORT 已在 优雅关闭段 解析过，直接复用
Write-Host "=== korina v0.9.3 启动（前台模式）===" -ForegroundColor Cyan
Write-Host "  端口: $korinaPort" -ForegroundColor Gray
Write-Host "  日志: 实时输出到新窗口" -ForegroundColor Gray
Write-Host "  停止: 到新窗口内 Ctrl+C，或调 korina.ps1 stop" -ForegroundColor Yellow
Write-Host ""

# v0.9.3: 用 cmd /c start 打开新可见窗口（标题 = "korina v0.9.3"）
# 不阻塞当前终端。当前窗口显示"已启动"消息后立刻退出
$cmdLine = "`"$nodePath`" `"$root\src\main.mjs`""
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "start `"korina v0.9.3 — 前台 ($korinaPort)`" $cmdLine" -WorkingDirectory $root

Write-Host "`n[启动器] korina 窗口已弹出。Alt+Tab 切到 'korina v0.9.3' 看实时日志。" -ForegroundColor Green
Write-Host "[启动器] 关闭本窗口不会影响 korina 进程。" -ForegroundColor Gray
