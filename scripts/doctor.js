#!/usr/bin/env node
/**
 * Diagnosa cepat: kenapa web tidak bisa dibuka? Jalankan: npm run doctor
 * Memeriksa versi Node, dependency, file .env, port, dan ringkasan konfigurasi.
 */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "../server/env.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ok = (msg) => console.log("  [OK]   " + msg)
const warn = (msg) => console.log("  [!!]   " + msg)
const mask = (v) => (v ? v.slice(0, 4) + "..." + v.slice(-3) + ` (${v.length} karakter)` : "(kosong)")

console.log("\nAVATAR AI LIFETIME - diagnosa\n")

// 1. Node
const major = Number(process.versions.node.split(".")[0])
if (major >= 20) ok(`Node.js ${process.versions.node}`)
else if (major >= 18) warn(`Node.js ${process.versions.node} masih jalan, tapi disarankan Node 20 LTS`)
else warn(`Node.js ${process.versions.node} terlalu lama -> pasang Node 20 LTS dari https://nodejs.org`)

// 2. dependency
const deps = ["msedge-tts", "simli-client"]
for (const dep of deps) {
	if (fs.existsSync(path.join(ROOT, "node_modules", dep))) ok(`dependency ${dep} terpasang`)
	else warn(`dependency ${dep} belum ada -> jalankan: npm install${dep === "msedge-tts" ? " (dibutuhkan untuk suara Edge TTS gratis)" : ""}`)
}

// 3. .env
const envFile = path.join(ROOT, ".env")
if (fs.existsSync(envFile)) ok("file .env ada")
else warn("file .env belum ada (server akan membuatnya otomatis dari .env.example saat start)")
loadEnv(envFile)
const port = Number(process.env.PORT) || 8787
const get = (k) => (process.env[k] || "").trim()
console.log(`         PORT=${port}  AVATAR_MODE=${get("AVATAR_MODE") || "puppet"}  TTS_PROVIDER=${get("TTS_PROVIDER") || "edge (default)"}  LLM_PROVIDER=${get("LLM_PROVIDER") || "groq"}`)
console.log(`         GROQ_API_KEY=${mask(get("GROQ_API_KEY"))}  FISHAUDIO_API_KEY=${mask(get("FISHAUDIO_API_KEY"))}`)
console.log(`         SIMLI_API_KEY=${mask(get("SIMLI_API_KEY"))}  SIMLI_FACE_ID=${get("SIMLI_FACE_ID") || "(kosong -> wajah contoh)"}  DID_API_KEY=${mask(get("DID_API_KEY"))}`)
const mode = (get("AVATAR_MODE") || "puppet").toLowerCase()
if (mode === "simli" && !get("SIMLI_API_KEY")) warn("AVATAR_MODE=simli tapi SIMLI_API_KEY kosong -> avatar foto lokal yang dipakai")
if (mode === "did" && !get("DID_API_KEY")) warn("AVATAR_MODE=did tapi DID_API_KEY kosong -> avatar foto lokal yang dipakai")
if ((get("TTS_PROVIDER") || "").toLowerCase() === "fishaudio" && !get("FISHAUDIO_API_KEY")) warn("TTS_PROVIDER=fishaudio tapi FISHAUDIO_API_KEY kosong")

// 4. port
await new Promise((resolve) => {
	const tester = net.createServer()
	tester.once("error", (error) => {
		if (error.code === "EADDRINUSE") warn(`port ${port} sedang dipakai proses lain (server lama masih jalan?). Server akan otomatis pindah ke port berikutnya; lihat alamat yang tercetak saat start.`)
		else warn(`port ${port}: ${error.message}`)
		resolve()
	})
	tester.once("listening", () => {
		ok(`port ${port} bebas`)
		tester.close(resolve)
	})
	tester.listen(port)
})

// 5. file penting
for (const f of ["server/index.js", "public/index.html", "public/js/app.js", "public/js/puppet.js", "public/assets/avatar.jpg"]) {
	if (fs.existsSync(path.join(ROOT, f))) ok(f)
	else warn(`${f} tidak ditemukan (repo tidak lengkap? jalankan git pull)`)
}

console.log("\nLangkah: npm start  (Windows: klik dua kali start.bat)  ->  buka http://localhost:" + port + "\n")
