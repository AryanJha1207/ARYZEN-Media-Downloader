@echo off
rem Launched by the browser via the native messaging manifest (Windows).
rem Prefer a bundled runtime if present, otherwise the system Python.
set SELF=%~dp0
if exist "%SELF%..\runtime\python\python.exe" (
  "%SELF%..\runtime\python\python.exe" "%SELF%umd_host.py" %*
) else (
  py -3 "%SELF%umd_host.py" %* 2>nul || python "%SELF%umd_host.py" %*
)
