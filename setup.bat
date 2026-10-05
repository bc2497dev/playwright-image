@echo off
echo.
echo =============================================
echo   SIESAM - Instalacion (solo la primera vez)
echo =============================================
echo.
echo [1/2] Instalando dependencias...
call npm install
echo.
echo [2/2] Instalando navegador Chromium...
call npx playwright install chromium
echo.
echo =============================================
echo   Listo. Ahora ejecuta "iniciar.bat"
echo =============================================
echo.
pause