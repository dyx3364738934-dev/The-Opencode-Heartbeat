# korina.ps1 - korina 守护进程管理脚本
#
# v0.9.22 schema 对齐版（重写）：
#   - heartbeat/session lock 文件按 port 命名（heartbeat.{port}.json / session.{port}.lock）
#   - switch-session 命令已删除（v0.9.2），用 HTTP POST /rebind 热切换到最新 session
#   - control.json 协议从未实现，全部改走 HTTP 端点
#   - 启动方式用 Start-Process node.exe -WindowStyle Normal（避免 cmd /c start 嵌套在 PS7 下丢失）
#
# 用法：
#   .\korina.ps1 start [watchPath]    启动 korina
#   .\korina.ps1 stop                 优雅停止（HTTP /shutdown，超时强杀）
#   .\korina.ps1 status               查状态（HTTP /status + heartbeat 文件）
#   .\korina.ps1 sessions             列出 oc 所有 session（HTTP /sessions）
#   .\korina.ps1 rebind               热切换到最新 oc session（HTTP /rebind）
#   .\korina.ps1 inject <text>        注入消息（HTTP /inject/intent）
#   .\korina.ps1 summarize            触发上下文压缩（HTTP /summarize）
#   .\korina.ps1 restart [watchPath]  stop + start

param(
    [Parameter(Position = 0)]
    [string]$Command = "status",

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$RestArgs
)

$ErrorActionPreference = "Continue"
if ($null -eq $RestArgs) { $RestArgs = @() }

# ============================================================
# 常量
# ============================================================

$KORINA_ROOT    = $PSScriptRoot
$ENTRY          = Join-Path $KORINA_ROOT "src\main.mjs"
$LOGS_DIR       = Join-Path $KORINA_ROOT "logs"
$LIVE_LOG       = Join-Path $LOGS_DIR "korina-live.log"
$LIVE_ERR       = Join-Path $LOGS_DIR "korina-live.err"
$OC_PWD_FILE    = Join-Path $LOGS_DIR "oc-password.txt"

# v0.9.8 (manual #30): heartbeat 按 port 命名（默认 9999）
$KORINA_PORT    = if ($env:KORINA_PORT) { [int]$env:KORINA_PORT } else { 9999 }
$HEARTBEAT_FILE = Join-Path $LOGS_DIR "heartbeat.$KORINA_PORT.json"
$KORINA_URL     = "http://127.0.0.1:$KORINA_PORT"

# ============================================================
# 辅助：HTTP Basic Auth（用 oc 密码）
# ============================================================

function Get-OcAuthHeader {
    # 优先用当前进程环境变量（oc 桌面版内置终端会注入）
    $pw = $env:OPENCODE_SERVER_PASSWORD
    if (-not $pw -and (Test-Path $OC_PWD_FILE)) {
        try { $pw = (Get-Content $OC_PWD_FILE -Raw | ConvertFrom-Json).password } catch {}
    }
    if (-not $pw) { return $null }
    $user = $env:OPENCODE_SERVER_USERNAME; if (-not $user) { $user = "opencode" }
    $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${user}:${pw}"))
    return @{ Authorization = "Basic $token"; "Content-Type" = "application/json" }
}

function Invoke-KorinaHttp {
    param([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 8)
    $headers = Get-OcAuthHeader
    if (-not $headers) { throw "无法获取 oc 密码（OPENCODE_SERVER_PASSWORD 未设 + oc-password.txt 不存在）" }
    $url = "$KORINA_URL$Path"
    $params = @{ Method = $Method; Uri = $url; Headers = $headers; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 5) }
    try {
        $r = Invoke-WebRequest @params
        return $r.Content | ConvertFrom-Json
    } catch {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            if ($code -eq 401) { throw "$url 返回 401（密码错误或过期）" }
            if ($code -eq 404) { throw "$url 返回 404（端点不存在）" }
            throw "$url HTTP $code"
        }
        throw "$url 连接失败：$($_.Exception.Message)"
    }
}

# ============================================================
# 辅助：进程检测
# ============================================================

function Get-KorinaProcess {
    # v0.9.8: 读 heartbeat.{port}.json，验证 PID 在线
    if (-not (Test-Path $HEARTBEAT_FILE)) { return $null }
    try {
        $hb = Get-Content $HEARTBEAT_FILE -Raw | ConvertFrom-Json
        if ($hb.pid) {
            $proc = Get-Process -Id $hb.pid -ErrorAction SilentlyContinue
            if ($proc) { return @{ Pid = $hb.pid; Process = $proc; Heartbeat = $hb } }
        }
    } catch {}
    return $null
}

