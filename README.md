# Avatar AI Lifetime

Avatar AI dari **satu foto Anda** dan **suara Anda sendiri**. Pengunjung web cukup
bicara ke mikrofon, lalu:

```
suara pengunjung -> teks (STT) -> jawaban AI (LLM) -> suara Anda (TTS) -> foto bergerak (mulut, kepala, badan)
```

Semua berjalan dari satu server Node.js ringan (dependency npm hanya
`msedge-tts` untuk suara gratis dan `simli-client` opsional), jadi bisa jalan
di PC/VPS kecil. Animasi wajah sepenuhnya di browser, tanpa biaya API.

---

## 1. Jalankan dalam 3 menit

**Windows:** klik dua kali **`start.bat`** (memasang dependency, membuat `.env`, menjalankan
server, dan menampilkan pesan error bila ada). **macOS/Linux:** `./start.sh`.

Atau manual:

```bash
# butuh Node.js 20 atau lebih baru (https://nodejs.org)
node -v

npm install
cp .env.example .env
npm start
```

Buka alamat yang tercetak di terminal, biasanya **http://localhost:8787** (kalau port itu
sedang dipakai, server otomatis pindah ke 8788 dan mencetak alamatnya). Biarkan jendela
terminal tetap terbuka selama dipakai.

Kalau browser menampilkan "localhost refused to connect", servernya belum jalan: jalankan
`npm run doctor` untuk diagnosa (versi Node, dependency, .env, port) dan kirim hasilnya.

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
2. Wajah **dideteksi otomatis** (478 titik wajah, MediaPipe, berjalan di browser,
   gratis). Hasilnya di-cache di browser sehingga kunjungan berikutnya instan.
3. Bila deteksi gagal (wajah terlalu kecil / menoleh), klik **Kalibrasi manual**:
   klik garis pertemuan bibir, pupil mata kiri, pupil mata kanan.
4. Setel slider *Bukaan mulut* dan *Gerak kepala & badan*. Tersimpan otomatis.

**Foto yang bagus:** setengah badan, wajah lurus ke kamera, mulut tertutup,
pencahayaan rata, latar rapi, wajah minimal ~150 px lebar (idealnya foto
800 px lebar atau lebih). Foto seluruh badan dengan wajah kecil tidak akan
terdeteksi dan hasilnya kurang bagus.

### Cara kerja animasi (mode `puppet`, gratis)

Bukan lagi "tempel patch mulut": foto dipecah menjadi ~1.100 segitiga dari 478
titik wajah dan dirender ulang tiap frame dengan WebGL (`public/js/mesh.js`,
`warp.js`, `puppet.js`), sehingga bentuk wajah benar-benar berubah:

- **Rahang & bibir**: rahang turun (dagu ikut), bibir membentuk viseme
  a / i / u / e / o, bilabial (m, b, p) menutup, f/v bibir bawah masuk,
  s/z gigi rapat. Rongga mulut, gigi atas/bawah, dan lidah digambar di dalam
  celah bibir dengan warna yang diambil dari foto.
- **Lipsync dari teks + audio** (`public/js/lipsync.js`): teks kalimat diubah
  menjadi urutan fonem, lalu disejajarkan dengan puncak energi audio TTS
  (Fish Audio / ElevenLabs / Edge). Mulut mengikuti vokal yang benar-benar
  diucapkan, bukan sekadar volume.
- **Mata**: kelopak benar-benar menutup saat kedip (dengan kedip ganda sesekali),
  sakadik/arah pandang bergeser natural, melirik ke atas saat "berpikir".
- **Kepala**: gerak mikro 3D semu (paralaks dari kedalaman tiap titik wajah),
  angguk halus saat menekankan kata, miring kepala saat mendengarkan.
  Kepala bergerak terpisah dari badan, badan bernapas.
- **Ekspresi**: alis naik saat penekanan/mendengar, senyum tipis saat diam dan
  senyum kecil setelah selesai menjawab.

Tanpa WebGL, otomatis kembali ke mode 2D sederhana (`puppet-legacy.js`).

---

