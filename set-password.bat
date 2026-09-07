@echo off
title Printer-Monitor Admin Password
cd /d "%~dp0"
echo ============================================
echo   Printer-Monitor - Set / Enable Admin Login
echo ============================================
echo.
set "NODE=node.exe"
if not exist "%NODE%" set "NODE=node"
if not "%~1"=="" ( "%NODE%" "%~dp0set-password.js" %* & goto :done )
echo  Choose an option to enable login:
echo.
echo     [1] Auto-generate a strong random password  (recommended, same as Linux)
echo     [2] Set your own password                   (12+ chars, upper+lower+digit)
echo     [0] Cancel
echo.
set "C="
set /p C="  Enter 1 / 2 / 0 and press Enter: "
if "%C%"=="1" goto :rot
if "%C%"=="2" goto :cust
goto :done
:rot
echo.
"%NODE%" "%~dp0set-password.js" --rotate
goto :done
:cust
set "PWD="
set /p PWD="  Enter new password (12+ chars, upper+lower+digit): "
if "%PWD%"=="" ( echo     Password cannot be empty. & goto :done )
"%NODE%" "%~dp0set-password.js" admin "%PWD%"
goto :done
:done
echo.
echo  NEXT: close the black service window, then double-click start.bat again to apply.
echo        To log in: click the printer logo at top-left of the panel.
echo.
pause
