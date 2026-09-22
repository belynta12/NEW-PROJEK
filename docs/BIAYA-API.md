# Pilihan API & perkiraan biaya

Angka di bawah adalah **perkiraan per September 2026** untuk membandingkan
pilihan. Harga penyedia bisa berubah - selalu cek halaman harga resminya.

## Ringkasan: pilih paket sesuai dompet

### Paket A - Rp 0 / bulan (uji coba & pemakaian pribadi)

| Bagian | Pilihan | Biaya |
| --- | --- | --- |
| Otak (LLM) | Groq free tier / Gemini Flash free tier | 0 |
| Dengar (STT) | Web Speech API bawaan Chrome | 0 |
| Suara (TTS) | SpeechSynthesis bawaan browser | 0 |
| Avatar | mode `puppet` (foto dianimasikan di browser) | 0 |

Kekurangan: suara balasan **bukan** suara Anda dan terdengar robotik.

### Paket B - sekitar $5-7 / bulan (REKOMENDASI)

| Bagian | Pilihan | Perkiraan biaya |
| --- | --- | --- |
| Otak | Groq `llama-3.3-70b` | ~$0.6 per 1 juta token masuk, ~$0.8 keluar. Untuk ribuan percakapan pendek masih di bawah $1 |
| Dengar | Groq `whisper-large-v3-turbo` | ~$0.04 per jam audio |
| Suara | ElevenLabs Starter | $5 / bulan, ~30 menit suara + Instant Voice Cloning |
| Avatar | mode `puppet` | 0 |

Inilah paket "suara saya, wajah saya, murah". Model `eleven_flash_v2_5` memakai
kredit paling hemat dan latensinya rendah.

### Paket C - kualitas maksimal ($30+ / bulan)

| Bagian | Pilihan | Perkiraan biaya |
| --- | --- | --- |
| Otak | GPT-4o-mini atau Gemini Flash | ~$0.15-0.6 per 1 juta token |
| Dengar | Deepgram Nova-2 | ~$0.0043 / menit ($200 kredit awal gratis) |
| Suara | ElevenLabs Creator | $22 / bulan (~100 menit) |
| Avatar | HeyGen Interactive Avatar | paket API mulai ~$29-99 / bulan, streaming ~$0.10-0.15 / menit |

Alternatif avatar lebih murah dari HeyGen: **D-ID** (~$6-30/bulan, render per
video) dan **Simli** (streaming lipsync, ada tier gratis untuk developer).

---

## Rincian per bagian

### 1. LLM (menjawab pertanyaan)

| Penyedia | Model default di proyek ini | Catatan |
| --- | --- | --- |
| Groq | `llama-3.3-70b-versatile` | Tercepat, ada free tier. Pilihan utama |
| Google Gemini | `gemini-2.0-flash` | Free tier harian cukup besar |
| OpenRouter | `llama-3.3-70b-instruct` | Satu key untuk banyak model, ada model gratis |
| DeepSeek | `deepseek-chat` | Sangat murah |
| OpenAI | `gpt-4o-mini` | Paling stabil, Bahasa Indonesia bagus |
| Ollama | `qwen2.5:7b` | Jalan di PC sendiri, gratis, butuh RAM 8 GB+ |

Hemat token: `PERSONA_MAX_SENTENCES=3` dan `LLM_MAX_TOKENS=400` sudah membatasi
panjang jawaban. Jawaban pendek juga lebih murah di sisi TTS.

### 2. STT (suara pengunjung jadi teks)

| Pilihan | Biaya | Catatan |
| --- | --- | --- |
| Web Speech API (browser) | 0 | Gratis, hanya Chrome/Edge, akurasi sedang |
| Groq Whisper Turbo | ~$0.04 / jam | Termurah untuk kualitas bagus, dukung Bahasa Indonesia |
| OpenAI `gpt-4o-mini-transcribe` | ~$0.003 / menit | Akurat |
| Deepgram Nova-2 | ~$0.0043 / menit | Latensi rendah, $200 kredit gratis |

### 3. TTS (suara Anda)

| Pilihan | Biaya | Kloning suara |
| --- | --- | --- |
| Browser | 0 | Tidak bisa |
| ElevenLabs Starter | $5 / bulan | Instant Voice Clone (butuh 1-3 menit sample) |
| ElevenLabs Creator | $22 / bulan | Termasuk Professional Voice Clone |
| Fish Audio | bayar per pakai, sekitar $15 / 1 juta karakter | Bisa kloning, murah, Bahasa Indonesia lumayan |
| OpenAI TTS | ~$15 / 1 juta karakter | Tidak bisa kloning suara Anda |

Penghematan yang sudah aktif di proyek ini:
- `TTS_CACHE=1` menyimpan audio jawaban di folder `cache/`, jawaban berulang gratis.
- Jawaban dipotong per kalimat, jadi kalimat pertama sudah diucapkan sambil sisanya dibuat.

### 4. Avatar (foto bergerak)

| Pilihan | Biaya | Kualitas gerak |
| --- | --- | --- |
| `puppet` (bawaan proyek) | 0 | Mulut, kepala, badan, kedip. Cukup meyakinkan untuk foto setengah badan |
| D-ID Talks | mulai ~$6 / bulan, per video | Lipsync rapi, ada jeda render beberapa detik |
| HeyGen Interactive Avatar | ~$29+ / bulan | Paling mirip manusia, streaming real-time |
| Simli | ada tier gratis developer | Streaming lipsync, lebih murah dari HeyGen |

---

## Perkiraan biaya nyata

Asumsi: 200 percakapan / bulan, 6 tanya-jawab per percakapan, jawaban ~30 kata
(sekitar 180 karakter).

| Komponen | Volume | Paket B |
| --- | --- | --- |
| LLM | ~1.400 permintaan pendek | < $1 |
| STT | ~3 jam audio | ~$0.12 |
| TTS | ~216.000 karakter | butuh paket Creator $22, atau tetap $5 bila jawaban lebih pendek / banyak yang kena cache |
| Avatar | mode puppet | $0 |

Kesimpulan: biaya terbesar selalu **TTS**. Menekan panjang jawaban dan memakai
cache adalah cara paling efektif menghemat.