## 5. Kalau ingin gerakan sekelas HeyGen

Mode puppet gratis sudah bergerak seperti manusia (mesh wajah + lipsync viseme).
Kalau ingin video AI generatif penuh (rambut/kain ikut bergerak), ada mode berbayar:

| Mode | Isi `.env` | Catatan |
| --- | --- | --- |
| `puppet` (default) | - | Gratis, real-time, jalan di semua browser modern (WebGL) |
| `simli` | `AVATAR_MODE=simli`, `SIMLI_API_KEY`, `SIMLI_FACE_ID` | Streaming WebRTC real-time, wajah dari satu foto, termurah (~$0,01/menit), ada tier gratis |
| `did` | `AVATAR_MODE=did`, `DID_API_KEY` | Streaming WebRTC dari satu foto lewat *Agents Streams* (fluent idle) dengan cadangan API lama; foto lokal diunggah otomatis, `DID_SOURCE_URL` opsional |
| `heygen` | - | Belum tersedia di versi web ini (butuh SDK HeyGen); server sudah menyediakan endpoint token |

### Mode Anam: cara coba (10 menit)

Anam menghasilkan avatar yang sangat natural (wajah + tubuh atas). Di sini dipakai mode
**audio passthrough**: suara tetap dari Fish Audio/ElevenLabs Anda, Anam hanya merender avatar
yang bibirnya sinkron dan memutar suaranya.

1. Daftar di **lab.anam.ai** (gratis: 30 menit/bulan, watermark, percakapan maks 3 menit;
   Starter $12/bln = 50 menit + $0,16/menit). Buka **Settings -> API Keys**, salin key.
2. Isi `.env`:

```env
AVATAR_MODE=anam
ANAM_API_KEY=xxxxxxxx
ANAM_AVATAR_ID=            # kosong = avatar contoh "Cara" untuk tes cepat
TTS_PROVIDER=fishaudio     # suara Anda tetap dari Fish Audio
```

3. `npm start` (Windows: `start.bat`), buka http://localhost:8787, tanya sesuatu. Video Anam
   menggantikan foto; suara Fish Audio diputar oleh Anam sinkron dengan bibir.
4. Avatar dari foto Anda (dua cara):
   - Terminal: `npm run anam-avatars -- --create "Nofal" foto-saya.jpg` (foto lokal langsung
     diunggah; JPEG/PNG/WebP maks 4,5 MB, disarankan persegi minimal 1152x1152, wajah fokus,
     tangan tidak terlihat, ruang kosong di sekitar kepala & bahu). Skrip mencetak ID-nya.
   - Dashboard: **lab.anam.ai -> Build -> Avatar -> Add**, unggah foto, tunggu jadi, salin ID.

   Isi ID ke `ANAM_AVATAR_ID`, restart. Daftar semua avatar beserta ID: `npm run anam-avatars`.
   Paket gratis punya jatah slot avatar kustom terbatas (1 avatar).

Catatan biaya: Anam menagih per detik sesi tersambung (termasuk saat diam). Sesi ditutup
otomatis setelah idle `ANAM_MAX_IDLE` detik (default 90) dan tersambung lagi (~1-2 detik) saat
Anda bertanya. Paket gratis memutus percakapan tiap 3 menit - aplikasi menyambung ulang
otomatis. Gagal apa pun -> avatar foto lokal + suara lokal mengambil alih.

### Mode Simli: cara coba (10 menit)

1. Daftar di **app.simli.com** (gratis: 50 menit/bulan + kredit $10), buka menu API key, salin.
2. Isi `.env`:

```env
AVATAR_MODE=simli
SIMLI_API_KEY=xxxxxxxx
SIMLI_FACE_ID=            # kosong = wajah contoh Simli, untuk tes cepat
TTS_PROVIDER=fishaudio    # suara Anda tetap dari Fish Audio
```

3. `npm start`, buka http://localhost:8787, tanya sesuatu. Video Simli tampil menggantikan
   foto; suara diputar oleh Simli (sinkron dengan bibir), bukan lokal.
4. Wajah dari foto Anda sendiri (model **Trinity**, lebih hidup):

