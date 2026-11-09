@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\startup.log"
set "APP_URL=http://127.0.0.1:8888"
set "HEALTH_URL=http://127.0.0.1:8888/api/status"

if /i "%~1"=="__RUN_SERVER" goto RUN_SERVER

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
call :LOG "========================================"
call :LOG "Signature System - Start"

echo ========================================
echo Signature System - Start
echo ========================================
echo.

if /i not "%~d0"=="C:" (
  echo WARNING: The program is running from %~dp0
  echo This may be a removable drive, network drive, or synchronized drive.
  echo For reliable startup, copy the delivery package to:
  echo C:\AI\ReceiptAssistant
  echo and run start.bat there.
  echo.
  call :LOG "WARNING: Non-C drive path detected: %~dp0"
  call :LOG "Recommended path: C:\AI\ReceiptAssistant"
)

netstat -ano | findstr "LISTENING" | findstr ":8888" >nul
if not errorlevel 1 (
  call :IS_RECEIPT_ASSISTANT
  if not errorlevel 1 goto ALREADY_RUNNING
  goto PORT_OCCUPIED_BY_OTHER
)

if not exist ".venv\Scripts\python.exe" (
  echo .venv was not found. Run install_env.bat or the install environment BAT first.
  call :LOG "ERROR: .venv\Scripts\python.exe was not found."
  call :FAIL_HELP
  pause
  exit /b 1
)
call :LOG ".venv check passed."

".venv\Scripts\python.exe" -c "import flask, fitz, cv2, PIL, watchdog, paddleocr, paddle, qrcode" >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo Dependencies are missing in .venv. Run install_env.bat or the install environment BAT first.
  call :LOG "ERROR: Dependency check failed."
  call :FAIL_HELP
  pause
  exit /b 1
)
call :LOG "Dependency check passed."

echo Starting service at %APP_URL% ...
call :LOG "Port 8888 is available."

call :LOG "Launching main.py."
start "" /b "%ComSpec%" /d /c call "%~f0" __RUN_SERVER

echo Waiting for the service to start...
:WAIT_FOR_PORT
netstat -ano | findstr "LISTENING" | findstr ":8888" >nul
if not errorlevel 1 goto VERIFY_SERVICE
if not defined WAIT_COUNT set "WAIT_COUNT=0"
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GEQ 30 goto START_FAILED
ping 127.0.0.1 -n 2 >nul
goto WAIT_FOR_PORT

:VERIFY_SERVICE
call :IS_RECEIPT_ASSISTANT
if not errorlevel 1 goto SERVICE_READY
if not defined HEALTH_WAIT_COUNT set "HEALTH_WAIT_COUNT=0"
set /a HEALTH_WAIT_COUNT+=1
if %HEALTH_WAIT_COUNT% GEQ 10 goto PORT_OCCUPIED_BY_OTHER
ping 127.0.0.1 -n 2 >nul
goto VERIFY_SERVICE

:SERVICE_READY
>>"%LOG_FILE%" echo [%date% %time%] Service startup confirmed on port 8888.
echo Service started successfully.
call :OPEN_BROWSER

:MONITOR
timeout /t 2 /nobreak >nul
netstat -ano | findstr "LISTENING" | findstr ":8888" >nul
if not errorlevel 1 goto MONITOR

echo.
echo ERROR: The service has stopped or port 8888 is no longer listening.
>>"%LOG_FILE%" echo [%date% %time%] ERROR: Service stopped; port 8888 is no longer listening.
call :FAIL_HELP
pause
exit /b 1

:ALREADY_RUNNING
echo.
echo 系统已在运行，正在打开浏览器
call :LOG "Receipt Assistant is already running. Opening browser."
call :OPEN_BROWSER
exit /b 0

:PORT_OCCUPIED_BY_OTHER
call :GET_PORT_PROCESS
echo.
echo ERROR: Port 8888 is being used by another program.
echo PID: %PORT_PID%
echo Process: %PROCESS_NAME%
echo Close that program, then run start.bat again.
call :LOG "ERROR: Port 8888 is occupied by another program. PID=%PORT_PID% Process=%PROCESS_NAME%"
call :FAIL_HELP
pause
exit /b 1

:START_FAILED
echo.
echo ERROR: The service did not open port 8888 within 30 seconds.
>>"%LOG_FILE%" echo [%date% %time%] ERROR: Port 8888 was not listening within 30 seconds.
call :FAIL_HELP
pause
exit /b 1

:RUN_SERVER
".venv\Scripts\python.exe" main.py
set "APP_EXIT=%ERRORLEVEL%"
>>"%LOG_FILE%" echo [%date% %time%] main.py exited with code %APP_EXIT%.
exit /b %APP_EXIT%

:IS_RECEIPT_ASSISTANT
curl.exe -s --connect-timeout 1 --max-time 2 "%HEALTH_URL%" 2>nul | findstr /c:"receipt_assistant" >nul
exit /b %ERRORLEVEL%

:GET_PORT_PROCESS
set "PORT_PID=Unknown"
set "PROCESS_NAME=Unknown"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8888"') do (
  if "!PORT_PID!"=="Unknown" set "PORT_PID=%%P"
)
if not "!PORT_PID!"=="Unknown" (
  for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq !PORT_PID!" /FO CSV /NH 2^>nul') do (
    set "PROCESS_NAME=%%~N"
  )
)
exit /b 0

:OPEN_BROWSER
start "" "%APP_URL%" >nul 2>&1
if errorlevel 1 (
  echo 请手动打开 %APP_URL%
  call :LOG "WARNING: Browser could not be opened automatically. Open %APP_URL% manually."
  exit /b 1
)
echo 请手动打开 %APP_URL%（如果浏览器没有自动打开）
call :LOG "Browser open requested: %APP_URL%"
exit /b 0

:FAIL_HELP
echo.
echo Please send the following diagnostic files and screenshot:
echo   logs\startup.log
echo   logs\server.log
echo   Screenshot of this startup window
echo.
exit /b 0

:LOG
>>"%LOG_FILE%" echo [%date% %time%] %~1
exit /b 0
