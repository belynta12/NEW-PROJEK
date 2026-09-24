/**
 * anam.js — klien Anam (real-time avatar) dalam mode AUDIO PASSTHROUGH.
 *
 * Suara TTS Anda (Fish Audio / ElevenLabs / Edge) dikirim sebagai PCM16 16 kHz ke Anam;
 * Anam merender avatar yang bibirnya sinkron dan memutar suaranya lewat stream video.
 * Server (/api/avatar/anam/token) yang memegang API key dan membuat session token.
 *
 * Anam menagih per detik sesi tersambung (termasuk saat diam), jadi sesi ditutup
 * otomatis setelah idle beberapa saat dan dibuka lagi saat pengguna bertanya.
 */

import { createClient } from "./anam-bundle.js"
import { toPcm16k, pcmSeconds } from "./pcm.js"

let client = null
let inputStream = null
let videoEl = null
let callbacks = {}
let connecting = null
let connected = false
let speaking = false
let sessionInfo = null // { avatarId, avatarModel, preset, maxIdle }
let sessionStartedAt = 0
let lastError = null
let idleTimer = 0
let idleSeconds = 90
let generation = 0

export function isAnamReady() {
	return connected && Boolean(client)
}

export function getAnamState() {
	return {
		connected,
		speaking,
		avatarId: sessionInfo ? sessionInfo.avatarId : null,
		preset: Boolean(sessionInfo && sessionInfo.preset),
		sessionSeconds: connected && sessionStartedAt ? Math.round((performance.now() - sessionStartedAt) / 1000) : 0,
		lastError,
	}
}

function emitStatus(message) {
	console.log("[anam]", message)
	callbacks.onStatus?.(message)
}

/** Panggil setelah interaksi pengguna supaya autoplay audio tidak diblokir. */
export function resumeAnamAudio() {
	if (!videoEl) return
	try {
		videoEl.muted = false
		videoEl.play().catch(() => {})
	} catch {
		/* abaikan */
	}
}

function clearIdle() {
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = 0
}

function scheduleIdle() {
	clearIdle()
	if (!connected || idleSeconds <= 0) return
	idleTimer = setTimeout(() => {
		if (!connected || speaking) return
		emitStatus(`Diam ${idleSeconds} detik -> sesi Anam ditutup untuk hemat kuota (tersambung lagi saat bertanya).`)
		stopAnam("idle")
	}, idleSeconds * 1000)
}

/**
 * Memulai sesi Anam. Aman dipanggil berulang.
 * @param {{videoEl?:HTMLVideoElement,onTrack?:Function,onError?:Function,onStatus?:Function,onDisconnected?:Function}} options
 */
export async function startAnam(options = {}) {
	if (options.videoEl) videoEl = options.videoEl
	callbacks = {
		onTrack: options.onTrack || callbacks.onTrack,
		onError: options.onError || callbacks.onError,
		onStatus: options.onStatus || callbacks.onStatus,
		onDisconnected: options.onDisconnected || callbacks.onDisconnected,
	}
	if (connecting) return connecting
	if (isAnamReady()) return client
	connecting = connect()
		.catch((error) => {
			lastError = error.message || String(error)
			callbacks.onError?.(error)
			throw error
		})
		.finally(() => {
			connecting = null
		})
	return connecting
}

