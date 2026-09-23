#!/usr/bin/env bash
# Jalankan Avatar AI Lifetime (macOS / Linux). Windows: klik dua kali start.bat
set -u
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
	echo "Node.js belum terpasang. Unduh versi LTS dari https://nodejs.org lalu jalankan lagi."
	exit 1
fi
echo "Node.js versi: $(node -v)"

if [ ! -d node_modules ]; then
	echo "Memasang dependency (sekali saja)..."
	npm install --no-audit --no-fund || { echo "npm install gagal. Cek koneksi internet."; exit 1; }
fi

if [ ! -f .env ]; then
	cp .env.example .env
	echo "File .env dibuat dari .env.example. Isi API key di .env bila perlu (mode demo tetap jalan)."
fi

echo "Menjalankan server... biarkan terminal ini terbuka."
npm start
