@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PIP_NO_COLOR=1"
set "NO_COLOR=1"
set "PIP_PROGRESS_BAR=off"

echo ========================================
echo Signature System - Install Environment
echo ========================================
echo.

set "PYTHON_CMD="
python -c "import sys,struct; sys.exit(0 if sys.version_info[:2]==(3,10) and struct.calcsize('P')*8==64 else 1)" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=python"
if defined PYTHON_CMD goto python_found
py -3.10 -c "import sys,struct; sys.exit(0 if struct.calcsize('P')*8==64 else 1)" >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=py -3.10"
if defined PYTHON_CMD goto python_found

echo 64-bit Python 3.10 was not found.
echo Install 64-bit Python 3.10 and enable Add Python to PATH.
pause
exit /b 1

:python_found
echo Python detected:
%PYTHON_CMD% --version
echo.
if not exist "requirements.txt" (
  echo requirements.txt was not found. Keep the project folder complete.
  pause
  exit /b 1
)

if exist ".venv\Scripts\python.exe" goto venv_ready
echo Creating virtual environment .venv ...
%PYTHON_CMD% -m venv .venv
if errorlevel 1 goto venv_failed

:venv_ready
if exist "wheels\*.whl" (
  echo Installing dependencies from local wheels directory...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-color --progress-bar off --no-index --find-links "wheels" -r requirements.txt
) else (
  echo Local wheels directory was not found.
  echo Internet access is required for this first installation.
  echo Upgrading pip tooling ...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-color --progress-bar off -i https://pypi.tuna.tsinghua.edu.cn/simple --upgrade pip setuptools wheel
  if errorlevel 1 goto install_failed
  echo Installing dependencies from the package mirror...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-color --progress-bar off -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
)
if errorlevel 1 goto install_failed

echo Verifying dependencies ...
".venv\Scripts\python.exe" -c "import flask, fitz, cv2, PIL, watchdog, paddleocr, paddle, qrcode"
if errorlevel 1 goto verify_failed

echo.
echo Environment installation completed.
echo Run start.bat to start Receipt Assistant.
pause
exit /b 0

:venv_failed
echo Failed to create .venv.
pause
exit /b 1

:install_failed
echo Failed to install dependencies. Check network, firewall, proxy, or wheels folder.
pause
exit /b 1

:verify_failed
echo Dependency verification failed. Re-run this installer after fixing the error above.
pause
exit /b 1
