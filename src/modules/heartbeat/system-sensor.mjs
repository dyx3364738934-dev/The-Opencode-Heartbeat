/**
 * src/modules/heartbeat/system-sensor.mjs
 *
 * v0.9.23: 真 sensor — 一次 PowerShell 调用拿系统环境快照
 *
 * 输出（成功）:
 *   {
 *     top: [{ name, pid, cpu, mem }, ...5],
 *     memTotal, memUsedPct,
 *     diskUsedPct,
 *     foreground: "窗口标题",
 *     idleSec                              ← v0.9.23 manual #49: 鼠标+键盘真实 idle
 *   }
 *
 * 输出（失败）: null（调用方兜底渲染）
 *
 * 设计：
 *   - 用 -EncodedCommand 传递 PowerShell 脚本（绕开引号转义）
 *   - 单次 execFile，避免多次 spawn PowerShell 开销
 *   - 超时 5s（PowerShell 冷启动 ~500ms-1s，热启动 ~300ms）
 *   - Add-Type 编译 C# 拿前台窗口（首次启动 +200ms，之后缓存）
 */

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";

const POWERSHELL_TIMEOUT_MS = 5000;

// PowerShell 脚本：一次拿所有数据，输出 JSON
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

# top 5 CPU 进程
$top = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object {
  @{ name = $_.ProcessName; pid = $_.Id; cpu = [math]::Round($_.CPU, 1); mem = [math]::Round($_.WorkingSet64 / 1MB, 0) }
}

# 内存
$os = Get-CimInstance Win32_OperatingSystem
$memTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$memUsedPct = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize * 100, 0)

# 磁盘
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$diskUsedPct = [math]::Round(($disk.Size - $disk.FreeSpace) / $disk.Size * 100, 0)

# 前台窗口（C# Win32 API）
if (-not ('KorinaFg' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class KorinaFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
}
$h = [KorinaFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][KorinaFg]::GetWindowText($h, $sb, 256)
$fg = $sb.ToString()

# 鼠标+键盘真实 idle（v0.9.23 manual #49）
# GetLastInputInfo 返回上次输入时间，TickCount 当前时间，差就是 idle 秒数
if (-not ('KorinaIdle' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KorinaIdle {
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
"@
}
$lastInput = New-Object KorinaIdle+LASTINPUTINFO
$lastInput.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lastInput)
[void][KorinaIdle]::GetLastInputInfo([ref]$lastInput)
$idleSec = [math]::Round(([System.Environment]::TickCount - $lastInput.dwTime) / 1000, 0)

@{
  top = $top
  memTotal = $memTotal
  memUsedPct = $memUsedPct
  diskUsedPct = $diskUsedPct
  foreground = $fg
  idleSec = $idleSec
} | ConvertTo-Json -Compress -Depth 3
`;

let _cachedEncoding = null;

function getEncodedCommand() {
  if (_cachedEncoding) return _cachedEncoding;
  _cachedEncoding = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
  return _cachedEncoding;
}

export async function collectSystemSnapshot(timeoutMs = POWERSHELL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const encoded = getEncodedCommand();
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf-8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ error: err.message?.split("\n")[0] || "powershell failed" });
          return;
        }
        try {
          // PowerShell 输出可能带 BOM / 换行，先 trim
          const trimmed = stdout.trim();
          if (!trimmed) {
            resolve({ error: "empty output" });
            return;
          }
          const data = JSON.parse(trimmed);
          resolve(data);
        } catch (e) {
          resolve({ error: `parse failed: ${e.message?.slice(0, 60)}` });
        }
      }
    );
  });
}

/**
 * 把 snapshot 渲染成心跳用的多行字符串
 */
export function formatTopProcesses(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.top) || snapshot.top.length === 0) {
    return "  (sensor 不可用)";
  }
  // v0.9.23: CPU 是累计秒数（Get-Process.CPU），不是当前占用率
  // 转成 "Xh Ym" / "Xm" / "Xs" 让 oc 看了不误判
  return snapshot.top
    .map((p, i) => `  ${i + 1}. ${p.name}.exe  PID=${p.pid}  累计 ${humanizeCpuSec(p.cpu)}  MEM=${p.mem}MB`)
    .join("\n");
}

function humanizeCpuSec(sec) {
  if (sec == null || !isFinite(sec)) return "?";
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export function formatSystemStats(snapshot) {
  if (!snapshot || snapshot.error) return "";
  const mem = snapshot.memTotal ? `内存 ${snapshot.memUsedPct}% (${snapshot.memTotal}GB)` : "";
  const disk = snapshot.diskUsedPct != null ? ` · 磁盘 C: ${snapshot.diskUsedPct}%` : "";
  return mem + disk;
}

export function formatForeground(snapshot) {
  if (!snapshot || snapshot.error) return "(sensor 不可用)";
  return snapshot.foreground || "(无前台窗口 / 桌面)";
}
