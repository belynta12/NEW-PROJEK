/**
 * Simli WebRTC Client (simli-client 3.x, dibundel di simli-bundle.js).
 *
 * Mengalirkan video avatar Simli secara real-time via WebRTC (transport livekit).
 * Audio TTS (Fish Audio / ElevenLabs / Edge) dikirim sebagai PCM16 16 kHz mono;
 * SUARA DIPUTAR OLEH SIMLI (ikut di stream video) supaya bibir dan suara selalu
 * sinkron - bukan diputar lokal (yang membuat suara mendahului gambar).
 *
 * Fitur: sambung ulang otomatis saat sesi berakhir (idle timeout), event
 * speaking/silent untuk menunggu ucapan selesai, ClearBuffer untuk interupsi,
 * resampling berkualitas lewat OfflineAudioContext.
 */

import { SimliClient } from "./simli-bundle.js"
import { toPcm16k } from "./pcm.js"

let client = null
let videoEl = null
let audioEl = null
let callbacks = {}
let connecting = null
let connected = false
let speaking = false
let sessionInfo = null // { faceId, maxIdleTime, maxSessionLength, model }
let sessionStartedAt = 0
let lastError = null
let silentWaiters = []

export function isSimliReady() {
	return connected && Boolean(client)
}

export function getSimliState() {
	return {
		connected,
		speaking,
		faceId: sessionInfo ? sessionInfo.faceId : null,
		model: sessionInfo ? sessionInfo.model : null,
		sessionSeconds: sessionStartedAt ? Math.round((performance.now() - sessionStartedAt) / 1000) : 0,
		lastError,
	}
}

function emitStatus(message) {
	console.log("[simli]", message)
	callbacks.onStatus?.(message)
}

function ensureAudioElement() {
	if (audioEl) return audioEl
	audioEl = document.createElement("audio")
	audioEl.autoplay = true
	audioEl.playsInline = true
	audioEl.setAttribute("playsinline", "")
	audioEl.style.display = "none"
	document.body.appendChild(audioEl)
	return audioEl
}

/** Panggil setelah interaksi pengguna supaya autoplay audio tidak diblokir. */
export function resumeSimliAudio() {
	try {
		if (audioEl) {
			audioEl.muted = false
			audioEl.play().catch(() => {})
		}
		if (videoEl) videoEl.play().catch(() => {})
	} catch {
		/* abaikan */
	}
}

/**
 * Memulai sesi streaming Simli WebRTC. Aman dipanggil berulang.
 * @param {{videoEl?:HTMLVideoElement,onTrack?:Function,onError?:Function,onStatus?:Function,onDisconnected?:Function,onSpeaking?:Function}} options
 */
export async function startSimli(options = {}) {
	if (options.videoEl) videoEl = options.videoEl
	callbacks = {
		onTrack: options.onTrack || callbacks.onTrack,
		onError: options.onError || callbacks.onError,
		onStatus: options.onStatus || callbacks.onStatus,
		onDisconnected: options.onDisconnected || callbacks.onDisconnected,
		onSpeaking: options.onSpeaking || callbacks.onSpeaking,
	}
	if (connecting) return connecting
	if (isSimliReady()) return client
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
	await teardown(false)
	emitStatus("Menghubungkan avatar Simli (WebRTC)...")
	const t0 = performance.now()

	// 1. Ambil session token dari server (API key tetap di server)
	const res = await fetch("/api/avatar/simli/token", { method: "POST" })
	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new Error(err.error || `HTTP ${res.status}`)
	}
	const data = await res.json()
	sessionInfo = { faceId: data.faceId, maxIdleTime: data.maxIdleTime, maxSessionLength: data.maxSessionLength, model: data.model || null }

	// 2. Elemen video (gambar) + audio (suara dari Simli). Video dibisukan agar tidak dobel.
	if (!videoEl) throw new Error("Elemen video belum ada")
	videoEl.hidden = false
	videoEl.autoplay = true
	videoEl.playsInline = true
	videoEl.muted = true
	const audio = ensureAudioElement()
	audio.muted = false

	// 3. Buat SimliClient (transport livekit: tidak butuh ICE server sendiri)
	const c = new SimliClient(data.session_token, videoEl, audio, null, undefined, "livekit", "websockets")
	client = c
	const guard = (fn) => (...args) => {
		if (client === c) fn(...args)
	}
	const safeOn = (event, fn) => {
		try {
			c.on(event, guard(fn))
		} catch {
			/* nama event tidak dikenal versi ini */
		}
	}
	safeOn("start", () => {
		connected = true
		emitStatus("Video Simli mulai")
	})
	safeOn("connected", () => {
		connected = true
	})
	safeOn("stop", () => handleDisconnect("sesi ditutup server (idle/limit)"))
	safeOn("disconnected", () => handleDisconnect("terputus"))
	safeOn("failed", (detail) => handleDisconnect("gagal: " + (detail || "")))
	safeOn("error", (detail) => {
		lastError = String(detail || "error")
		emitStatus("Error: " + lastError)
		if (!connected) handleDisconnect("error saat menyambung")
	})
	safeOn("startup_error", (message) => {
		lastError = String(message || "startup error")
		handleDisconnect("startup error: " + lastError)
	})
	safeOn("speaking", () => {
		speaking = true
		callbacks.onSpeaking?.(true)
	})
	safeOn("silent", () => {
		speaking = false
		callbacks.onSpeaking?.(false)
		const waiters = silentWaiters
		silentWaiters = []
		for (const w of waiters) w()
	})

	await c.start()
	if (client !== c) throw new Error("Sesi Simli dibatalkan")
	connected = true
	sessionStartedAt = performance.now()
	lastError = null
	emitStatus(`Simli tersambung dalam ${((performance.now() - t0) / 1000).toFixed(1)} s (wajah ${sessionInfo.faceId})`)
	callbacks.onTrack?.(getSimliState())
	return c
}

