#!/usr/bin/env node
/**
 * Kelola avatar Anam dari terminal (butuh ANAM_API_KEY di .env).
 *
 *   npm run anam-avatars                                  # daftar avatar (stok + kustom) beserta ID-nya
 *   npm run anam-avatars -- --create "Nama Saya" foto.jpg # buat avatar dari foto lokal (atau URL https://...)
 *
 * Syarat foto: JPEG/PNG/WebP <= 4,5 MB, disarankan persegi >= 1152x1152, wajah fokus, tangan tidak
 * terlihat, ada ruang kosong di sekitar kepala & bahu. Bisa juga lewat dashboard:
 * https://lab.anam.ai -> Build -> Avatar -> Add. Setelah jadi, isi ANAM_AVATAR_ID di .env.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "../server/env.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
loadEnv(path.join(ROOT, ".env"))
const { anamListAvatars, anamCreateAvatar } = await import("../server/providers/avatarVideo.js")

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
	console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*\n/, "").replace(/^ \* ?/gm, ""))
	process.exit(0)
}
if (!(process.env.ANAM_API_KEY || "").trim()) {
	console.error("ANAM_API_KEY belum diisi di .env. Daftar gratis di https://lab.anam.ai lalu buat API key (Settings -> API Keys).")
	process.exit(1)
}

async function main() {
	const createAt = args.indexOf("--create")
	if (createAt >= 0) {
		const name = args[createAt + 1] || "Avatar Saya"
		const image = args[createAt + 2]
		if (!image) throw new Error("--create butuh nama dan file foto (atau URL https://...)")
		let created
		if (/^https?:\/\//i.test(image)) {
			console.log(`Membuat avatar "${name}" dari URL ${image} ...`)
			created = await anamCreateAvatar({ displayName: name, imageUrl: image })
		} else {
			if (!fs.existsSync(image)) throw new Error("File tidak ditemukan: " + image)
			const ext = path.extname(image).toLowerCase()
			const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"
			console.log(`Mengunggah ${image} dan membuat avatar "${name}" (bisa beberapa menit)...`)
			created = await anamCreateAvatar({ displayName: name, imageBuffer: fs.readFileSync(image), mime, fileName: path.basename(image) })
		}
		console.log(JSON.stringify(created, null, 2))
		const id = created && (created.id || created.avatarId)
		if (id) {
			console.log("\nTambahkan ke .env lalu restart server:")
			console.log("  AVATAR_MODE=anam")
			console.log("  ANAM_AVATAR_ID=" + id)
			console.log("(Pembuatan avatar bisa memakan beberapa menit; cek statusnya dengan: npm run anam-avatars)")
		}
		return
	}
	const avatars = await anamListAvatars()
	if (!avatars.length) return console.log("Tidak ada avatar yang terbaca. Cek API key atau buat avatar di https://lab.anam.ai")
	console.log(`${avatars.length} avatar:`)
	for (const a of avatars) console.log(`  ${a.id}  ${a.name}${a.variant ? " (" + a.variant + ")" : ""}`)
	console.log("\nPakai salah satu ID di .env: ANAM_AVATAR_ID=<id>  (AVATAR_MODE=anam)")
}

main().catch((error) => {
	console.error("Gagal:", error.message)
	process.exit(1)
})
