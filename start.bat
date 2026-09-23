@echo off
title Avatar AI Lifetime
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang. Unduh versi LTS dari https://nodejs.org , install, lalu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)

echo Node.js versi:
node -v

if not exist node_modules (
  echo.
  echo Memasang dependency ^(sekali saja^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install gagal. Cek koneksi internet, lalu coba lagi.
    pause
    exit /b 1
  )
)

if not exist .env (
  copy .env.example .env >nul
  echo File .env dibuat dari .env.example. Isi API key di .env bila perlu ^(mode demo tetap jalan^).
)

echo.
echo Menjalankan server... biarkan jendela ini terbuka, lalu buka alamat yang tercetak di bawah.
echo.
call npm start

echo.
echo Server berhenti. Kalau ada pesan error di atas, kirimkan screenshot-nya.
pause
