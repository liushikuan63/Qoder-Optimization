@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "NODE_EXE="
for /f "delims=" %%p in ('node -p "process.execPath" 2^>nul') do set "NODE_EXE=%%p"
if not defined NODE_EXE goto :no_node
if not exist "%NODE_EXE%" goto :no_node
"%NODE_EXE%" "%ROOT%scripts\install-continuity.cjs" %*
set "EXIT_CODE=%errorlevel%"
goto :finish

:no_node
set "PS_EXE="
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PS_EXE (
  where pwsh >nul 2>nul && set "PS_EXE=pwsh"
)
if not defined PS_EXE set "PS_EXE=powershell"
set "PS_ARG="
if /I "%~1"=="--non-interactive" set "PS_ARG=-NonInteractive"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\install-node.ps1" %PS_ARG%
set "EXIT_CODE=%errorlevel%"

:finish
if "%~1"=="" pause
exit /b %EXIT_CODE%