function Test-HttpAlive {
    # /status 端点免认证（http-router.mjs NO_AUTH_PATHS）
    try {
        $r = Invoke-WebRequest -Uri "$KORINA_URL/status" -TimeoutSec 3 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# ============================================================
# 命令实现
# ============================================================

function Start-Korina {
    param([string]$WatchPath)

    if (Test-HttpAlive) {
        Write-Host "korina 已在运行（HTTP 响应正常）" -ForegroundColor Yellow
        Write-Host "如需重启请先 .\korina.ps1 stop"
        return
    }

    if (-not (Test-Path $ENTRY)) { Write-Host "找不到入口: $ENTRY" -ForegroundColor Red; return }
    if (-not $WatchPath) { $WatchPath = Join-Path $env:USERPROFILE "Desktop" }
    if (-not (Test-Path $LOGS_DIR)) { New-Item -ItemType Directory -Path $LOGS_DIR -Force | Out-Null }

    Write-Host "启动 korina (port=$KORINA_PORT)..." -ForegroundColor Cyan
    Write-Host "  监听路径: $WatchPath"
    Write-Host "  日志: 可见 cmd 窗口 + $LIVE_LOG"

    # v0.9.23: 用 cmd /c start "title" 开可见窗口，stdout 不重定向 → 日志实时显示在窗口里
    # main.mjs 内部已经双写（console + 文件），所以日志同时进 cmd 窗口和 korina-live.log
    # 注：之前用 -RedirectStandardOutput 导致 Windows 不给进程创建可见窗口（MainWindowHandle=0）
    $nodeExe = "node.exe"
    $cmdLine = "$nodeExe `"$ENTRY`" --watch `"$WatchPath`""
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c", "start `"korina v0.9.3 (port $KORINA_PORT)`" $cmdLine" `
        -WorkingDirectory $KORINA_ROOT
    Write-Host "  启动命令已发出，等 HTTP 起来..." -ForegroundColor Gray

    # 等 HTTP 起来（最多 15s）
    $ok = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Test-HttpAlive) { $ok = $true; break }
    }

    if ($ok) {
        $st = Invoke-WebRequest -Uri "$KORINA_URL/status" -TimeoutSec 3 -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
        Write-Host "korina 启动成功" -ForegroundColor Green
        Write-Host "  PID: $($st.pid)"
        Write-Host "  session: $($st.session)"
        Write-Host "  ocBase: $($st.ocBase)"
        Write-Host "  日志窗口标题: 'korina v0.9.3 (port $KORINA_PORT)' — Alt+Tab 切过去看实时日志" -ForegroundColor Gray
    } else {
        Write-Host "korina HTTP 15s 内未就绪，可能启动失败" -ForegroundColor Red
        Write-Host "请检查 'korina v0.9.3' 窗口的输出"
    }
}

function Stop-Korina {
    # 优先 HTTP /shutdown（graceful，loader.shutdown() 回收 sidecar）
    if (Test-HttpAlive) {
        Write-Host "发送 graceful shutdown..." -ForegroundColor Cyan
        try {
            $null = Invoke-KorinaHttp -Method POST -Path "/shutdown" -TimeoutSec 5
            # gracefulShutdown 最长约 13s（5s sidecar + 8s loader + 5s wait children）
            $waited = 0
            while ($waited -lt 20) {
                if (-not (Test-HttpAlive)) { Write-Host "已优雅退出" -ForegroundColor Green; return }
                Start-Sleep -Seconds 1; $waited++
            }
            Write-Host "graceful 超时，强杀" -ForegroundColor Yellow
        } catch {
            Write-Host "HTTP /shutdown 失败: $($_.Exception.Message)，强杀" -ForegroundColor Yellow
        }
    }

    $existing = Get-KorinaProcess
    if ($existing) {
        Stop-Process -Id $existing.Pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Host "已强杀 PID=$($existing.Pid)" -ForegroundColor Green
    } else {
        Write-Host "korina 未运行" -ForegroundColor Yellow
    }
}

function Get-KorinaStatus {
    if (Test-HttpAlive) {
        $st = Invoke-WebRequest -Uri "$KORINA_URL/status" -TimeoutSec 3 -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
        $age = if ($st.queue) { "" } else { "" }
        Write-Host "=== korina HTTP 状态 ===" -ForegroundColor Cyan
        Write-Host "  PID: $($st.pid)"
        Write-Host "  uptime: $($st.uptime)s"
        Write-Host "  session: $($st.session)"
        Write-Host "  bindingLocked: $($st.bindingLocked)"
        Write-Host "  ocBase: $($st.ocBase)"
        if ($st.queue) {
            Write-Host "  队列: $($st.queue.size) 当前 / $($st.queue.hourlyCount)/$($st.queue.hourlyLimit) 每小时" -ForegroundColor Gray
        }
        if ($st.ocReachable) {
            Write-Host "  oc 可达: $($st.ocReachable.alive) (latency=$($st.ocReachable.latencyMs)ms)" -ForegroundColor Gray
        }
        return
    }

    Write-Host "korina HTTP 未响应" -ForegroundColor Red
    $existing = Get-KorinaProcess
    if ($existing) {
        $hbTime = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$existing.Heartbeat.ts).LocalDateTime
        $ageSec = [math]::Round(((Get-Date) - $hbTime).TotalSeconds, 0)
        Write-Host "  进程在跑但 HTTP 不通: PID=$($existing.Pid), 心跳 ${ageSec}s 前" -ForegroundColor Yellow
        Write-Host "  可能正在启动中或卡死" -ForegroundColor Yellow
    } else {
        Write-Host "  进程未运行（heartbeat 文件不存在或 PID 无效）" -ForegroundColor Yellow
    }
}

function Get-OcSessions {
    try {
        $r = Invoke-KorinaHttp -Method GET -Path "/sessions" -TimeoutSec 10
        Write-Host "=== oc sessions (共 $($r.count) 条，按 updated 降序) ===" -ForegroundColor Cyan
        $sorted = $r.sessions | Sort-Object -Property updated -Descending -ErrorAction SilentlyContinue
        $sorted | Select-Object -First 15 | ForEach-Object {
            $dt = if ($_.updated) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.updated).LocalDateTime.ToString("MM/dd HH:mm") } else { "??" }
            $title = if ($_.title) { $_.title } else { "(无标题)" }
            $model = if ($_.model) { " [$($_.model)]" } else { "" }
            Write-Host ("  {0}  {1}  {2}{3}" -f $_.id, $dt, $title, $model)
        }
    } catch {
        Write-Host "获取 sessions 失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Invoke-KorinaRebind {
    # v0.9.2: 替代旧的 switch-session（已删除）
    # POST /rebind 自动绑到最新活跃 oc session
    try {
        $r = Invoke-KorinaHttp -Method POST -Path "/rebind" -TimeoutSec 15
        Write-Host "热切换成功: $($r.oldSession) -> $($r.newSession)" -ForegroundColor Green
    } catch {
        Write-Host "热切换失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Invoke-KorinaInject {
    param([string]$Text)
    if (-not $Text) { Write-Host "用法: .\korina.ps1 inject <text>" -ForegroundColor Red; return }
    try {
        $r = Invoke-KorinaHttp -Method POST -Path "/inject/intent" -Body @{ text = $Text; intent = "user"; source = "ps-script" } -TimeoutSec 15
        Write-Host "已注入: $Text" -ForegroundColor Green
        Write-Host "  ok: $($r.ok), intent: $($r.intent)"
    } catch {
        Write-Host "注入失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Invoke-KorinaSummarize {
    try {
        $r = Invoke-KorinaHttp -Method POST -Path "/summarize" -TimeoutSec 30
        Write-Host "已触发上下文压缩" -ForegroundColor Green
    } catch {
        Write-Host "压缩失败: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Restart-Korina {
    Stop-Korina
    Start-Sleep -Seconds 1
    Start-Korina -WatchPath ($RestArgs[0])
}

# ============================================================
# 主分发
# ============================================================

switch ($Command.ToLower()) {
    "start"     { Start-Korina -WatchPath $RestArgs[0] }
    "stop"      { Stop-Korina }
    "status"    { Get-KorinaStatus }
    "sessions"  { Get-OcSessions }
    "rebind"    { Invoke-KorinaRebind }
    "inject"    { Invoke-KorinaInject -Text ($RestArgs -join " ") }
    "summarize" { Invoke-KorinaSummarize }
    "restart"   { Restart-Korina }
    default {
        Write-Host "未知命令: $Command" -ForegroundColor Red
        Write-Host ""
        Write-Host "可用命令（v0.9.22 schema）:"
        Write-Host "  start [watchPath]    启动 korina"
        Write-Host "  stop                 优雅停止（HTTP /shutdown，超时强杀）"
        Write-Host "  status               查状态（HTTP /status）"
        Write-Host "  sessions             列 oc 所有 session（HTTP /sessions）"
        Write-Host "  rebind               热切换到最新 oc session（HTTP /rebind）"
        Write-Host "  inject <text>        注入消息（HTTP /inject/intent）"
        Write-Host "  summarize            触发上下文压缩（HTTP /summarize）"
        Write-Host "  restart [watchPath]  stop + start"
        Write-Host ""
        Write-Host "v0.9.22 变更:"
        Write-Host "  - 删除 switch <sessionId>（v0.9.2 已删端点）→ 用 rebind"
        Write-Host "  - control.json 协议从未实现 → 全走 HTTP"
        Write-Host "  - heartbeat.json → heartbeat.{port}.json（v0.9.8 manual #30）"
    }
}
