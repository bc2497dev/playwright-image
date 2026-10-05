#!/bin/bash
echo ""
echo "============================================="
echo "  SIESAM - Instalacion (solo la primera vez)"
echo "============================================="
echo ""
echo "[1/2] Instalando dependencias..."
npm install
echo ""
echo "[2/2] Instalando navegador Chromium..."
npx playwright install chromium
echo ""
echo "============================================="
echo "  Listo. Ahora ejecuta: bash iniciar.sh"
echo "============================================="
echo ""