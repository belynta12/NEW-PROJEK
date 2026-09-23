#!/usr/bin/env node
/**
 * Buat wajah (faceId) Simli dari foto Anda lewat API, lalu pantau statusnya.
 *
 *   npm run simli-face -- foto.jpg "Nama Saya"          # Trinity (model terbaru, lebih hidup)
 *   npm run simli-face -- foto.jpg "Nama Saya" --legacy # model lama (lebih cepat, kualitas lebih rendah)
 *   npm run simli-face -- --status <face_id> [--legacy] # cek status pembuatan
 *   npm run simli-face -- --list                        # daftar wajah di akun Anda
 *
 * Opsi: --no-preprocess (lewati pembingkaian otomatis Trinity), --wait <menit> (default 30)
 * Butuh SIMLI_API_KEY di .env. Syarat foto Trinity: JPG/PNG/WEBP < 5 MB, minimal 512x512,
 * satu orang menghadap kamera, tinggi kepala >= 15% tinggi foto.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "../server/env.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
loadEnv(path.join(ROOT, ".env"))
const API = "https://api.simli.ai"
const apiKey = (process.env.SIMLI_API_KEY || "").trim()

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const flagValue = (name) => {
	const i = args.indexOf(name)
	return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--status", "--wait"].includes(args[i - 1])))

if (flag("--help") || flag("-h") || (!positional.length && !flag("--status") && !flag("--list"))) {
	console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*\n/, "").replace(/^ \* ?/gm, ""))
	process.exit(0)
}
if (!apiKey) {
	console.error("SIMLI_API_KEY belum diisi di .env. Daftar gratis di https://app.simli.com lalu buat API key.")
	process.exit(1)
}

const legacy = flag("--legacy")
const family = legacy ? "legacy" : "trinity"
const waitMinutes = Number(flagValue("--wait") || 30)

async function api(method, apiPath, { body, raw = false } = {}) {
	const response = await fetch(API + apiPath, { method, headers: { "x-simli-api-key": apiKey }, body })
	if (raw) {
		if (!response.ok) throw new Error(`${method} ${apiPath} -> ${response.status}: ${(await response.text()).slice(0, 400)}`)
		return Buffer.from(await response.arrayBuffer())
	}
	const text = await response.text()
	let data = null
	try {
		data = JSON.parse(text)
	} catch {
		data = { raw: text }
	}
	if (!response.ok) throw new Error(`${method} ${apiPath} -> ${response.status}: ${text.slice(0, 400)}`)
	return data
}

function findId(data) {
	if (!data || typeof data !== "object") return null
	for (const key of ["face_id", "faceId", "faceID", "id", "character_uid", "uid"]) {
		if (typeof data[key] === "string" && data[key].length >= 8) return data[key]
	}
	for (const value of Object.values(data)) {
		if (value && typeof value === "object") {
			const nested = findId(value)
			if (nested) return nested
		}
	}
	return null
}

function statusOf(data) {
	const text = JSON.stringify(data || {}).toLowerCase()
	if (/"(status|state|generation_status)"\s*:\s*"(done|completed|complete|ready|success|succeeded|finished)"/.test(text) || /"is_ready"\s*:\s*true/.test(text) || /"progress"\s*:\s*100/.test(text)) return "done"
	if (/"(status|state|generation_status)"\s*:\s*"(failed|error|rejected)"/.test(text) || /"error"\s*:\s*"[^"]+"/.test(text)) return "failed"
	return "pending"
}

async function pollStatus(faceId) {
	const deadline = Date.now() + waitMinutes * 60000
	let n = 0
	while (Date.now() < deadline) {
		n++
		let data
		try {
			data = await api("GET", `/faces/${family}/generation_status?face_id=${encodeURIComponent(faceId)}`)
		} catch (error) {
			console.log(`  [${n}] gagal cek status: ${error.message}`)
			await new Promise((r) => setTimeout(r, 20000))
			continue
		}
		const status = statusOf(data)
		console.log(`  [${n}] ${new Date().toLocaleTimeString()} status=${status} :: ${JSON.stringify(data).slice(0, 300)}`)
		if (status === "done") return true
		if (status === "failed") return false
		await new Promise((r) => setTimeout(r, 20000))
	}
	console.log("Batas waktu tunggu habis. Cek lagi nanti dengan: npm run simli-face -- --status " + faceId + (legacy ? " --legacy" : ""))
	return null
}

function printEnvHint(faceId) {
	console.log("\nTambahkan ke .env lalu restart server (npm start):")
	console.log("  AVATAR_MODE=simli")
	console.log("  SIMLI_FACE_ID=" + faceId)
}

async function main() {
	if (flag("--list")) {
		const faces = await api("GET", "/faces")
		const list = Array.isArray(faces) ? faces : faces.faces || faces.items || []
		if (!list.length) return console.log("Belum ada wajah di akun ini. Buat: npm run simli-face -- foto.jpg \"Nama\"")
		for (const f of list) console.log(`${f.id || findId(f)}  versi=${f.simli_version ?? "?"}  dibuat=${f.created_at || "?"}  ${f.name || f.face_name || ""}`)
		return
	}
	if (flag("--status")) {
		const faceId = flagValue("--status")
		if (!faceId) throw new Error("--status butuh face_id")
		const ok = await pollStatus(faceId)
		if (ok) printEnvHint(faceId)
		return
	}

	const file = positional[0]
	const name = (positional[1] || "Avatar Saya").slice(0, 60)
	if (!file || !fs.existsSync(file)) throw new Error("File foto tidak ditemukan: " + file)
	let buffer = fs.readFileSync(file)
	const ext = path.extname(file).toLowerCase()
	let mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"
	if (buffer.length > 5 * 1024 * 1024) throw new Error("Foto > 5 MB. Perkecil dulu (misal lebar 1600 px, kualitas 85).")
	let fileName = path.basename(file)

	if (!legacy && !flag("--no-preprocess")) {
		console.log("1/3 Membingkai ulang foto sesuai kebutuhan Trinity (~25 detik)...")
		const form = new FormData()
		form.append("image", new Blob([buffer], { type: mime }), fileName)
		try {
			const png = await api("POST", "/faces/trinity/preprocess", { body: form, raw: true })
			const out = path.join(ROOT, "uploads", `simli-face-${Date.now()}.png`)
			fs.mkdirSync(path.dirname(out), { recursive: true })
			fs.writeFileSync(out, png)
			buffer = png
			mime = "image/png"
			fileName = path.basename(out)
			console.log("    Hasil pembingkaian disimpan:", path.relative(ROOT, out))
		} catch (error) {
			console.log("    Pembingkaian gagal, lanjut dengan foto asli:", error.message)
		}
	}

	console.log(`2/3 Mengirim foto ke Simli (${family}) dengan nama "${name}"...`)
	const form = new FormData()
	form.append("image", new Blob([buffer], { type: mime }), fileName)
	const query = legacy ? `?face_name=${encodeURIComponent(name)}&characterVersion=1.5` : `?face_name=${encodeURIComponent(name)}&gsVersion=GSA_1.0`
	const created = await api("POST", `/faces/${family}${query}`, { body: form })
	console.log("    Jawaban:", JSON.stringify(created).slice(0, 500))
	const faceId = findId(created)
	if (!faceId) {
		console.log("Tidak menemukan face_id di jawaban. Cek daftar wajah: npm run simli-face -- --list")
		return
	}
	console.log("    face_id:", faceId)
	console.log(`3/3 Menunggu pembuatan selesai (bisa beberapa menit sampai jam; cek tiap 20 detik, maks ${waitMinutes} menit)...`)
	const ok = await pollStatus(faceId)
	if (ok === false) console.log("Pembuatan gagal. Coba foto lain yang lebih terang, menghadap kamera, kepala cukup besar.")
	if (ok) printEnvHint(faceId)
	else console.log("face_id Anda:", faceId, "- simpan; bila sudah jadi, isi SIMLI_FACE_ID dengan nilai ini.")
}

main().catch((error) => {
	console.error("Gagal:", error.message)
	process.exit(1)
})
