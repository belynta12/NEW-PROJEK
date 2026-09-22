# Avatar AI Lifetime

Avatar AI dari **satu foto Anda** dan **suara Anda sendiri**. Pengunjung web cukup
bicara ke mikrofon, lalu:

```
suara pengunjung -> teks (STT) -> jawaban AI (LLM) -> suara Anda (TTS) -> foto bergerak (mulut, kepala, badan)
```

Semua berjalan dari satu server Node.js **tanpa dependency npm sama sekali**
(hanya modul bawaan Node), jadi ringan dan bisa jalan di PC/VPS kecil.

---

## 1. Jalankan dalam 3 menit

```bash
# butuh Node.js 20 atau lebih baru
node -v

cp .env.example .env
npm start
```

Buka **http://localhost:8787**

Tanpa mengisi API key apa pun, web sudah bisa dipakai dalam **mode demo**:
pengenalan suara dan suara balasan memakai fitur gratis bawaan Chrome/Edge,
foto sudah bergerak. Yang belum aktif hanya jawaban AI (butuh 1 API key gratis)
dan suara kloning Anda.

> Mikrofon hanya diizinkan browser di `localhost` atau domain **https**.
> Untuk uji dari HP, lihat `docs/DEPLOY.md`.

---

## 2. Menghidupkan otak AI (gratis)

1. Daftar di **console.groq.com** lalu buat API key (ada free tier, sangat cepat).
2. Isi di `.env`:

```env
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_xxxxxxxx
```

3. `npm start` lagi. Avatar sudah bisa menjawab apa pun.

Provider lain yang didukung tanpa ubah kode: `openai`, `openrouter`, `gemini`,
`deepseek`, dan `ollama` (model lokal, gratis).

---

## 3. Memakai SUARA ANDA (ElevenLabs)

1. Rekam **1-3 menit** suara Anda membaca teks apa saja. Syarat: satu orang,
   tanpa musik, tanpa gema, format mp3/m4a/wav.
2. Daftar ElevenLabs, ambil API key, isi di `.env`:

```env
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=xxxxxxxx
```

3. Kloning suara (pilih salah satu):

```bash
# lewat terminal
npm run clone-voice -- sample-suara.mp3 "Suara Saya"
```

atau buka web -> tombol **Pengaturan** -> **Unggah sample suara**.

4. Salin `voice_id` yang muncul ke `.env`, lalu restart:

```env
ELEVENLABS_VOICE_ID=abcd1234
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
```

Sekarang avatar menjawab dengan suara Anda. Hasil TTS disimpan di folder
`cache/` supaya kalimat yang sama tidak menghabiskan kredit dua kali.

Alternatif lebih murah: `TTS_PROVIDER=fishaudio` (juga bisa kloning suara).

---

## 4. Memakai FOTO ANDA

1. Buka web -> **Pengaturan** -> **Unggah foto**.
2. Ikuti kalibrasi: klik **mulut**, lalu **mata kiri**, lalu **mata kanan**.
3. Rapikan dengan slider *Lebar mulut*, *Tinggi mulut*, *Gerak badan*,
   *Kekuatan lipsync*. Pengaturan tersimpan otomatis di browser.

**Foto yang bagus:** setengah badan, wajah lurus ke kamera, mulut tertutup,
pencahayaan rata, latar rapi, resolusi minimal 800 px lebar.

Cara kerja animasi (`public/js/puppet.js`): foto digambar ulang tiap frame di
canvas. Bagian mulut diregangkan mengikuti amplitudo suara (rahang turun +
rongga mulut), kepala diputar/dianggukkan halus, badan diberi efek napas dan
goyangan, mata berkedip berkala. Tidak ada biaya API sama sekali.

---

## 5. Kalau ingin gerakan sekelas HeyGen

Mode puppet gratis sudah terlihat hidup, tapi gerak bibirnya perkiraan dari
volume suara. Untuk lipsync sinematik:

| Mode | Isi `.env` | Catatan |
| --- | --- | --- |
| `puppet` (default) | - | Gratis, real-time, jalan di semua browser |
| `heygen` | `AVATAR_MODE=heygen`, `HEYGEN_API_KEY`, `HEYGEN_AVATAR_ID` | Video streaming real-time. Buat dulu *Photo Avatar* dari foto Anda di dashboard HeyGen |
| `did` | `AVATAR_MODE=did`, `DID_API_KEY`, `DID_SOURCE_URL` | Render video per jawaban; foto harus punya URL publik |

Perbandingan harga lengkap: `docs/BIAYA-API.md`.

