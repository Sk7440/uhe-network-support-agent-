@echo off
title UHE Network Support Agent
cd /d "%~dp0"

if not exist backend\.venv (
  echo [setup] Creating Python environment...
  python -m venv backend\.venv || goto :error
  backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt || goto :error
)
if not exist backend\.env (
  echo [setup] backend\.env missing - copying from .env.example. Set ADMIN_TOKEN in it!
  copy backend\.env.example backend\.env >nul
)
if not exist frontend\node_modules (
  echo [setup] Installing frontend packages...
  pushd frontend && call npm install && popd
)
if not exist frontend\.next (
  echo [setup] Building frontend...
  pushd frontend && call npm run build && popd
)

echo Starting backend  on http://127.0.0.1:8001 ...
start "UHE Agent - Backend" cmd /k "cd /d %~dp0backend && .venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8001"
echo Starting frontend on http://localhost:3000 ...
start "UHE Agent - Frontend" cmd /k "cd /d %~dp0frontend && npm run start -- -p 3000"
timeout /t 6 >nul
start "" http://localhost:3000
echo.
echo Assistant : http://localhost:3000
echo IT Admin  : http://localhost:3000/admin   (token = ADMIN_TOKEN in backend\.env)
exit /b 0

:error
echo Setup failed. See messages above.
pause
