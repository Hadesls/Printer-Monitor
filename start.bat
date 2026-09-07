@echo off
cd /d "%~dp0"
REM 优先用同目录内置 node.exe；否则回退到系统已安装的 node
if exist "node.exe" (
  start "" "node.exe" server.js
) else (
  node server.js
)
exit