---

## 6. Mengisi "otak pribadi" avatar

Edit `knowledge/00-profil.md` (boleh tambah file `.md` lain: layanan, harga,
FAQ, riwayat). File-file itu dipotong kecil, dan potongan paling relevan
diselipkan ke prompt setiap pertanyaan, jadi avatar menjawab sebagai **Anda**.

Pertanyaan umum tetap dijawab dari pengetahuan model. Fakta pribadi hanya
diambil dari folder `knowledge/` supaya avatar tidak mengarang.

Muat ulang tanpa restart:

```bash
curl -X POST http://localhost:8787/api/knowledge/reload
```

---

## 7. Struktur proyek

```
avatar-ai-lifetime/
  server/
    index.js              server HTTP + semua endpoint (tanpa framework)
    config.js             preset semua provider, dibaca dari .env
    knowledge.js          pencarian potongan pengetahuan pribadi
    providers/
      llm.js              chat streaming (OpenAI-compatible)
      stt.js              Whisper (Groq/OpenAI) atau Deepgram
      tts.js              ElevenLabs / Fish Audio / OpenAI + kloning suara + cache
      avatarVideo.js      HeyGen streaming & D-ID talks (opsional)
  public/
    index.html            antarmuka web
    styles.css            tampilan (mendukung mode gelap)
    js/app.js             alur percakapan, streaming jawaban, antrean suara
    js/puppet.js          mesin animasi foto (mulut, kepala, badan, kedip)
    js/audio.js           mikrofon, deteksi diam, pemutar + pengukur amplitudo
    js/heygen.js          mode avatar streaming (opsional)
  knowledge/              data pribadi avatar (markdown)
  scripts/
    clone-voice.js        kloning suara dari terminal
    check-providers.js    cek kesiapan semua API key
  pipecat/                versi alternatif berbasis Pipecat AI (Python)
  docs/                   panduan biaya, deploy, rekaman suara
```

---

## 8. Endpoint API

| Method | Path | Fungsi |
| --- | --- | --- |
| GET | `/api/config` | status provider (tanpa membocorkan API key) |
| POST | `/api/chat?stream=1` | jawaban AI, dialirkan token demi token (SSE) |
| POST | `/api/stt` | audio mentah -> teks |
| POST | `/api/tts` | teks -> mp3 suara Anda |
| POST | `/api/voice/clone` | sample suara -> `voice_id` ElevenLabs |
| GET | `/api/voices` | daftar voice di akun ElevenLabs |
| POST | `/api/upload/photo` | simpan foto avatar |
| POST | `/api/avatar/heygen/token` | token sesi streaming HeyGen |
| POST/GET | `/api/avatar/did/talk` | buat / cek video D-ID |
| POST | `/api/knowledge/reload` | muat ulang folder knowledge |

Cek semua API key sekaligus:

```bash
npm run check
```

---

## 9. Pipecat AI (opsional)

Folder `pipecat/` berisi versi pipeline Python memakai **Pipecat AI** dengan
interupsi natural (barge-in) dan WebRTC. Pakai ini kalau Anda ingin latensi
sangat rendah atau ingin menyambungkan layanan avatar realtime seperti Simli
atau HeyGen langsung di dalam pipeline. Panduan ada di `pipecat/README.md`.

Untuk kebutuhan "web tanya-jawab dengan avatar", versi Node di root sudah
cukup dan jauh lebih ringan.

---

## 10. Masalah yang sering terjadi

| Gejala | Penyebab & solusi |
| --- | --- |
| Mikrofon tidak muncul | Buka lewat `localhost` atau HTTPS. Izinkan mikrofon di browser |
| "API key LLM belum diisi" | Isi `GROQ_API_KEY` di `.env`, lalu restart |
| Mulut tidak pas | Ulangi kalibrasi, lalu setel slider lebar/tinggi mulut |
| Mulut bergerak berlebihan | Turunkan *Kekuatan lipsync* |
| Suara balasan bukan suara saya | `TTS_PROVIDER` masih `browser`, atau `ELEVENLABS_VOICE_ID` kosong |
| Pengenalan suara meleset | Pakai `STT_PROVIDER=groq` (Whisper) untuk akurasi jauh lebih baik |
| Avatar memotong ucapan sendiri | Matikan *Mode ngobrol otomatis*, gunakan tekan-tahan |

Lisensi: MIT. Pastikan foto dan suara yang Anda kloning adalah milik Anda
sendiri, atau Anda punya izin tertulis dari pemiliknya.