```bash
npm run simli-face -- foto-saya.jpg "Nama Saya"
```

   Skrip membingkai ulang foto (syarat: JPG/PNG < 5 MB, minimal 512x512, satu orang menghadap
   kamera, kepala >= 15% tinggi foto), mengirim ke Simli, memantau status tiap 20 detik, lalu
   mencetak `SIMLI_FACE_ID` untuk `.env`. Pembuatan bisa beberapa menit sampai jam; cek lagi
   dengan `npm run simli-face -- --status <face_id>` atau `--list`. Bisa juga lewat dashboard
   (Create Avatar).

Catatan biaya: Simli menghitung **menit tersambung** (termasuk saat diam). Karena itu sesi
ditutup setelah idle `SIMLI_MAX_IDLE` detik (default 90) dan tersambung lagi otomatis (~1-2
detik) saat Anda bertanya. Kalau Simli terputus atau gagal, avatar foto lokal + suara lokal
langsung mengambil alih.

### Mode D-ID: cara kerja & optimasi

- Server membuat **Agent** D-ID dari foto yang sedang dipasang (`POST /images` -> `POST /agents`,
  id disimpan di `cache/did/`), lalu membuka stream WebRTC dengan `fluent` (gerak diam alami)
  dan `stream_warmup`. Bila akun tidak mendukung `fluent`/agents, otomatis turun ke stream
  biasa lalu ke API lama (`talks/streams`, resolusi `DID_RESOLUTION`).
- Audio Fish Audio/ElevenLabs diunggah ke D-ID **saat prefetch** (paralel dengan kalimat yang
  sedang diputar) sehingga saat giliran bicara hanya perlu satu panggilan. Bila server punya URL
  https publik (`PUBLIC_BASE_URL`), D-ID membaca audio langsung dari `/tts-cache/` tanpa unggah.
- Jawaban dipecah: **kalimat pertama** dikirim segera (respons cepat), sisanya digabung jadi
  satu *talk* supaya tidak ada jeda antar kalimat.
- Sinkronisasi memakai event data channel (`stream/ready`, `stream/started`, `stream/done`);
  tanpa fluent, video D-ID hanya ditampilkan saat bicara dan avatar foto lokal (bernapas,
  berkedip) mengisi saat diam, jadi tidak ada frame beku/hitam.
- Gagal apa pun (kuota habis, WebRTC putus) -> otomatis kembali ke avatar foto + suara lokal
  tanpa memutus percakapan. Latensi "mulai bicara" ditampilkan di Pengaturan > Status mesin.
- Biaya (harga API D-ID, Sept 2026): Build $18/bln = 64 kredit (~32 menit streaming, lisensi
  personal), Launch $50/bln = 180 kredit (~90 menit), Scale $198/bln = 800 kredit (~400 menit).
  Streaming dihitung ~2 kredit/menit bicara, jadi efektif **~$0,50-0,56 per menit** - jauh lebih
  mahal daripada Simli/bitHuman/LemonSlice (lihat tabel di bawah). Idle tidak dihitung.

### Perbandingan layanan avatar real-time (harga publik, Sept 2026)

