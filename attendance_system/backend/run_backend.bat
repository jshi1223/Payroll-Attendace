@echo off
cd /d "%~dp0"

echo Starting FastAPI backend...
uvicorn main:app --reload --host 0.0.0.0 --port 8000

pause
