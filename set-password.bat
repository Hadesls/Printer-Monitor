@echo off
chcp 65001 >nul
title Printer-Monitor 管理员密码设置
cd /d "%~dp0"
echo ============================================
echo  Printer-Monitor 管理员密码设置
echo ============================================
echo.
REM 优先用同目录内置 node.exe；否则回退到系统已安装的 node
set "NODE=node.exe"
if not exist "%NODE%" set "NODE=node"
if "%1"=="--rotate" goto run
if not "%1"=="" goto run
echo 用法（在本目录命令行里执行）:
echo   set-password.bat --rotate             自动生成 18 位强密码并启用登录
echo   set-password.bat 你的新密码            指定密码（>=12 位，含大小写字母和数字）
echo   set-password.bat 用户名 你的新密码     指定用户名 + 密码
echo.
pause
exit /b 1
:run
"%NODE%" "%~dp0set-password.js" %*
echo.
pause
