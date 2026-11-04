@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. The MCP installer needs Node 18+; the main installer requires Node 24.16+. https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0install-mcp.cjs" %*
if errorlevel 1 pause
