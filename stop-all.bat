@echo off
echo Stopping TogetherVideo services...
echo.

echo [1/2] Stopping Node.js server...
taskkill /f /im node.exe > nul 2>&1
if %errorlevel%==0 (
    echo ✅ Node.js server stopped
) else (
    echo ⚠️ No Node.js processes found
)

echo [2/2] Stopping Cloudflare tunnel...
taskkill /f /im cloudflared.exe > nul 2>&1
if %errorlevel%==0 (
    echo ✅ Cloudflare tunnel stopped
) else (
    echo ⚠️ No Cloudflare processes found
)

echo.
echo ✅ All services stopped
echo.
pause 