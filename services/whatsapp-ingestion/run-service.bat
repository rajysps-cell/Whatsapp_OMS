@echo off
REM Always-on launcher for the WhatsApp OMS service (run by the "WhatsApp OMS Service" scheduled task).
REM Keep-alive loop: clears the stale Chromium lock, starts the service, and restarts it if it ever exits.
setlocal
cd /d "C:\inetpub\wwwroot\Whatsapp_OMS\services\whatsapp-ingestion"
set "PATH=%PATH%;C:\Program Files\nodejs"
REM Chromium for Puppeteer lives in the Administrator profile; point there so it is found under any account.
set "PUPPETEER_CACHE_DIR=C:\Users\Administrator\.cache\puppeteer"
if not exist "logs" mkdir "logs"

:loop
if exist ".\auth\session\SingletonLock" del /f /q ".\auth\session\SingletonLock" >nul 2>&1
echo [%date% %time%] starting whatsapp-oms >> ".\logs\service.log"
call npm start >> ".\logs\service.log" 2>&1
echo [%date% %time%] service exited (code %errorlevel%), restarting in 5s >> ".\logs\service.log"
ping -n 6 127.0.0.1 >nul
goto loop
