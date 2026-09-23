import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { getConfig } from "../config.js"

/**
 * Mode avatar berbayar (opsional):
 * - D-ID  : streaming WebRTC dari SATU foto. Dipakai lewat "Agents Streams" (API terbaru,
 *           mendukung mode fluent = gerak diam alami) dengan cadangan otomatis ke
 *           "Talks Streams" (legacy). Foto lokal diunggah otomatis ke D-ID (/images).
 * - Simli : token sesi WebRTC.
 * - HeyGen: token sesi (SDK belum dibundel di versi web ini).
 * Mode gratis (puppet) tidak butuh file ini.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..", "..")
const PUBLIC_DIR = path.join(ROOT, "public")
const UPLOAD_DIR = path.join(ROOT, "uploads")
const DID_CACHE_DIR = path.join(ROOT, "cache", "did")
const DID_API = "https://api.d-id.com"
const IMAGE_TTL_MS = 20 * 60 * 60 * 1000 // URL /images berlaku 24-48 jam; segarkan setelah 20 jam

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------- HeyGen -------------------------------- */

/** Token sesi HeyGen untuk dipakai SDK di browser (API key tetap aman di server). */
export async function heygenSessionToken() {
	const { avatar } = getConfig()
	if (!avatar.heygen.apiKey) throw new Error("HEYGEN_API_KEY belum diisi di .env")
	const response = await fetch("https://api.heygen.com/v1/streaming.create_token", {
		method: "POST",
		headers: { "x-api-key": avatar.heygen.apiKey, "content-type": "application/json" },
		body: "{}",
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`HeyGen token error ${response.status}: ${detail.slice(0, 300)}`)
	}
	const data = await response.json()
	const token = data?.data?.token
	if (!token) throw new Error("HeyGen tidak mengembalikan token")
	return { token, avatarId: avatar.heygen.avatarId, voiceId: avatar.heygen.voiceId }
}

/** Daftar avatar (termasuk photo avatar) di akun HeyGen. */
export async function heygenAvatars() {
	const { avatar } = getConfig()
	if (!avatar.heygen.apiKey) return []
	const response = await fetch("https://api.heygen.com/v2/avatars", {
		headers: { "x-api-key": avatar.heygen.apiKey },
	})
	if (!response.ok) return []
	const data = await response.json()
	const list = data?.data?.avatars || []
	return list.map((a) => ({ avatarId: a.avatar_id, name: a.avatar_name }))
}

/* -------------------------------- D-ID --------------------------------- */

function didCfg() {
	const { avatar } = getConfig()
	if (!avatar.did.apiKey) throw new Error("DID_API_KEY belum diisi di .env")
	return avatar.did
}

function didAuth() {
	return "Basic " + Buffer.from(didCfg().apiKey).toString("base64")
}

/** Panggilan API D-ID dengan pesan error yang informatif. */
async function didRequest(method, apiPath, body) {
	const headers = { authorization: didAuth(), accept: "application/json" }
	let payload
	if (body instanceof FormData) payload = body
	else if (body !== undefined) {
		headers["content-type"] = "application/json"
		payload = JSON.stringify(body)
	}
	const response = await fetch(DID_API + apiPath, { method, headers, body: payload })
	const text = await response.text().catch(() => "")
	let data = null
	if (text) {
		try {
			data = JSON.parse(text)
		} catch {
			data = { raw: text }
		}
	}
	if (!response.ok) {
		const error = new Error(`D-ID ${method} ${apiPath} -> ${response.status}: ${text.slice(0, 300)}`)
		error.status = response.status
		error.data = data
		throw error
	}
	return data
}

/* ------------------------------ cache disk ------------------------------ */

function readCache(name) {
	try {
		return JSON.parse(fs.readFileSync(path.join(DID_CACHE_DIR, `${name}.json`), "utf8"))
	} catch {
		return {}
	}
}

function writeCache(name, data) {
	try {
		fs.mkdirSync(DID_CACHE_DIR, { recursive: true })
		fs.writeFileSync(path.join(DID_CACHE_DIR, `${name}.json`), JSON.stringify(data, null, 1))
	} catch {
		/* abaikan */
	}
}

/* ------------------------------ foto sumber ----------------------------- */

