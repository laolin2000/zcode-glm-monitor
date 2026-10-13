@echo off
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────
rem  ZCode 智谱用量监控 · 打开
rem  窗口即程序:打开监控窗口;窗口关掉后服务自己退出,不留后台进程。
rem  只要网页不要窗口(常驻):改成 open-monitor.ps1 -Daemon
rem ─────────────────────────────────────────────────────────────
setlocal
set DIR=%~dp0
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%open-monitor.ps1"
echo.
echo  正在打开监控窗口（屏幕右侧）…
echo    页面:  http://127.0.0.1:50143/api/monitor/page
echo    关闭窗口 = 结束监控；也可双击「停止监控.cmd」强制全停
echo.
timeout /t 4 >nul
