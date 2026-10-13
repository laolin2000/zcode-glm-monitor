# open-monitor.ps1 - open the ZCode / Zhipu usage monitor window.
# Window IS the program: ensure the service, place the window, open the float.
# When the window is closed the service exits by itself (no resident background process).
# Geometry: reuse the last remembered position (float-position.json); if missing or unusable,
# use the default: right side of the screen, ~0.34 of screen width, nearly full height.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI and non-ASCII
# comments can break parsing (it ate a newline and produced a parser error once).
param(
  [switch]$Daemon          # service only, no window (for browser-only monitoring)
)

$ErrorActionPreference = 'SilentlyContinue'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $base 'float\float-config.json'
$posPath = Join-Path $base 'float-position.json'
$vbs = Join-Path $base 'run-hidden.vbs'
$pageUrl = 'http://127.0.0.1:50143/api/monitor/page'
$dataUrl = 'http://127.0.0.1:50143/api/monitor/data'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ZgmScreen {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, ref RECT r, int c);
}
"@

function Test-ZgmService {
  try {
    $r = Invoke-WebRequest -Uri $dataUrl -TimeoutSec 4 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-ZgmServiceHidden {
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
}

# Physical pixels: SPI_GETWORKAREA (0x0030) needs a DPI-aware process
[ZgmScreen]::SetProcessDPIAware() | Out-Null
$sw = [ZgmScreen]::GetSystemMetrics(0)
$sh = [ZgmScreen]::GetSystemMetrics(1)
$work = New-Object ZgmScreen+RECT
if (-not [ZgmScreen]::SystemParametersInfo(0x0030, 0, [ref]$work, 0)) {
  $work.L = 0; $work.T = 0; $work.R = $sw; $work.B = $sh
}
$workW = $work.R - $work.L
$workH = $work.B - $work.T

$defW = [int]([Math]::Min(900, [Math]::Max(600, $workW * 0.34)))
$defH = [int]([Math]::Max(700, $workH - 120))
$defX = [int]($work.R - $defW - 40)
$defY = [int]($work.T + 60)

$geo = $null
if (Test-Path $posPath) { try { $geo = Get-Content $posPath -Raw | ConvertFrom-Json } catch { $geo = $null } }
$sane = $false
if ($geo -and $geo.w -ge 420 -and $geo.h -ge 600) {
  if ($geo.left -ge $work.L -and $geo.left -lt $work.R -and $geo.topY -ge $work.T -and $geo.topY -lt $work.B) { $sane = $true }
}
if ($sane) {
  $x = [int]$geo.left; $y = [int]$geo.topY; $w = [int]$geo.w; $h = [int]$geo.h; $src = 'last-position'
} else {
  $x = $defX; $y = $defY; $w = $defW; $h = $defH; $src = 'default-right'
}

# the shell reads this file; units are physical pixels
$cfg = @{ top = $true; opacity = 0.96; left = $x; topY = $y; w = $w; h = $h }
[System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))

if ($Daemon) {
  if (-not (Test-ZgmService)) { Start-ZgmServiceHidden; Start-Sleep -Seconds 6 }
  Write-Output ('daemon mode: ' + $pageUrl)
  exit 0
}

if (-not (Test-ZgmService)) {
  Start-ZgmServiceHidden
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 800
    if (Test-ZgmService) { break }
  }
}

# Ask the service to open the window (it hands geometry/icon/caption to the helper).
# Retry a few times: right after boot the HTTP endpoint may not be ready yet, and falling back
# too eagerly used to start a SECOND window (measured: two float processes, both visible).
$opened = $false
for ($i = 0; $i -lt 3 -and -not $opened; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:50143/api/monitor/float' -Method POST -TimeoutSec 30 -UseBasicParsing
    $opened = ($r.StatusCode -eq 200)
  } catch { $opened = $false }
  if (-not $opened) { Start-Sleep -Seconds 2 }
}

# Fallback ONLY when the service is unreachable and no monitor window exists at all
if (-not $opened) {
  $existing = @(Get-CimInstance Win32_Process -Filter "Name='EacMonitorFloat.exe'" |
    Where-Object { $_.ExecutablePath -eq (Join-Path $base 'float\EacMonitorFloat.exe') }).Count
  if ($existing -eq 0 -and -not (Test-ZgmService)) {
    Start-Process -FilePath (Join-Path $base 'float\EacMonitorFloat.exe') `
      -ArgumentList '--url', $pageUrl, '--top', '1', '--opacity', '0.96'
  }
}

Write-Output ('monitor window: ' + $src + '  x=' + $x + ' y=' + $y + ' w=' + $w + ' h=' + $h)
