@echo off
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────
rem  ZCode 智谱用量监控 · 全部停止
rem  正常用法是直接关监控窗口(服务会自己退出);这个脚本用于强制清干净:
rem  服务 + 浮窗 + 外观助手,都不影响其它 node/浏览器进程。
rem ─────────────────────────────────────────────────────────────
setlocal
echo 正在停止监控…
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'monitor\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='EacMonitorFloat.exe'\" | Where-Object { $_.ExecutablePath -like '*zcode-glm-monitor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'float-help[e]r' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
echo 已停止。
timeout /t 3 >nul
