/**
 * Simli WebRTC Client.
 * Mengalirkan video avatar manusia nyata secara real-time via WebRTC,
 * disinkronkan otomatis dengan audio (Fish Audio / Edge TTS).
 */

import { SimliClient } from "./simli-bundle.js"

let client = null
let isReady = false
let audioCtx = null

export function isSimliReady() {
	return isReady
}

/**
 * Konversi audio blob (MP3/WAV) menjadi 16kHz PCM16 Uint8Array
 * sesuai format input yang diminta Simli.
 */
async function blobToPcm16(blob) {
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
	}
	if (audioCtx.state === "suspended") {
		await audioCtx.resume()
	}

	const arrayBuffer = await blob.arrayBuffer()
	const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
	
	const input = audioBuffer.getChannelData(0)
	const ratio = audioBuffer.sampleRate / 16000
	const outputLength = Math.round(input.length / ratio)
	const pcm16 = new Int16Array(outputLength)

	for (let i = 0; i < outputLength; i++) {
		const srcIdx = Math.floor(i * ratio)
		const s = Math.max(-1, Math.min(1, input[srcIdx] || 0))
		pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
	}

	return new Uint8Array(pcm16.buffer)
}

/**
 * Memulai sesi streaming Simli WebRTC.
 */
export async function startSimli({ videoEl, audioEl, onTrack, onError, onStatus }) {
	onStatus?.("Menghubungkan avatar Simli (WebRTC)...")

	try {
		// 1. Ambil session token dari server
		const res = await fetch("/api/avatar/simli/token", { method: "POST" })
		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			throw new Error(err.error || `HTTP ${res.status}`)
		}
		const { session_token } = await res.json()

		// 2. Pastikan elemen video siap & terlihat agar WebRTC frame renderer aktif
		videoEl.hidden = false
		videoEl.style.display = "block"
		videoEl.autoplay = true
		videoEl.playsInline = true
		videoEl.muted = false

		// Elemen audio internal Simli dimatikan suaranya agar tidak bentrok dengan speaker lokal
		const internalAudio = new Audio()
		internalAudio.muted = true

		// 3. Buat instance SimliClient
		client = new SimliClient(
			session_token,
			videoEl,
			internalAudio,
			[{ urls: ["stun:stun.l.google.com:19302"] }],
			undefined, // logLevel
			"livekit", // transport
			"websockets" // signaling
		)

		client.on("start", () => {
			console.log("[Simli] WebRTC Video Started")
			isReady = true
			onStatus?.("Avatar Simli siap! Siap ngobrol.")
			onTrack?.()
		})

		client.on("failed", (err) => {
			console.error("[Simli] Connection failed:", err)
			isReady = false
			onError?.(err)
		})

		client.on("disconnected", () => {
			console.warn("[Simli] Disconnected")
			isReady = false
			onStatus?.("Simli terputus.")
		})

		await client.start()
		isReady = true
		onTrack?.()
		return client
	} catch (err) {
		console.error("[Simli] Gagal start:", err)
		isReady = false
		onError?.(err)
		throw err
	}
}

/**
 * Kirimkan audio TTS ke Simli untuk digerakkan bibirnya secara real-time.
 */
export async function speakSimli(audioBlob) {
	if (!client) {
		throw new Error("Simli client belum aktif")
	}

	const pcm16Data = await blobToPcm16(audioBlob)

	// Kirim dalam chunk 3000 bytes (~93 ms audio) agar streaming halus
	const CHUNK_SIZE = 3000
	for (let offset = 0; offset < pcm16Data.length; offset += CHUNK_SIZE) {
		const chunk = pcm16Data.subarray(offset, Math.min(offset + CHUNK_SIZE, pcm16Data.length))
		client.sendAudioData(chunk)
	}
}

export function stopSimli() {
	if (client) {
		try {
			client.stop()
		} catch {}
		client = null
		isReady = false
	}
}