| Layanan | Harga masuk | Efektif per menit | Dari foto sendiri? | Gerak badan | Catatan |
| --- | --- | --- | --- | --- | --- |
| **Simli** | Gratis 50 mnt/bln (+$10 kredit); Hobby $10 = 1.000 mnt | ~$0,01 | Ya (1 foto) | Kepala & bahu saja | Sudah terintegrasi (`simli`). Lipsync bagus, latensi <300 ms |
| **bitHuman** | Gratis 99 kredit/bln; Creator $20 = 1.800 kredit | ~$0,02-0,04 (2-4 kredit/mnt) | Ya (foto atau video) | Ya (tubuh atas, idle penuh) | Bisa render di perangkat/browser (setengah harga). SDK berbasis LiveKit |
| **LemonSlice** | Starter $8 = 41 mnt; Scale $240 = 1.463 mnt | ~$0,16-0,19 (enterprise s/d $0,039) | Ya (1 foto, avatar tak terbatas) | Ya (ekspresi + gestur tubuh) | API di semua paket, BYO LLM/suara, panggilan 30 menit |
| **Anam** | Gratis 30 mnt (watermark); Starter $12 = 50 mnt | $0,11-0,16 | Ya (1 foto) | Tubuh atas, sangat natural | **Sudah terintegrasi** (`anam`, suara tetap Fish Audio). Free: sesi maks 3 menit, Starter 5 |
| **HeyGen LiveAvatar** | Gratis 10 kredit; Starter $19 = 150 kredit; avatar kustom butuh $99 | ~$0,10-0,13 (Lite, audio sendiri) | Ya (1 foto atau video 2 menit) | Ya (dari video: gestur penuh) | 1080p, concurrency tak terbatas; SDK belum dibundel di repo ini |
| **Akool** | Pro Max $41/bln = 1.200 kredit | ~$0,17-0,25 (6-7 kredit/mnt) | Perlu video untuk avatar streaming | Ya (tubuh penuh) | Berbasis Agora RTC |
| **Tavus** | Gratis 25 mnt; Starter $59 = 100-175 mnt | $0,32-0,37 | Perlu video 2 menit | Wajah + tubuh atas, paling realistis | Paling mahal setelah D-ID |
| **D-ID** | Build $18 = ~32 mnt; Launch $50 = ~90 mnt | ~$0,50-0,56 | Ya (1 foto) | Wajah + kepala sedikit, tanpa badan | Terintegrasi (`did`); API `talks/streams` sudah legacy |

Rekomendasi kalau ingin murah dan "lengkap" (badan + wajah + mulut) dari satu foto:
**LemonSlice** (gestur tubuh terbaik dari satu foto, $8/bln, API di semua paket) atau
**bitHuman** (paling murah dengan gerak badan, ada tier gratis). Kalau cukup wajah + kepala:
**Simli** (~$0,01/menit, sudah bisa dipakai di repo ini). Kalau sanggup merekam video 2 menit
dan mau bayar lebih: HeyGen LiveAvatar atau Tavus. Harga penyedia sering berubah - cek halaman
resminya sebelum memutuskan.

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
    js/puppet.js          mesin animasi foto v2 (perilaku hidup, rongga mulut, gigi)
    js/mesh.js            rig wajah, triangulasi Delaunay, bobot & deformasi mesh
    js/warp.js            perender mesh WebGL
    js/lipsync.js         viseme dari teks + amplop audio
    js/face-detect.js     deteksi 478 titik wajah (MediaPipe) + cache
    js/puppet-legacy.js   mode 2D cadangan bila WebGL tidak ada
    js/audio.js           mikrofon, deteksi diam, pemutar WebAudio + lipsync
    js/simli.js, did.js   mode avatar streaming berbayar (opsional)
    assets/avatar.landmarks.json  landmark foto contoh (start instan)
  scripts/qa/             render uji offline (Node, tanpa browser)
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
| "Wajah tidak terdeteksi" | Pakai foto setengah badan menghadap kamera (wajah cukup besar). Atau klik *Kalibrasi manual* |
| Deteksi wajah lama / gagal memuat | Butuh internet untuk mengunduh model (~4 MB, sekali). Bisa diarahkan ke salinan lokal lewat `VISION_TASKS_URL` / `VISION_MODEL_URL` |
| Mulut terbuka terlalu lebar / kecil | Setel slider *Bukaan mulut* |
| Gerak kepala terlalu banyak | Turunkan *Gerak kepala & badan* |
| Suara balasan bukan suara saya | `TTS_PROVIDER` masih `browser`, atau `ELEVENLABS_VOICE_ID` kosong |
| Pengenalan suara meleset | Pakai `STT_PROVIDER=groq` (Whisper) untuk akurasi jauh lebih baik |
| Avatar memotong ucapan sendiri | Matikan *Mode ngobrol otomatis*, gunakan tekan-tahan |

Lisensi: MIT. Pastikan foto dan suara yang Anda kloning adalah milik Anda
sendiri, atau Anda punya izin tertulis dari pemiliknya.