function handleDisconnect(reason) {
	if (!connected && !client) return
	connected = false
	speaking = false
	const waiters = silentWaiters
	silentWaiters = []
	for (const w of waiters) w()
	emitStatus("Simli terputus: " + reason)
	callbacks.onDisconnected?.(reason)
}

async function teardown(notify) {
	const c = client
	client = null
	connected = false
	speaking = false
	const waiters = silentWaiters
	silentWaiters = []
	for (const w of waiters) w()
	if (c) {
		try {
			await c.stop()
		} catch {
			/* abaikan */
		}
	}
	if (notify) callbacks.onDisconnected?.("dihentikan")
}

/* ------------------------------- bicara -------------------------------- */

function waitSpeechEnd(seconds) {
	const t0 = performance.now()
	const minMs = Math.max(200, seconds * 850)
	const maxMs = (seconds + 2.5) * 1000
	return new Promise((resolve) => {
		let done = false
		const finish = () => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve()
		}
		const timer = setTimeout(finish, maxMs)
		const onSilent = () => {
			// "silent" terlalu awal (dari ucapan sebelumnya) diabaikan
			if (performance.now() - t0 >= minMs) finish()
			else silentWaiters.push(onSilent)
		}
		silentWaiters.push(onSilent)
	})
}

/**
 * Kirim audio TTS ke Simli (bibir bergerak + suara diputar Simli), lalu tunggu selesai.
 * @param {{buffer?:AudioBuffer, blob?:Blob}|Blob} source  item hasil Speaker.prepare() atau Blob
 * @param {{duration?:number}} opts
 */
export async function speakSimli(source, opts = {}) {
	if (!isSimliReady()) {
		emitStatus("Menyambung ulang sebelum bicara...")
		await startSimli({})
	}
	resumeSimliAudio()
	const pcm = await toPcm16k(source)
	const seconds = Number(opts.duration) || pcm.byteLength / 2 / 16000
	if (!isSimliReady()) throw new Error("Simli belum tersambung")
	// kirim dalam potongan ~187 ms (6000 byte) - Simli menyangga dan memutar berurutan
	const CHUNK = 6000
	for (let offset = 0; offset < pcm.byteLength; offset += CHUNK) {
		client.sendAudioData(pcm.subarray(offset, Math.min(offset + CHUNK, pcm.byteLength)))
	}
	await waitSpeechEnd(seconds)
	return { seconds }
}

/** Hentikan ucapan yang sedang berjalan (kosongkan buffer audio Simli). */
export function clearSimli() {
	if (client) {
		try {
			client.ClearBuffer()
		} catch {
			/* abaikan */
		}
	}
	speaking = false
	const waiters = silentWaiters
	silentWaiters = []
	for (const w of waiters) w()
}

export async function stopSimli() {
	await teardown(true)
	if (videoEl) videoEl.hidden = true
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => {
		if (client) {
			try {
				client.stop()
			} catch {
				/* abaikan */
			}
		}
	})
}
