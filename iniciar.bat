@echo off
title BOSSKIN — Servidor local
cd /d "%~dp0"

echo.
echo  Iniciando BOSSKIN en http://localhost:3004
echo  Panel admin: http://localhost:3004/admin.html
echo.

if not exist node_modules (
  echo  Instalando dependencias...
  npm install
  echo.
)

start "" http://localhost:3004
node server.js
pause
