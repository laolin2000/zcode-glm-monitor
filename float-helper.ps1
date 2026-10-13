# float-helper.ps1 - look & placement helper for the float window.
#   1) window icon -> ZCode icon (WM_SETICON; the window keeps a handle, so this process must live on)
#   2) caption colors -> ZCode theme (DWMWA_CAPTION_COLOR / TEXT_COLOR)
#   3) on first sight, move/resize the window to the requested rect (the shell's own default
#      landed at a tiny top-left corner, so we always place it explicitly)
#   4) every 3s write the real geometry to float-position.json -> user's drag/resize is remembered
#   5) exits after ~30s with no float window, so nothing stays running in the background
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI (non-ASCII comments
# once broke parsing by swallowing a newline).
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$IcoPath,
  [string]$PosFile = '',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$W = 0,
  [int]$H = 0,
  [int]$Top = 0        # 1 = make the window topmost once, at first sight
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ZgmShell {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint load);
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@

# Must be DPI aware: otherwise SetWindowPos/GetWindowRect are scaled by the display scale factor
# (measured: an 870x1480 request became 1306x1626 and pushed the window off the right edge).
# Note: this call must come AFTER the Add-Type above - earlier it silently failed.
[ZgmShell]::SetProcessDPIAware() | Out-Null

$WM_SETICON  = 0x0080
$ICON_SMALL  = [IntPtr]0
$ICON_BIG    = [IntPtr]1
$IMAGE_ICON  = 2
$LR_LOADFROMFILE = 0x0010

$hSmall = [ZgmShell]::LoadImage([IntPtr]::Zero, $IcoPath, $IMAGE_ICON, 16, 16, $LR_LOADFROMFILE)
$hBig   = [ZgmShell]::LoadImage([IntPtr]::Zero, $IcoPath, $IMAGE_ICON, 32, 32, $LR_LOADFROMFILE)
if ($hBig -eq [IntPtr]::Zero) { $hBig = $hSmall }
if ($hSmall -eq [IntPtr]::Zero) { $hSmall = $hBig }

$applied = @{}
$enforceUntil = @{}   # window stamp -> enforcement deadline (ticks)
$gone = 0
$exeLower = $ExePath.ToLower()
$exeDir = Split-Path -Parent $ExePath

while ($true) {
  # Tolerant match: a plain -eq on ExecutablePath was flaky (the property can come back empty),
  # which made the helper think the window was gone and exit after ~30s. CommandLine is the fallback.
  $procs = Get-CimInstance Win32_Process -Filter "Name='EacMonitorFloat.exe'" |
    Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $exeLower) -or ($_.CommandLine -and $_.CommandLine -like "*$exeDir*") }
  if (-not $procs) {
    $gone++
    if ($gone -ge 40) { break }   # ~2 minutes with no window at all -> exit
    Start-Sleep -Seconds 3
    continue
  }
  $gone = 0

  foreach ($p in $procs) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq 0) { continue }
    $h = $proc.MainWindowHandle
    $stamp = "$($p.ProcessId):$h"

    $enforcing = $false
    if ($enforceUntil.ContainsKey($stamp)) {
      if ((Get-Date).Ticks -lt $enforceUntil[$stamp]) { $enforcing = $true }
    }
    if (-not $applied.ContainsKey($stamp)) {
      $enforceUntil[$stamp] = (Get-Date).AddSeconds(20).Ticks   # enforce for the first ~20s
      # The service is started hidden, and Windows passes that hidden state down to the float
      # window: it is born minimized/invisible, which is why it used to show up as a tiny
      # window in the corner. Restore it first, then place it.
      if ([ZgmShell]::IsIconic($h)) { [ZgmShell]::ShowWindow($h, 9) | Out-Null }   # SW_RESTORE
      if (-not [ZgmShell]::IsWindowVisible($h)) { [ZgmShell]::ShowWindow($h, 5) | Out-Null }  # SW_SHOW
      Start-Sleep -Milliseconds 250
      if ($X -ge 0 -and $Y -ge 0 -and $W -gt 0 -and $H -gt 0) {
        # HWND_TOPMOST(-1) when requested, else SWP_NOZORDER(0x4); SWP_NOACTIVATE(0x10) keeps focus
        $after = if ($Top -eq 1) { [IntPtr](-1) } else { [IntPtr]::Zero }
        $flags = if ($Top -eq 1) { 0x0010 } else { 0x0004 -bor 0x0010 }
        [ZgmShell]::SetWindowPos($h, $after, $X, $Y, $W, $H, $flags) | Out-Null
      }
      [ZgmShell]::SendMessage($h, $WM_SETICON, $ICON_SMALL, $hSmall) | Out-Null
      [ZgmShell]::SendMessage($h, $WM_SETICON, $ICON_BIG, $hBig) | Out-Null
      $caption = [int]0x002B2B2B   # DWM 颜色按 0x00BBGGRR 传
      $text    = [int]0x00F8F8F8
      [ZgmShell]::DwmSetWindowAttribute($h, 35, [ref]$caption, 4) | Out-Null
      [ZgmShell]::DwmSetWindowAttribute($h, 36, [ref]$text, 4) | Out-Null
      # Force a frame recalc so the caption repaints with the new icon. NOTE: this call must use
      # the same z-order target, otherwise HWND_TOP(0) silently demotes the window from topmost
      # (measured: topmost was set and then immediately lost).
      $after2 = if ($Top -eq 1) { [IntPtr](-1) } else { [IntPtr]::Zero }
      [ZgmShell]::SetWindowPos($h, $after2, 0, 0, 0, 0, 0x0020 -bor 0x0001 -bor 0x0002) | Out-Null
      $applied[$stamp] = $true
    } elseif ($enforcing) {
      # keep it visible & in place for a short while: the shell may be born minimized and can
      # re-apply that state right after we restore it
      if ([ZgmShell]::IsIconic($h)) { [ZgmShell]::ShowWindow($h, 9) | Out-Null }
      if ($Top -eq 1) { [ZgmShell]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null }
      if ($X -ge 0 -and $Y -ge 0 -and $W -gt 0 -and $H -gt 0) {
        $r2 = New-Object ZgmShell+RECT
        if ([ZgmShell]::GetWindowRect($h, [ref]$r2)) {
          if (($r2.R - $r2.L) -ne $W -or ($r2.B - $r2.T) -ne $H -or $r2.L -ne $X -or $r2.T -ne $Y) {
            [ZgmShell]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0004 -bor 0x0010) | Out-Null
          }
        }
      }
    }

    # 记住用户当前几何(最小化时不记,否则会把 -32000 写进去)
    if ($PosFile -ne '' -and -not [ZgmShell]::IsIconic($h)) {
      $r = New-Object ZgmShell+RECT
      if ([ZgmShell]::GetWindowRect($h, [ref]$r)) {
        $w = $r.R - $r.L; $ht = $r.B - $r.T
        if ($w -gt 200 -and $ht -gt 200) {
          $json = '{"left":' + $r.L + ',"topY":' + $r.T + ',"w":' + $w + ',"h":' + $ht + '}'
          [System.IO.File]::WriteAllText($PosFile, $json, (New-Object System.Text.UTF8Encoding($false)))
        }
      }
    }
  }
  Start-Sleep -Seconds 3
}
