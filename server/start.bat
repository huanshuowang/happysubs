@echo off
REM Starts the recogniser. Double-click it, or run it by path from anywhere:
REM %~dp0 is this file's own folder, so no "cd" is needed first.
cd /d "%~dp0"
".venv\Scripts\python.exe" server.py
pause
