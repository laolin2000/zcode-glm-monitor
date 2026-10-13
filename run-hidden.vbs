' run-hidden.vbs — 无窗口启动 ZCode 智谱用量监控
' 用法:wscript.exe run-hidden.vbs   (由 启动监控.cmd 调用)
Option Explicit
Dim fso, sh, dir, logPath, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = dir & "\_supervisor.log"
sh.CurrentDirectory = dir
cmd = "cmd /c node """ & dir & "\monitor.mjs"" >> """ & logPath & """ 2>&1"
' 0 = 隐藏窗口,False = 不等待(服务常驻)
sh.Run cmd, 0, False
