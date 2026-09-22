#!/usr/bin/env node
/**
 * Cek kesiapan semua provider: npm run check
 * Aman dijalankan kapan saja; hanya memanggil endpoint ringan.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnv } from "../server/env.js"
import { getConfig } from "../server/config.js"
import * as llm from "../server/providers/llm.js"
import * as tts from "../server/providers/tts.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv(path.join(path.resolve(__dirname, ".."), ".env"))
const config = getConfig(true)

const results = []
const push = (name, ok, note) => results.push({ name, ok, note })

/* LLM */
if (!llm.isReady()) {
	push("LLM", false, `${config.llm.label}: API key kosong`)
} else {
	try {
		const reply = await llm.chat([
			{ role: "system", content: "Jawab satu kata saja." },
			{ role: "user", content: "Sebutkan satu kata: siap" },
		])
		push("LLM", true, `${config.llm.label} / ${config.llm.model} -> "${reply.slice(0, 40)}"`)
	} catch (error) {
		push("LLM", false, error.message.slice(0, 160))
	}
}

/* STT */
if (config.stt.provider === "browser") push("STT", true, "memakai Web Speech API di browser (gratis)")
else if (!config.stt.apiKey) push("STT", false, `${config.stt.label}: API key kosong`)
else push("STT", true, `${config.stt.label} siap (uji sebenarnya lewat mikrofon di web)`)

/* TTS */
if (config.tts.provider === "browser") {
	push("TTS", true, "memakai suara bawaan browser (bukan suara Anda)")
} else {
	try {
		const { buffer, cached } = await tts.synthesize("Uji suara satu dua tiga.")
		push("TTS", true, `${config.tts.label}: ${(buffer.length / 1024).toFixed(1)} KB${cached ? " (dari cache)" : ""}`)
	} catch (error) {
		push("TTS", false, error.message.slice(0, 160))
	}
}

/* Daftar voice ElevenLabs */
if (config.tts.elevenlabs.apiKey) {
	try {
		const voices = await tts.listVoices()
		const mine = voices.filter((v) => v.category === "cloned")
		push(
			"Voice",
			mine.length > 0,
			mine.length
				? mine.map((v) => `${v.name} = ${v.voiceId}`).join(", ")
				: "belum ada voice hasil kloning di akun ini",
		)
	} catch (error) {
		push("Voice", false, error.message.slice(0, 120))
	}
}

/* Avatar */
if (config.avatar.mode === "puppet") push("Avatar", true, "mode puppet (gratis, animasi foto di browser)")
else if (config.avatar.mode === "heygen") push("Avatar", Boolean(config.avatar.heygen.apiKey), "HeyGen")
else push("Avatar", Boolean(config.avatar.did.apiKey), "D-ID")

console.log("")
for (const row of results) {
	console.log(`  ${row.ok ? "OK  " : "BELUM"}  ${row.name.padEnd(7)} ${row.note}`)
}
console.log("")
if (results.some((r) => !r.ok)) {
	console.log("  Lengkapi isian di .env untuk bagian yang masih BELUM.\n")
}
