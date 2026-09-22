# Cara merekam sample suara untuk kloning

Kualitas kloning 90% ditentukan oleh kualitas rekaman, bukan oleh AI-nya.

## Syarat rekaman

| Hal | Target |
| --- | --- |
| Durasi | 1-3 menit (lebih dari itu tidak menambah banyak) |
| Suara | hanya Anda, tanpa orang lain |
| Latar | sunyi, tanpa musik, tanpa kipas/AC berdesing |
| Ruangan | banyak kain/karpet supaya tidak bergema. Hindari kamar mandi & ruang kosong |
| Jarak mik | 15-20 cm, sedikit menyamping agar tidak "pop" |
| Format | mp3, m4a, atau wav |
| Gaya bicara | seperti Anda menjawab pertanyaan pengunjung: tenang, jelas, tempo normal |

Hindari: berbisik, berteriak, tertawa panjang, jeda kosong yang sangat lama,
efek/filter suara, dan rekaman dari speaker HP.

## Teks latihan (baca dengan santai, ulangi bila kurang dari 1 menit)

> Halo, terima kasih sudah berkunjung. Saya senang bisa membantu menjawab
> pertanyaan Anda hari ini. Silakan tanyakan apa saja tentang layanan saya,
> mulai dari proses pengerjaan, kisaran biaya, sampai perkiraan waktu selesai.
>
> Kalau ada yang belum jelas, sampaikan saja, nanti saya jelaskan dengan
> bahasa yang lebih sederhana. Saya biasanya membalas pesan antara jam
> sembilan pagi sampai sembilan malam.
>
> Satu, dua, tiga, empat, lima, enam, tujuh, delapan, sembilan, sepuluh.
> Sekarang tanggal dua puluh satu, bulan Agustus, tahun dua ribu dua puluh enam.
>
> Baik, kalau begitu kita lanjutkan. Menurut saya langkah pertama yang paling
> penting adalah memahami kebutuhan Anda dulu, supaya hasilnya benar-benar pas
> dan tidak perlu banyak revisi.

Sertakan variasi: satu kalimat tanya, satu kalimat antusias, satu kalimat
tenang. Variasi membuat suara kloning tidak terdengar datar.

## Merapikan rekaman (opsional, gratis)

Dengan ffmpeg: potong bagian sunyi, normalkan volume, buang desis ringan.

```bash
ffmpeg -i mentah.m4a -af "highpass=f=80,afftdn=nr=12,loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -b:a 192k sample-suara.mp3
```

## Kloning

```bash
npm run clone-voice -- sample-suara.mp3 "Suara Saya"
```

Salin `voice_id` hasilnya ke `.env` pada `ELEVENLABS_VOICE_ID`, lalu restart
server.

## Menyetel rasa suara

Di `.env`:

| Isian | Efek |
| --- | --- |
| `ELEVENLABS_STABILITY` naik (0.6-0.8) | lebih tenang & konsisten, kurang ekspresif |
| `ELEVENLABS_STABILITY` turun (0.3) | lebih hidup, kadang liar |
| `ELEVENLABS_SIMILARITY` naik (0.85-0.95) | lebih mirip Anda, tapi noise sample ikut tercontoh |
| `ELEVENLABS_SPEED` 0.95-1.05 | tempo bicara |
| `ELEVENLABS_MODEL_ID=eleven_multilingual_v2` | paling natural, sedikit lebih lambat & mahal |
| `ELEVENLABS_MODEL_ID=eleven_flash_v2_5` | paling cepat & hemat kredit (default) |

## Etika dan hukum

Kloning hanya suara Anda sendiri, atau suara orang yang memberi izin tertulis.
Sebaiknya beri keterangan kecil di web bahwa pengunjung sedang berbicara dengan
avatar AI, bukan dengan Anda secara langsung.
