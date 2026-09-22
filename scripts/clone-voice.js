#!/usr/bin/env node
/**
 * Kloning suara Anda di ElevenLabs dari sebuah file rekaman.
 *
 *   npm run clone-voice -- sample-suara.mp3 "Suara Saya"
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "../server/env.js"
import { getConfig } from "../server/config.js"
import { cloneVoice } from "../server/providers/tts.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
loadEnv(path.join(ROOT, ".env"))

const [fileArg, nameArg] = process.argv.slice(2)

if (!fileArg) {
	console.error('Pemakaian: npm run clone-voice -- sample-suara.mp3 "Suara Saya"')
	process.exit(1)
}

const filePath = path.resolve(process.cwd(), fileArg)
if (!fs.existsSync(filePath)) {
	console.error(`File tidak ditemukan: ${filePath}`)
	process.exit(1)
}

const config = getConfig(true)
if (!config.tts.elevenlabs.apiKey) {
	console.error("ELEVENLABS_API_KEY belum diisi di .env")
	process.exit(1)
}

const buffer = fs.readFileSync(filePath)
const sizeMb = (buffer.length / 1024 / 1024).toFixed(2)
const ext = path.extname(filePath).toLowerCase()
const mimeType =
	ext === ".wav"
		? "audio/wav"
		: ext === ".m4a" || ext === ".mp4"
			? "audio/mp4"
			: ext === ".webm"
				? "audio/webm"
				: "audio/mpeg"

console.log(`Mengunggah ${path.basename(filePath)} (${sizeMb} MB)...`)

try {
	const { voiceId } = await cloneVoice({
		buffer,
		fileName: path.basename(filePath),
		mimeType,
		name: nameArg || "Suara Saya",
	})
	console.log("\nBerhasil. Tambahkan baris ini ke .env lalu restart server:\n")
	console.log(`ELEVENLABS_VOICE_ID=${voiceId}`)
	console.log("TTS_PROVIDER=elevenlabs\n")
} catch (error) {
	console.error(`\nGagal: ${error.message}`)
	process.exit(1)
}
