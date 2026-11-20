@echo off
title Printer-Monitor - Admin Password
cd /d "%~dp0"
echo ============================================
echo   Printer-Monitor - Set / Enable Admin Login
echo ============================================
echo.
set "NODE=node.exe"
if not exist "%NODE%" set "NODE=node"
if not "%~1"=="" ( chcp 65001 >nul & "%NODE%" "%~dp0set-password.js" %* & chcp 936 >nul & goto :done )
echo   Choose one to enable login:
echo.
echo     [1] Auto-generate a strong random password  (recommended, same as Linux)
echo     [2] Set your own password                   (12+ chars, upper+lower+digit)
echo     [0] Cancel
echo.
set "C="
set /p C="  type 1 / 2 / 0 and press Enter: "
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
set /p NEWPW="  type new password (12+ chars, upper+lower+digit): "
if "%NEWPW%"=="" goto :empty
chcp 65001 >nul
"%NODE%" "%~dp0set-password.js" admin "%NEWPW%"
chcp 936 >nul
goto :done
:empty
echo     Empty password, cancelled.
goto :done
:done
echo.
echo   NEXT: close the black window, then double-click start.bat again to apply.
echo         To log in: click the printer logo at top-left of the panel.
echo.
pause
