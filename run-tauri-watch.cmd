@echo off
setlocal
cd /d C:\Users\Master\Desktop\tauri-account-manager
:restart
>>tauri-run.log echo.
>>tauri-run.log echo [%date% %time%] Starting Tauri dev watcher
call npm.cmd run tauri dev >>tauri-run.log 2>&1
>>tauri-run.log echo [%date% %time%] Tauri stopped with exit code %errorlevel%; restarting in 2 seconds
timeout /t 2 /nobreak >nul
goto restart