/** Ubah src foto dari browser menjadi buffer lokal (uploads/, assets/, data URL) atau URL publik. */
export function resolveLocalPhoto(photoUrl) {
	const src = String(photoUrl || "").trim()
	if (!src) return null
	if (src.startsWith("data:")) {
		const match = src.match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
		if (!match) return null
		return { buffer: Buffer.from(match[2], "base64"), mime: match[1].toLowerCase() }
	}
	if (/^https?:\/\//i.test(src)) {
		try {
			const url = new URL(src)
			if (!["localhost", "127.0.0.1"].includes(url.hostname)) return { url: src }
			return resolveLocalPhoto(url.pathname)
		} catch {
			return null
		}
	}
	const clean = src.split("?")[0].replace(/^\.?\//, "")
	let file = null
	if (clean.startsWith("uploads/")) file = path.join(UPLOAD_DIR, path.normalize(clean.slice(8)))
	else file = path.join(PUBLIC_DIR, path.normalize(clean))
	if (!file.startsWith(UPLOAD_DIR) && !file.startsWith(PUBLIC_DIR)) return null
	if (!fs.existsSync(file)) return null
	const ext = path.extname(file).toLowerCase()
	const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"
	return { buffer: fs.readFileSync(file), mime, file }
}

/**
 * Dapatkan URL foto yang bisa diakses D-ID:
 *  1. DID_SOURCE_URL (bila diisi)
 *  2. foto lokal -> unggah ke D-ID /images (disimpan di cache 20 jam)
 *  3. URL http(s) lain dipakai langsung
 * Mengembalikan { url, key } dengan key stabil (sha1 isi file) untuk cache agent.
 */
export async function didImageUrlFor(photoUrl) {
	const cfg = didCfg()
	if (cfg.sourceUrl) return { url: cfg.sourceUrl, key: "env-" + sha1(cfg.sourceUrl) }
	const local = resolveLocalPhoto(photoUrl)
	if (!local) throw new Error("DID_SOURCE_URL belum diisi dan foto avatar tidak ditemukan di server. Unggah foto lewat Pengaturan atau isi DID_SOURCE_URL.")
	if (local.url) return { url: local.url, key: "url-" + sha1(local.url) }
	if (!["image/jpeg", "image/png"].includes(local.mime)) {
		throw new Error("D-ID hanya menerima foto JPG/PNG. Simpan ulang foto Anda sebagai JPG.")
	}
	const key = sha1(local.buffer)
	const cache = readCache("images")
	const hit = cache[key]
	if (hit && hit.url && Date.now() - (hit.ts || 0) < IMAGE_TTL_MS) return { url: hit.url, key }
	const form = new FormData()
	form.append("image", new Blob([local.buffer], { type: local.mime }), local.mime === "image/png" ? "avatar.png" : "avatar.jpg")
	const data = await didRequest("POST", "/images", form)
	if (!data || !data.url) throw new Error("D-ID tidak mengembalikan URL foto")
	if (Array.isArray(data.faces) && data.faces.length === 0) {
		throw new Error("D-ID tidak menemukan wajah pada foto. Pakai foto setengah badan menghadap kamera.")
	}
	cache[key] = { url: data.url, ts: Date.now(), id: data.id }
	writeCache("images", cache)
	return { url: data.url, key }
}

function sha1(input) {
	return crypto.createHash("sha1").update(input).digest("hex")
}

/* -------------------------------- agent --------------------------------- */

/** Ambil/buat Agent D-ID (presenter foto) untuk foto tertentu; id disimpan di cache. */
export async function didGetOrCreateAgent(imageKey, imageUrl, { forceNew = false } = {}) {
	const { persona } = getConfig()
	const cache = readCache("agents")
	const hit = cache[imageKey]
	if (hit && hit.id && !forceNew) return hit.id

	const created = await didRequest("POST", "/agents", {
		preview_name: (persona.name || "Avatar AI Lifetime").slice(0, 60),
		presenter: { type: "talk", source_url: imageUrl, thumbnail: imageUrl, stitch: true },
		llm: { provider: "auto", instructions: "Kamu adalah avatar yang hanya mengucapkan audio yang diberikan." },
	})
	const agentId = created && created.id
	if (!agentId) throw new Error("D-ID tidak mengembalikan id agent")
	// agent diproses asinkron: tunggu status "done" (maks ~45 detik)
	const deadline = Date.now() + 45000
	let status = created.status || "done"
	while (status && status !== "done" && Date.now() < deadline) {
		if (status === "error" || status === "failed") throw new Error("D-ID gagal memproses foto untuk agent (status " + status + ")")
		await sleep(1500)
		try {
			const info = await didRequest("GET", `/agents/${agentId}`)
			status = info && info.status ? info.status : "done"
		} catch (error) {
			if (error.status === 404) throw error
			status = "done"
		}
	}
	cache[imageKey] = { id: agentId, ts: Date.now(), imageUrl }
	writeCache("agents", cache)
	return agentId
}

/* ------------------------------- stream --------------------------------- */

let currentActiveStream = null

function normalizeStream(data, extra) {
	return {
		id: data.id,
		session_id: data.session_id,
		offer: data.offer || data.jsep,
		ice_servers: data.ice_servers || [],
		...extra,
	}
}

async function createAgentsStream(agentId, fluent) {
	const body = { fluent: Boolean(fluent), stream_warmup: true, compatibility_mode: "auto" }
	const data = await didRequest("POST", `/agents/${agentId}/streams`, body)
	return normalizeStream(data, { mode: "agents", agentId, fluent: Boolean(fluent), warmup: true })
}

async function createTalksStream(sourceUrl) {
	const cfg = didCfg()
	const resolution = Math.max(150, Math.min(1280, Math.round(cfg.resolution || 512)))
	const data = await didRequest("POST", "/talks/streams", {
		source_url: sourceUrl,
		stream_warmup: true,
		compatibility_mode: "auto",
		output_resolution: resolution,
	})
	return normalizeStream(data, { mode: "talks", agentId: null, fluent: false, warmup: true })
}

/**
 * Buat sesi WebRTC D-ID. Mengembalikan
 * { id, session_id, offer, ice_servers, mode: "agents"|"talks", agentId, fluent, warmup, notes[] }
 */
export async function didCreateStream({ photoUrl } = {}) {
	const cfg = didCfg()
	// tutup stream lama supaya tidak melebihi kuota stream bersamaan
	if (currentActiveStream) {
		try {
			await didDeleteStream(currentActiveStream)
		} catch {
			/* abaikan */
		}
		currentActiveStream = null
	}

	const { url: sourceUrl, key: imageKey } = await didImageUrlFor(photoUrl)
	const notes = []
	const attempts = []
	if (cfg.mode !== "talks") {
		attempts.push(async () => {
			let agentId = await didGetOrCreateAgent(imageKey, sourceUrl)
			const run = async (fluent) => {
				try {
					return await createAgentsStream(agentId, fluent)
				} catch (error) {
					if (error.status === 404) {
						// agent di cache sudah dihapus di akun D-ID -> buat baru sekali
						agentId = await didGetOrCreateAgent(imageKey, sourceUrl, { forceNew: true })
						return await createAgentsStream(agentId, fluent)
					}
					throw error
				}
			}
			if (cfg.fluent) {
				try {
					return await run(true)
				} catch (error) {
					notes.push("fluent ditolak (" + (error.status || "?") + "), memakai stream biasa")
					if (error.status && error.status >= 500) throw error
				}
			}
			return await run(false)
		})
	}
	attempts.push(async () => createTalksStream(sourceUrl))

	let lastError = null
	for (const attempt of attempts) {
		for (let retry = 1; retry <= 3; retry++) {
			try {
				const stream = await attempt()
				currentActiveStream = { streamId: stream.id, sessionId: stream.session_id, agentId: stream.agentId }
				stream.notes = notes
				stream.publicAudio = Boolean(cfg.publicBaseUrl)
				return stream
			} catch (error) {
				lastError = error
				const text = String(error.message || "")
				if (error.status === 403 && /Max user sessions|max.*sessions/i.test(text) && retry < 3) {
					const delayMs = retry * 2500
					console.log(`[did] sesi penuh (percobaan ${retry}/3), coba lagi dalam ${delayMs / 1000}s...`)
					await sleep(delayMs)
					continue
				}
				if (error.status === 401) throw error
				notes.push(text.slice(0, 160))
				break
			}
		}
	}
	throw lastError || new Error("D-ID stream gagal dibuat")
}

function streamPath({ streamId, agentId }, suffix = "") {
	if (!streamId) throw new Error("streamId wajib")
	return agentId ? `/agents/${agentId}/streams/${streamId}${suffix}` : `/talks/streams/${streamId}${suffix}`
}

/** Kirim SDP answer browser ke D-ID. */
export async function didStreamSdp({ streamId, agentId, answer, sessionId }) {
	return didRequest("POST", streamPath({ streamId, agentId }, "/sdp"), { answer, session_id: sessionId })
}

/** Kirim ICE candidate browser ke D-ID (candidate kosong = akhir pengumpulan). */
export async function didStreamIce({ streamId, agentId, candidate, sdpMid, sdpMLineIndex, sessionId }) {
	const body = candidate ? { candidate, sdpMid, sdpMLineIndex, session_id: sessionId } : { session_id: sessionId }
	try {
		await didRequest("POST", streamPath({ streamId, agentId }, "/ice"), body)
		return true
	} catch (error) {
		console.warn("[did] ice:", error.message)
		return false
	}
}

/**
 * Mulai bicara: audio -> D-ID. audioUrl = hasil /audios, atau ttsKey bila server punya URL publik.
 */
export async function didStreamTalk({ streamId, agentId, audioUrl, ttsKey, sessionId }) {
	const cfg = didCfg()
	let url = audioUrl
	if (!url && ttsKey && cfg.publicBaseUrl && /^[a-f0-9]{40}$/.test(ttsKey)) {
		url = `${cfg.publicBaseUrl.replace(/\/$/, "")}/tts-cache/${ttsKey}.mp3`
	}
	if (!url) throw new Error("audioUrl kosong")
	const body = { script: { type: "audio", audio_url: url }, session_id: sessionId }
	if (!agentId) body.config = { stitch: true }
	return didRequest("POST", streamPath({ streamId, agentId }), body)
}

/** Tutup sesi streaming D-ID. */
export async function didDeleteStream({ streamId, agentId, sessionId }) {
	if (!streamId) return
	try {
		await didRequest("DELETE", streamPath({ streamId, agentId }), { session_id: sessionId })
	} catch {
		/* sudah tertutup */
	}
	if (currentActiveStream && currentActiveStream.streamId === streamId) currentActiveStream = null
}

/** Upload buffer audio ke D-ID, kembalikan URL untuk dipakai di didStreamTalk. */
export async function didUploadAudio(audioBuffer, mimeType = "audio/mpeg") {
	if (audioBuffer.length > 15 * 1024 * 1024) throw new Error("Audio terlalu besar untuk D-ID (maks 15 MB)")
	const isMp3 = /mp3|mpeg/i.test(mimeType)
	const form = new FormData()
	form.append("audio", new Blob([audioBuffer], { type: isMp3 ? "audio/mpeg" : mimeType }), isMp3 ? "audio.mp3" : "audio.wav")
	return didRequest("POST", "/audios", form) // { url, id, duration? }
}

/** Status ringkas untuk /api/config & diagnosa. */
export function didPublicInfo() {
	const { avatar } = getConfig()
	return {
		ready: Boolean(avatar.did.apiKey),
		mode: avatar.did.mode,
		fluent: avatar.did.fluent,
		publicAudio: Boolean(avatar.did.publicBaseUrl),
		hasSourceUrl: Boolean(avatar.did.sourceUrl),
	}
}

/** Tutup stream aktif saat server dimatikan (best effort). */
async function didCleanup() {
	if (!currentActiveStream) return
	const s = currentActiveStream
	currentActiveStream = null
	await didDeleteStream(s)
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => {
		Promise.race([didCleanup().catch(() => {}), sleep(1500)]).finally(() => process.exit(0))
	})
}

