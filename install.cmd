@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "NODE_EXE="
for /f "delims=" %%p in ('node -p "process.execPath" 2^>nul') do set "NODE_EXE=%%p"
if not defined NODE_EXE goto :no_node
if not exist "%NODE_EXE%" goto :no_node
"%NODE_EXE%" "%ROOT%scripts\install-package.cjs" %*
set "EXIT_CODE=%errorlevel%"
goto :finish

:no_node
if /I "%~1"=="--help" goto :node_help
if /I "%~1"=="-h" goto :node_help
if /I "%~1"=="--no" goto :skip_node
if /I "%~1"=="--skip" goto :skip_node
if /I "%~1"=="--non-interactive" goto :skip_node
rem A CLI invocation must not turn a dry-run or custom-root request into an
rem interactive Node install that later loses the caller's arguments.
if not "%~1"=="" goto :node_required
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
goto :finish

:node_help
echo Usage: install.cmd [--yes] [--install exact-id] [--no] [--dry-run] [--client-root path] [--continuity]
echo Node.js 24.16+ is required. With no arguments, the installer can offer Node setup.
set "EXIT_CODE=0"
goto :finish

:skip_node
echo Skipped; no files changed.
set "EXIT_CODE=0"
goto :finish

:node_required
echo Node.js 24.16+ is required; no files changed. Install Node.js and retry with the same arguments.
set "EXIT_CODE=3"

:finish
if "%~1"=="" pause
exit /b %EXIT_CODE%
