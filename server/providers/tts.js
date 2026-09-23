import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getConfig } from "../config.js"

// msedge-tts dimuat saat dibutuhkan supaya server tetap jalan walau `npm install` belum dijalankan
let edgeModule = null
async function loadEdge() {
	if (!edgeModule) {
		edgeModule = import("msedge-tts").catch((error) => {
			edgeModule = null
			throw new Error("Paket msedge-tts belum terpasang. Jalankan `npm install` di folder proyek, atau ganti TTS_PROVIDER di .env. (" + error.message + ")")
		})
	}
	return edgeModule
}

/** Teks -> audio dengan suara kloning Anda. */

let cacheDir = ""
export function setCacheDir(dir) {
	cacheDir = dir
	try {
		fs.mkdirSync(dir, { recursive: true })
	} catch {
		/* abaikan */
	}
}

function cacheKey(text, provider, voice, model) {
	return crypto
		.createHash("sha1")
		.update([provider, voice, model, text].join("|"))
		.digest("hex")
}

async function edgeTts(text, voice = "id-ID-ArdiNeural") {
	const { MsEdgeTTS, OUTPUT_FORMAT } = await loadEdge()
	const tts = new MsEdgeTTS()
	await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Edge TTS timeout")), 12000)
		try {
			const { audioStream } = tts.toStream(text)
			const chunks = []
			audioStream.on("data", (c) => chunks.push(c))
			audioStream.on("end", () => {
				clearTimeout(timer)
				resolve(Buffer.concat(chunks))
			})
			audioStream.on("error", (err) => {
				clearTimeout(timer)
				reject(err)
			})
		} catch (err) {
			clearTimeout(timer)
			reject(err)
		}
	})
}

export async function synthesize(text) {
	const { tts } = getConfig()
	const clean = String(text || "").trim()
	if (!clean) throw new Error("Teks kosong")
	if (tts.provider === "browser") {
		throw new Error("TTS_PROVIDER=browser: suara dibuat di browser, bukan di server.")
	}

	const voice =
		tts.provider === "edge"
			? (process.env.EDGE_VOICE || "id-ID-ArdiNeural")
			: tts.provider === "elevenlabs"
				? tts.elevenlabs.voiceId
				: tts.provider === "fishaudio"
					? tts.fishaudio.voiceId
					: tts.openai.voice
	const model =
		tts.provider === "edge"
			? "edge-neural"
			: tts.provider === "elevenlabs"
				? tts.elevenlabs.modelId
				: tts.openai.model

	const key = cacheKey(clean, tts.provider, voice, model)
	const cacheFile = cacheDir ? path.join(cacheDir, `${key}.mp3`) : ""

	if (tts.cache && cacheFile && fs.existsSync(cacheFile)) {
		return { buffer: fs.readFileSync(cacheFile), contentType: "audio/mpeg", cached: true, key }
	}

	let buffer
	if (tts.provider === "edge") buffer = await edgeTts(clean, voice)
	else if (tts.provider === "elevenlabs") buffer = await elevenLabs(clean, tts.elevenlabs)
	else if (tts.provider === "fishaudio") buffer = await fishAudio(clean, tts.fishaudio)
	else if (tts.provider === "openai") buffer = await openAi(clean, tts.openai)
	else throw new Error(`TTS provider tidak dikenal: ${tts.provider}`)

	if (tts.cache && cacheFile) {
		try {
			fs.writeFileSync(cacheFile, buffer)
		} catch {
			/* abaikan */
		}
	}
	return { buffer, contentType: "audio/mpeg", cached: false, key }
}

/** Path file cache untuk key sha1 (dipakai rute /tts-cache/ bagi D-ID). */
export function cacheFileFor(key) {
	if (!cacheDir || !/^[a-f0-9]{40}$/.test(String(key || ""))) return null
	const file = path.join(cacheDir, `${key}.mp3`)
	return fs.existsSync(file) ? file : null
}

async function elevenLabs(text, cfg) {
	if (!cfg.apiKey) throw new Error("ELEVENLABS_API_KEY belum diisi di .env")
	if (!cfg.voiceId) {
		throw new Error(
			"ELEVENLABS_VOICE_ID belum diisi. Kloning dulu: npm run clone-voice -- sample-suara.mp3 \"Suara Saya\"",
		)
	}
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}?output_format=mp3_44100_128`
	const response = await fetch(url, {
		method: "POST",
		headers: { "xi-api-key": cfg.apiKey, "content-type": "application/json" },
		body: JSON.stringify({
			text,
			model_id: cfg.modelId,
			voice_settings: {
				stability: cfg.stability,
				similarity_boost: cfg.similarity,
				speed: cfg.speed,
				use_speaker_boost: true,
			},
		}),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`ElevenLabs error ${response.status}: ${detail.slice(0, 300)}`)
	}
	return Buffer.from(await response.arrayBuffer())
}

async function fishAudio(text, cfg) {
	if (!cfg.apiKey) throw new Error("FISHAUDIO_API_KEY belum diisi di .env")
	const response = await fetch("https://api.fish.audio/v1/tts", {
		method: "POST",
		headers: {
			authorization: `Bearer ${cfg.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text,
			reference_id: cfg.voiceId || undefined,
			format: "mp3",
			latency: "normal",
		}),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`Fish Audio error ${response.status}: ${detail.slice(0, 300)}`)
	}
	return Buffer.from(await response.arrayBuffer())
}

async function openAi(text, cfg) {
	if (!cfg.apiKey) throw new Error("OPENAI_API_KEY belum diisi di .env")
	const response = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			authorization: `Bearer ${cfg.apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: "mp3" }),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`OpenAI TTS error ${response.status}: ${detail.slice(0, 300)}`)
	}
	return Buffer.from(await response.arrayBuffer())
}

/** Kloning suara instan ElevenLabs dari sample rekaman Anda. */
export async function cloneVoice({ buffer, fileName = "sample.mp3", mimeType = "audio/mpeg", name }) {
	const { tts } = getConfig()
	const apiKey = tts.elevenlabs.apiKey
	if (!apiKey) throw new Error("ELEVENLABS_API_KEY belum diisi di .env")

	const form = new FormData()
	form.append("name", name || "Suara Saya")
	form.append("files", new Blob([buffer], { type: mimeType }), fileName)
	form.append("remove_background_noise", "true")
	form.append(
		"description",
		"Kloning suara pemilik avatar untuk Avatar AI Lifetime",
	)

	const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
		method: "POST",
		headers: { "xi-api-key": apiKey },
		body: form,
	})
	const detail = await response.text()
	if (!response.ok) {
		throw new Error(`Kloning gagal ${response.status}: ${detail.slice(0, 400)}`)
	}
	const data = JSON.parse(detail)
	return { voiceId: data.voice_id, raw: data }
}

/** Daftar voice yang ada di akun ElevenLabs. */
export async function listVoices() {
	const { tts } = getConfig()
	if (!tts.elevenlabs.apiKey) return []
	const response = await fetch("https://api.elevenlabs.io/v1/voices", {
		headers: { "xi-api-key": tts.elevenlabs.apiKey },
	})
	if (!response.ok) return []
	const data = await response.json()
	return (data.voices || []).map((v) => ({
		voiceId: v.voice_id,
		name: v.name,
		category: v.category,
	}))
}
