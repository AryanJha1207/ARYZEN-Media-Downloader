@echo off
rem Launched by the browser via the native messaging manifest (Windows).
rem Prefer a bundled runtime if present, otherwise the system Python.
rem Exactly one interpreter runs the host: never restart it after a runtime
rem error (a crashed host must stay crashed so the extension sees it).
set SELF=%~dp0
if exist "%SELF%..\runtime\python\python.exe" goto bundled
where py >nul 2>nul
if %errorlevel%==0 goto launcher
python "%SELF%umd_host.py" %*
exit /b %errorlevel%
:bundled
"%SELF%..\runtime\python\python.exe" "%SELF%umd_host.py" %*
exit /b %errorlevel%
:launcher
py -3 "%SELF%umd_host.py" %*
exit /b %errorlevel%