/* -------------------------------- Simli --------------------------------- */

/** Simli: dapatkan session token untuk WebRTC streaming di browser (API key tetap di server). */
export async function simliSessionToken() {
	const { avatar } = getConfig()
	const cfg = avatar.simli || {}
	const apiKey = cfg.apiKey || process.env.SIMLI_API_KEY
	if (!apiKey) throw new Error("SIMLI_API_KEY belum diisi di .env (daftar gratis di app.simli.com)")
	const faceId = cfg.faceId || process.env.SIMLI_FACE_ID
	if (!faceId) throw new Error("SIMLI_FACE_ID belum diisi")
	const clampNum = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.max(a, Math.min(b, Number(v))) : d)
	const body = {
		faceId,
		handleSilence: true, // Simli membuat animasi diam saat tidak ada audio
		maxSessionLength: clampNum(cfg.maxSession, 60, 3600, 900),
		maxIdleTime: clampNum(cfg.maxIdle, 15, 300, 90),
		audioInputFormat: "pcm16",
	}
	const response = await fetch("https://api.simli.ai/compose/token", {
		method: "POST",
		headers: { "content-type": "application/json", "x-simli-api-key": apiKey },
		body: JSON.stringify(body),
	})
	const text = await response.text().catch(() => "")
	if (!response.ok) {
		const hint = response.status === 401 || response.status === 403 ? " (API key salah/kedaluwarsa?)" : ""
		throw new Error(`Simli token error ${response.status}${hint}: ${text.slice(0, 300)}`)
	}
	let data = {}
	try {
		data = JSON.parse(text)
	} catch {
		throw new Error("Simli mengembalikan jawaban tidak dikenal: " + text.slice(0, 200))
	}
	if (!data.session_token || /FAIL/i.test(String(data.session_token))) {
		throw new Error("Simli menolak sesi: " + (data.detail || text.slice(0, 200)) + " (cek SIMLI_FACE_ID & kuota menit)")
	}
	return {
		session_token: data.session_token,
		faceId,
		preset: Boolean(cfg.preset),
		maxSessionLength: body.maxSessionLength,
		maxIdleTime: body.maxIdleTime,
	}
}
