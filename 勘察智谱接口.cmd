@echo off
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────
rem  智谱控制台接口勘察(只做数据源 A 的接口确认,不写业务逻辑)
rem
rem  前置:弹出的「监控专用 Edge」窗口里登录一次 open.bigmodel.cn
rem        (账号密码/微信扫码都行,登录态会保存在专用 profile 里,只需一次)
rem  产出:zhipu-probe.json   抓到接口清单(原始)
rem        zhipu-endpoints.json 自动推断的适配器(确认后可留着用)
rem ─────────────────────────────────────────────────────────────
setlocal
set DIR=%~dp0
cd /d "%DIR%"
echo 正在启动专用 Edge 并抓取财务页接口...
echo 如果弹出登录页,请先登录,然后关掉这个窗口重新双击本文件。
echo.
node monitor.mjs --probe
echo.
echo 完成后可查看:%DIR%zhipu-probe.json
pause
