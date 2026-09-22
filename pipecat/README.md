# Versi Pipecat AI (opsional)

## Kapan ini dipakai?

| Kebutuhan | Pakai yang mana |
| --- | --- |
| Web tanya-jawab dengan foto bergerak, hemat, mudah di-hosting | **versi Node di folder root** (`npm start`) |
| Percakapan seperti telepon: bisa dipotong di tengah ucapan, latensi < 1 detik | **versi Pipecat ini** |
| Ingin menyambung layanan avatar realtime (Simli / HeyGen) di dalam pipeline | **versi Pipecat ini** |

Keduanya memakai `.env` dan folder `knowledge/` yang sama, jadi persona dan
suara kloning Anda tetap konsisten.

## Menjalankan

```bash
cd pipecat
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp ../.env .env
python bot.py
```

Terminal akan mencetak URL klien WebRTC. Buka di Chrome, izinkan mikrofon,
langsung bicara.

## Yang perlu diisi di .env

```env
GROQ_API_KEY=...              # LLM + Whisper STT (termurah)
ELEVENLABS_API_KEY=...        # suara kloning Anda
ELEVENLABS_VOICE_ID=...       # hasil dari: npm run clone-voice
PERSONA_NAME=Nama Anda
# opsional
DEEPGRAM_API_KEY=...          # kalau ada, STT otomatis pakai Deepgram
```

## Menambahkan wajah bergerak

Dua pilihan:

1. **Gratis** - biarkan `bot.py` mengurus suara saja, lalu tampilkan halaman
   `public/index.html` (mode puppet) di sisi klien untuk menganimasikan foto
   mengikuti audio yang keluar.
2. **Realtime video** - buka komentar blok `VIDEO (opsional)` di `bot.py`,
   isi `SIMLI_API_KEY` + `SIMLI_FACE_ID` atau `HEYGEN_API_KEY` +
   `HEYGEN_AVATAR_ID`, dan set `video_out_enabled=True`. Pipecat akan
   mengirim video avatar sekaligus audionya.

## Catatan

- Pipecat berkembang cepat. Bila ada error `ImportError`, sesuaikan nama modul
  dengan versi yang ter-install (`pip show pipecat-ai`) atau naikkan pin versi
  di `requirements.txt`.
- Interupsi natural mengandalkan Silero VAD yang berjalan lokal, tanpa biaya.
- Untuk produksi berskala besar, ganti `SmallWebRTCTransport` dengan transport
  Daily agar dapat TURN server dan rekaman bawaan.
