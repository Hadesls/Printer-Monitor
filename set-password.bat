@echo off
title Printer-Monitor 管理员密码设置
cd /d "%~dp0"
echo ============================================
echo   Printer-Monitor 管理员密码设置
echo ============================================
echo.
set "NODE=node.exe"
if not exist "%NODE%" set "NODE=node"
if not "%~1"=="" ( "%NODE%" "%~dp0set-password.js" %* & goto :done )
echo  请选择一种方式来开启登录:
echo.
echo     [1] 自动生成一个随机强密码   (推荐, 与 Linux 服务器一致)
echo     [2] 自己设置一个固定密码    (至少 12 位, 需含大写+小写+数字)
echo     [0] 取消, 不做任何修改
echo.
set "C="
set /p C="  请输入 1 / 2 / 0 后回车: "
if "%C%"=="1" goto :rot
if "%C%"=="2" goto :cust
goto :done
:rot
echo.
"%NODE%" "%~dp0set-password.js" --rotate
goto :done
:cust
set "PWD="
set /p PWD="  请输入新密码(至少 12 位, 含大写+小写+数字): "
if "%PWD%"=="" ( echo     密码不能为空。 & goto :done )
"%NODE%" "%~dp0set-password.js" admin "%PWD%"
goto :done
:done
echo.
echo  提示: 设置完成后请关闭黑色服务窗口, 再重新双击 start.bat, 登录立即生效。
echo        登录后: 点页面左上角 logo 图标, 输入用户名和密码, 进入管理。
echo.
pause
