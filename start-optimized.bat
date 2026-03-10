@echo off
echo Starting TogetherVideo server with OPTIMIZED Cloudflare tunnel...
echo This version fixes HTTP/2 stream cancellation issues for video streaming!
echo.

echo [1/2] Starting Node.js server...
start "TogetherVideo Server" cmd /k "npm start"

echo Waiting 3 seconds...
timeout /t 3 /nobreak > nul

echo [2/2] Starting Cloudflare tunnel with server-side optimizations...
start "Cloudflare Tunnel (Optimized)" cmd /k "npm run tunnel-named"

echo.
echo Both services are starting in separate windows.
echo Server: http://localhost:8000
echo Public: https://video.toolstack.nl
echo.
echo =================================================
echo CHANGES MADE TO FIX VIDEO STREAMING ISSUES:
echo - HTTP/2 disabled for video routes (prevents stream cancellation)
echo - Enhanced FFmpeg configuration for Cloudflare tunnels  
echo - Better error handling for connection drops
echo - Optimized video fragment sizes for streaming
echo =================================================
echo.
echo You can close this window now.
pause 