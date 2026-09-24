/**
 * pcm.js - konversi audio TTS (AudioBuffer / Blob) menjadi PCM16 mono 16 kHz,
 * format yang diminta layanan avatar streaming (Simli, Anam).
 */
import { audioContext } from "./audio.js"

export function floatToPcm16(float32) {
	const out = new Int16Array(float32.length)
	for (let i = 0; i < float32.length; i++) {
		const s = Math.max(-1, Math.min(1, float32[i]))
		out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
	}
	return new Uint8Array(out.buffer)
}

/** AudioBuffer (rate apa pun) -> PCM16 mono pada targetRate (default 16 kHz). */
export async function audioBufferToPcm(buffer, targetRate = 16000) {
	const frames = Math.max(1, Math.ceil(buffer.duration * targetRate))
	if (typeof OfflineAudioContext !== "undefined") {
		try {
			const offline = new OfflineAudioContext(1, frames, targetRate)
			const source = offline.createBufferSource()
			source.buffer = buffer
			source.connect(offline.destination)
			source.start(0)
			const rendered = await offline.startRendering()
			return floatToPcm16(rendered.getChannelData(0))
		} catch (error) {
			console.warn("[pcm] OfflineAudioContext gagal, pakai resampling linear:", error?.message || error)
		}
	}
	// cadangan: mono + interpolasi linear
	const ch = buffer.numberOfChannels
	const mono = new Float32Array(buffer.length)
	for (let c = 0; c < ch; c++) {
		const d = buffer.getChannelData(c)
		for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch
	}
	const ratio = buffer.sampleRate / targetRate
	const out = new Float32Array(frames)
	for (let i = 0; i < frames; i++) {
		const pos = i * ratio
		const i0 = Math.floor(pos)
		const i1 = Math.min(mono.length - 1, i0 + 1)
		const t = pos - i0
		out[i] = (mono[i0] || 0) * (1 - t) + (mono[i1] || 0) * t
	}
	return floatToPcm16(out)
}

/**
 * Sumber fleksibel -> PCM16 16 kHz:
 *  - item hasil Speaker.prepare() ({ buffer: AudioBuffer })  -> tanpa decode ulang
 *  - Blob / { blob }                                        -> decode dulu
 */
export async function toPcm16k(source, targetRate = 16000) {
	if (source && source.buffer && typeof source.buffer.getChannelData === "function") return audioBufferToPcm(source.buffer, targetRate)
	const blob = source instanceof Blob ? source : source && source.blob
	if (!blob) throw new Error("Sumber audio tidak dikenal")
	const arrayBuffer = await blob.arrayBuffer()
	const decoded = await audioContext().decodeAudioData(arrayBuffer)
	return audioBufferToPcm(decoded, targetRate)
}

/** Durasi (detik) dari panjang PCM16 mono. */
export function pcmSeconds(pcm, rate = 16000) {
	return pcm.byteLength / 2 / rate
}
