# Menaikkan ke internet

Mikrofon browser hanya aktif di `localhost` atau domain **HTTPS**. Jadi untuk
dipakai orang lain, web ini harus di-hosting dengan HTTPS.

## Pilihan 1 - uji cepat dari HP (gratis)

```bash
npm start
# terminal lain:
npx cloudflared tunnel --url http://localhost:8787
```

Cloudflare memberi URL `https://...trycloudflare.com` yang langsung bisa dibuka
di HP. Cocok untuk demo ke klien.

## Pilihan 2 - Railway / Render (paling mudah, ada tier murah)

1. Unggah folder ini ke GitHub.
2. Buat service baru dari repo tersebut.
3. Build command: kosongkan. Start command: `npm start`.
4. Tambahkan semua variabel dari `.env` di menu Environment / Variables.
5. Set `PORT` mengikuti nilai yang diberikan platform (biasanya otomatis).

Proyek ini tidak punya dependency npm, jadi build-nya sangat cepat.

## Pilihan 3 - VPS sendiri (Rp 30-60 ribu / bulan)

```bash
# di VPS Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx

cd /var/www
sudo git clone <repo-anda> avatar
cd avatar
cp .env.example .env && nano .env

# jalankan sebagai layanan
sudo npm install -g pm2
pm2 start server/index.js --name avatar
pm2 save && pm2 startup
```

Nginx sebagai reverse proxy + HTTPS gratis:

```nginx
server {
  server_name avatar.domainanda.com;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_buffering off;   # penting: jawaban AI dialirkan (SSE)
    proxy_read_timeout 300s;
  }
}
```

```bash
sudo certbot --nginx -d avatar.domainanda.com
```

> `proxy_buffering off` wajib, kalau tidak jawaban streaming akan tertahan dan
> avatar terasa lambat menjawab.

## Menempelkan ke website yang sudah ada

```html
<iframe
  src="https://avatar.domainanda.com"
  allow="microphone; autoplay"
  style="width:100%;height:720px;border:0;border-radius:12px"
></iframe>
```

Atribut `allow="microphone"` wajib ada, kalau tidak mikrofon diblokir di dalam
iframe.

## Catatan keamanan

- API key hanya ada di server (`.env`), tidak pernah dikirim ke browser.
- Jangan pernah commit file `.env` ke GitHub.
- Batasi pemakaian: tambahkan rate limit di reverse proxy bila web dibuka publik,
  karena setiap pertanyaan memakai kredit LLM dan TTS.
- Folder `cache/` dan `uploads/` aman dihapus kapan saja.