async function connect() {
	await teardown()
	const gen = ++generation
	emitStatus("Menghubungkan avatar Anam...")
	const t0 = performance.now()

	// 1. Session token dari server (API key tetap di server; passthrough audio diaktifkan)
	const res = await fetch("/api/avatar/anam/token", { method: "POST" })
	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new Error(err.error || `HTTP ${res.status}`)
	}
	const data = await res.json()
	sessionInfo = { avatarId: data.avatarId, avatarModel: data.avatarModel, preset: Boolean(data.preset), maxIdle: data.maxIdle }
	idleSeconds = Number(data.maxIdle) > 0 ? Number(data.maxIdle) : 90

	if (!videoEl) throw new Error("Elemen video belum ada")
	if (!videoEl.id) videoEl.id = "avatarVideo"
	videoEl.hidden = false
	videoEl.autoplay = true
	videoEl.playsInline = true
	videoEl.setAttribute("playsinline", "")
	// mulai dalam keadaan bisu supaya autoplay tidak diblokir; dibunyikan saat bicara (setelah interaksi)
	videoEl.muted = true

	// 2. Klien Anam tanpa mikrofon (STT kita sendiri) -> hanya render avatar + suara kita
	const c = createClient(data.sessionToken, { disableInputAudio: true })
	client = c
	const on = (event, fn) => {
		try {
			c.addListener(event, (...args) => {
				if (client === c) fn(...args)
			})
		} catch {
			/* event tidak dikenal versi SDK ini */
		}
	}
	on("CONNECTION_ESTABLISHED", () => {
		connected = true
		emitStatus("Koneksi Anam terbentuk")
	})
	on("SESSION_READY", () => {
		connected = true
	})
	on("VIDEO_PLAY_STARTED", () => {
		emitStatus(`Video Anam tampil (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
		callbacks.onTrack?.(getAnamState())
	})
	on("CONNECTION_CLOSED", (reason) => handleDisconnect(reason ? String(reason) : "koneksi ditutup"))
	on("SERVER_WARNING", (message) => emitStatus("Peringatan Anam: " + (message && message.message ? message.message : JSON.stringify(message)).slice(0, 200)))
	on("TALK_STREAM_INTERRUPTED", () => {
		speaking = false
	})

	await c.streamToVideoElement(videoEl.id)
	if (client !== c || gen !== generation) throw new Error("Sesi Anam dibatalkan")
	connected = true
	sessionStartedAt = performance.now()
	lastError = null
	inputStream = c.createAgentAudioInputStream({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 })
	scheduleIdle()
	emitStatus(`Anam tersambung dalam ${((performance.now() - t0) / 1000).toFixed(1)} s (avatar ${sessionInfo.avatarId})`)
	// bila event VIDEO_PLAY_STARTED tidak datang, tetap beri tahu aplikasi
	setTimeout(() => {
		if (client === c && connected) callbacks.onTrack?.(getAnamState())
	}, 1200)
	return c
}

function handleDisconnect(reason) {
	if (!client && !connected) return
	const wasConnected = connected
	connected = false
	speaking = false
	clearIdle()
	client = null
	inputStream = null
	if (wasConnected) {
		emitStatus("Anam terputus: " + reason)
		callbacks.onDisconnected?.(reason)
	}
}

async function teardown() {
	const c = client
	client = null
	inputStream = null
	connected = false
	speaking = false
	clearIdle()
	if (c) {
		try {
			await c.stopStreaming()
		} catch {
			/* abaikan */
		}
	}
}

/**
 * Ucapkan audio TTS lewat avatar Anam, lalu tunggu selesai (berdasarkan durasi audio).
 * @param {{buffer?:AudioBuffer, blob?:Blob}|Blob} source  item hasil Speaker.prepare() atau Blob
 * @param {{duration?:number}} opts
 */
export async function speakAnam(source, opts = {}) {
	if (!isAnamReady()) {
		emitStatus("Menyambung ulang sebelum bicara...")
		await startAnam({})
	}
	resumeAnamAudio()
	const pcm = await toPcm16k(source)
	const seconds = Number(opts.duration) || pcmSeconds(pcm)
	if (!isAnamReady() || !inputStream) throw new Error("Anam belum tersambung")
	clearIdle()
	speaking = true
	const CHUNK = 6400 // 200 ms audio
	for (let offset = 0; offset < pcm.byteLength; offset += CHUNK) {
		inputStream.sendAudioChunk(pcm.subarray(offset, Math.min(offset + CHUNK, pcm.byteLength)))
	}
	inputStream.endSequence()
	// Anam memutar audio secara real-time; tunggu durasinya + jeda kecil untuk latensi jaringan
	await new Promise((resolve) => setTimeout(resolve, Math.max(150, seconds * 1000 + 450)))
	speaking = false
	scheduleIdle()
	return { seconds }
}

/** Hentikan ucapan yang sedang berjalan. */
export function clearAnam() {
	if (client) {
		try {
			client.interruptPersona()
		} catch {
			/* abaikan */
		}
	}
	if (inputStream) {
		try {
			inputStream.endSequence()
		} catch {
			/* abaikan */
		}
	}
	speaking = false
	scheduleIdle()
}

export async function stopAnam(reason = "dihentikan") {
	const wasConnected = connected
	await teardown()
	if (videoEl) videoEl.hidden = true
	if (wasConnected) callbacks.onDisconnected?.(reason)
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => {
		if (client) {
			try {
				client.stopStreaming()
			} catch {
				/* abaikan */
			}
		}
	})
}
