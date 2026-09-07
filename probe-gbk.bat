@echo off
title 打印机监控 - 管理员密码
cd /d "%~dp0"
echo ============================================
echo   打印机监控平台 — 设置 / 启用管理员登录
echo ============================================
echo.
set "NODE=node.exe"
if not exist "%NODE%" set "NODE=node"
if not "%~1"=="" ( chcp 65001 >nul & "%NODE%" "%~dp0set-password.js" %* & chcp 936 >nul & goto :done )
echo   请选择一项操作来启用登录：
echo.
echo     [1] 自动生成一个随机强密码   （推荐，与 Linux 一致）
echo     [2] 自己设置一个密码         （12位以上，含大小写字母和数字）
echo     [0] 取消
echo.
set "C="
set /p C="  输入 1 / 2 / 0 然后回车: "
if "%C%"=="1" goto :rot
if "%C%"=="2" goto :cust
goto :done
:rot
echo.
chcp 65001 >nul
"%NODE%" "%~dp0set-password.js" --rotate
chcp 936 >nul
goto :done
:cust
set "NEWPW="
set /p NEWPW="  输入新密码 / 要求12位以上、含大小写字母和数字: "
if "%NEWPW%"=="" ( echo     密码不能为空。 & goto :done )
chcp 65001 >nul
"%NODE%" "%~dp0set-password.js" admin "%NEWPW%"
chcp 936 >nul
goto :done
:done
echo.
echo   下一步：关闭黑色服务窗口，再双击 start.bat 重新打开即可生效。
echo           之后登录：点击面板左上角的打印机 logo 图标。
echo.
pause
