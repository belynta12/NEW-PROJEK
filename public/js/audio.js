/**
 * Semua urusan audio di browser:
 *  - Recorder   : rekam mikrofon + deteksi diam (VAD) untuk mode ngobrol otomatis
 *  - Speaker    : mainkan audio balasan (WebAudio) + lipsync viseme dari teks & audio
 *  - BrowserStt : pengenalan suara gratis bawaan Chrome/Edge
 *  - browserTts : suara bawaan browser (dipakai kalau belum ada API key)
 */

import { analyzeEnvelope, buildTrack, normalizeSpeechText } from "./lipsync.js"

let sharedCtx = null
export function audioContext() {
	if (!sharedCtx) {
		const Ctx = window.AudioContext || window.webkitAudioContext
		sharedCtx = new Ctx()
	}
	if (sharedCtx.state === "suspended") sharedCtx.resume().catch(() => {})
	return sharedCtx
}

function pickMime() {
	const candidates = [
		"audio/webm;codecs=opus",
		"audio/webm",
		"audio/mp4",
		"audio/ogg;codecs=opus",
	]
	for (const type of candidates) {
		if (window.MediaRecorder?.isTypeSupported?.(type)) return type
	}
	return ""
}

export class Recorder {
	constructor({ onLevel, onSpeechEnd, silenceMs = 900, minSpeechMs = 350 } = {}) {
		this.onLevel = onLevel || (() => {})
		this.onSpeechEnd = onSpeechEnd || (() => {})
		this.silenceMs = silenceMs
		this.minSpeechMs = minSpeechMs
		this.stream = null
		this.recorder = null
		this.chunks = []
		this.recording = false
		this.autoStop = false
		this.mimeType = pickMime()
	}

	async ensureMic() {
		if (this.stream) return this.stream
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		})
		const ctx = audioContext()
		this.source = ctx.createMediaStreamSource(this.stream)
		this.analyser = ctx.createAnalyser()
		this.analyser.fftSize = 1024
		this.analyser.smoothingTimeConstant = 0.6
		this.source.connect(this.analyser)
		this.buffer = new Uint8Array(this.analyser.fftSize)
		this.monitor()
		return this.stream
	}

	monitor() {
		const tick = () => {
			if (!this.analyser) return
			this.analyser.getByteTimeDomainData(this.buffer)
			let sum = 0
			for (let i = 0; i < this.buffer.length; i++) {
				const v = (this.buffer[i] - 128) / 128
				sum += v * v
			}
			const rms = Math.sqrt(sum / this.buffer.length)
			this.level = rms
			this.onLevel(rms)

			if (this.recording && this.autoStop) {
				const now = performance.now()
				if (rms > 0.035) {
					this.lastVoice = now
					if (!this.voiceStart) this.voiceStart = now
				}
				const spoke = this.voiceStart && now - this.voiceStart > this.minSpeechMs
				const quiet = this.lastVoice && now - this.lastVoice > this.silenceMs
				if (spoke && quiet) this.stop()
				// tidak ada suara sama sekali selama 8 detik -> berhenti
				if (!this.voiceStart && now - this.startedAt > 8000) this.stop(true)
			}
			requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	}

	async start({ autoStop = false } = {}) {
		if (this.recording) return
		await this.ensureMic()
		this.chunks = []
		this.autoStop = autoStop
		this.voiceStart = 0
		this.lastVoice = 0
		this.startedAt = performance.now()
		this.recorder = new MediaRecorder(
			this.stream,
			this.mimeType ? { mimeType: this.mimeType } : undefined,
		)
		this.recorder.ondataavailable = (event) => {
			if (event.data && event.data.size) this.chunks.push(event.data)
		}
		this.recorder.onstop = () => {
			const type = this.recorder.mimeType || this.mimeType || "audio/webm"
			const blob = new Blob(this.chunks, { type })
			const spokeMs = this.lastVoice && this.voiceStart ? this.lastVoice - this.voiceStart : 0
			this.recording = false
			this.onSpeechEnd({ blob, empty: this.cancelled || blob.size < 1200 || spokeMs < 120 })
			this.cancelled = false
		}
		this.recorder.start(120)
		this.recording = true
	}

	stop(cancelled = false) {
		if (!this.recording || !this.recorder) return
		this.cancelled = cancelled
		try {
			this.recorder.stop()
		} catch {
			this.recording = false
		}
	}

	release() {
		this.stream?.getTracks().forEach((track) => track.stop())
		this.stream = null
		this.analyser = null
	}
}

/**
 * Pemutar audio balasan + lipsync.
 *
 * enqueue(item): item = hasil prepare({ blob, text }) -> diputar lewat WebAudio
 * (timing akurat sampai sampel) dan tiap frame memanggil onMouth(params) dari
 * VisemeTrack (teks + amplop audio). Bila hanya URL yang diberikan, dipakai
 * jalur lama: elemen <audio> + analyser -> onLevel(level, tone).
 */
export class Speaker {
	constructor(audioElement, { onLevel, onMouth, onStart, onEnd } = {}) {
		this.el = audioElement
		this.onLevel = onLevel || (() => {})
		this.onMouth = onMouth || (() => {})
		this.onStart = onStart || (() => {})
		this.onEnd = onEnd || (() => {})
		this.queue = []
		this.playing = false
		this.stopped = false
		this.connected = false
		this.current = null // { source, startAt, track, gain }
		this.watching = false
		// JANGAN set crossOrigin pada elemen - blob URL same-origin tidak butuh CORS
	}

	/**
	 * Siapkan satu potongan ucapan: decode audio + bangun track viseme.
	 * Boleh dipanggil lebih awal (prefetch) supaya saat giliran diputar tidak ada jeda.
	 */
	async prepare({ blob, text }) {
		const ctx = audioContext()
		const arrayBuffer = await blob.arrayBuffer()
		let buffer
		try {
			buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
		} catch (error) {
			// decode gagal (format aneh): jatuh ke elemen <audio>
			console.warn("[speaker] decode gagal, pakai <audio>:", error?.message || error)
			return { url: URL.createObjectURL(blob), text, blob }
		}
		let track = null
		try {
			const info = analyzeEnvelope(buffer.getChannelData(0), buffer.sampleRate)
			track = buildTrack(normalizeSpeechText(text || ""), { envInfo: info })
		} catch (error) {
			console.warn("[speaker] lipsync gagal:", error?.message || error)
		}
		return { buffer, track, text, blob, duration: buffer.duration }
	}

	connect() {
		if (this.connected) return
		try {
			const ctx = audioContext()
			this.analyser = ctx.createAnalyser()
			this.analyser.fftSize = 1024
			this.analyser.smoothingTimeConstant = 0.1
			this.analyser.connect(ctx.destination)
			this.timeData = new Uint8Array(this.analyser.fftSize)
			this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
			this.node = ctx.createMediaElementSource(this.el)
			this.node.connect(this.analyser)
			this.connected = true
		} catch (error) {
			console.warn("Analyser gagal:", error)
		}
	}

	/** Loop pengamat: lipsync per frame untuk item yang sedang diputar. */
	watch() {
		if (this.watching) return
		this.watching = true
		let runningMin = 0.03
		let runningMax = 0.08
		const tick = () => {
			if (!this.playing) {
				this.watching = false
				return
			}
			const cur = this.current
			if (cur && cur.track) {
				const t = audioContext().currentTime - cur.startAt
				const p = cur.track.at(t)
				this.onMouth(p)
			} else if (cur && cur.element && this.analyser && !this.el.paused && !this.el.ended) {
				// jalur lama: perkiraan dari spektrum
				this.analyser.getByteTimeDomainData(this.timeData)
				let sum = 0
				for (let i = 0; i < this.timeData.length; i++) {
					const v = (this.timeData[i] - 128) / 128
					sum += v * v
				}
				const rms = Math.sqrt(sum / this.timeData.length)
				this.analyser.getByteFrequencyData(this.freqData)
				if (rms > 0.005) {
					runningMin = Math.min(runningMin * 0.999 + rms * 0.001, rms)
					runningMax = Math.max(runningMax * 0.995 + rms * 0.005, rms)
				}
				const floor = Math.max(0.015, runningMin * 1.35)
				const range = Math.max(0.035, runningMax - floor)
				let fLow = 0
				for (let i = 4; i < 18; i++) fLow += this.freqData[i]
				fLow /= 14 * 255
				let fMid = 0
				for (let i = 24; i < 65; i++) fMid += this.freqData[i]
				fMid /= 41 * 255
				let fHigh = 0
				for (let i = 75; i < 160; i++) fHigh += this.freqData[i]
				fHigh /= 85 * 255
				let level = 0
				if (rms > floor) {
					const norm = Math.min(1, Math.max(0, (rms - floor) / range))
					level = Math.min(1, Math.pow(norm, 0.9) * 0.95)
					if (fHigh > 0.08 && fHigh > fLow * 0.9) level = Math.min(level, 0.3)
				}
				let tone = 0.5
				if (fMid > fLow * 1.05) tone = Math.min(1, 0.5 + (fMid - fLow) * 1.8)
				else if (fLow > fMid * 1.15) tone = Math.max(0, 0.5 - (fLow - fMid) * 1.5)
				this.onLevel(level, tone)
			}
			requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	}

	/** Tambahkan item (hasil prepare) atau URL ke antrean lalu mainkan berurutan. */
	enqueue(item) {
		const entry = typeof item === "string" ? { url: item } : { ...item }
		entry.done = new Promise((resolve) => (entry.resolveDone = resolve))
		this.queue.push(entry)
		if (!this.playing) this.pump()
		return entry.done
	}

	async pump() {
		this.playing = true
		this.stopped = false
		this.onStart()
		this.watch()
		while (this.queue.length && !this.stopped) {
			const entry = this.queue.shift()
			try {
				if (entry.buffer) await this.playBuffer(entry)
				else if (entry.url) await this.playElement(entry)
			} catch (error) {
				console.warn("[speaker] gagal memutar:", error)
			} finally {
				entry.resolveDone()
			}
		}
		// item yang dibuang saat stop() tetap diselesaikan supaya pemanggil tidak menggantung
		for (const entry of this.queue) entry.resolveDone()
		this.queue = []
		this.playing = false
		this.current = null
		this.onMouth(null)
		this.onLevel(0, 0.5)
		this.onEnd()
	}

	playBuffer(entry) {
		return new Promise((resolve) => {
			const ctx = audioContext()
			const source = ctx.createBufferSource()
			source.buffer = entry.buffer
			const gain = ctx.createGain()
			source.connect(gain)
			gain.connect(ctx.destination)
			const startAt = ctx.currentTime + 0.03
			let finished = false
			const finish = () => {
				if (finished) return
				finished = true
				try {
					source.disconnect()
					gain.disconnect()
				} catch {
					/* abaikan */
				}
				if (this.current && this.current.source === source) this.current = null
				resolve()
			}
			source.onended = finish
			this.current = { source, gain, startAt, track: entry.track }
			try {
				source.start(startAt)
			} catch (error) {
				console.warn("[speaker] start gagal:", error)
				finish()
				return
			}
			// pengaman bila onended tidak terpanggil
			setTimeout(finish, (entry.buffer.duration + 0.5) * 1000)
		})
	}

	playElement(entry) {
		return new Promise((resolve) => {
			this.connect()
			const ctx = audioContext()
			if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {})
			const url = entry.url
			const cleanup = () => {
				this.el.onended = null
				this.el.onerror = null
				if (url.startsWith("blob:")) URL.revokeObjectURL(url)
				if (this.current && this.current.element) this.current = null
				resolve()
			}
			this.current = { element: true, track: null }
			this.el.onended = cleanup
			this.el.onerror = cleanup
			this.el.src = url
			this.el.play().catch(cleanup)
		})
	}

	stop() {
		this.stopped = true
		for (const entry of this.queue) entry.resolveDone?.()
		this.queue = []
		const cur = this.current
		if (cur && cur.source) {
			try {
				cur.gain.gain.setTargetAtTime(0, audioContext().currentTime, 0.015)
				cur.source.stop(audioContext().currentTime + 0.05)
			} catch {
				/* sudah berhenti */
			}
		}
		try {
			this.el.pause()
			this.el.currentTime = 0
		} catch {
			/* abaikan */
		}
		stopBrowserTts()
		this.onMouth(null)
		this.onLevel(0, 0.5)
	}
}

/* ------------------------- STT bawaan browser ------------------------- */

export function browserSttSupported() {
	return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export class BrowserStt {
	constructor({ lang = "id-ID", onPartial, onFinal, onEnd, onError } = {}) {
		const Impl = window.SpeechRecognition || window.webkitSpeechRecognition
		if (!Impl) throw new Error("Browser ini tidak mendukung Web Speech API")
		this.rec = new Impl()
		this.rec.lang = lang
		this.rec.continuous = false
		this.rec.interimResults = true
		this.rec.maxAlternatives = 1
		this.finalText = ""
		this.rec.onresult = (event) => {
			let interim = ""
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i]
				if (result.isFinal) this.finalText += result[0].transcript
				else interim += result[0].transcript
			}
			if (interim) onPartial?.(interim)
		}
		this.rec.onerror = (event) => onError?.(event.error)
		this.rec.onend = () => {
			const text = this.finalText.trim()
			this.finalText = ""
			this.running = false
			if (text) onFinal?.(text)
			onEnd?.(text)
		}
	}

	start() {
		if (this.running) return
		try {
			this.rec.start()
			this.running = true
		} catch {
			/* sudah berjalan */
		}
	}

	stop() {
		try {
			this.rec.stop()
		} catch {
			/* abaikan */
		}
	}

	abort() {
		try {
			this.rec.abort()
		} catch {
			/* abaikan */
		}
		this.running = false
	}
}

/* ------------------------- TTS bawaan browser ------------------------ */

let cachedVoices = []
export function getAvailableVoices() {
	if (typeof speechSynthesis === "undefined") return []
	if (!cachedVoices.length) cachedVoices = speechSynthesis.getVoices()
	return cachedVoices
}

export function bestVoice(lang, preferMacho = true) {
	const voices = getAvailableVoices()
	if (!voices.length) return null
	const prefix = (lang || "id").slice(0, 2).toLowerCase()
	const matchingLang = voices.filter((v) => v.lang?.toLowerCase().startsWith(prefix))

	if (preferMacho) {
		// Prioritaskan suara pria / natural di bahasa yang sama (seperti Microsoft Ardi / Andika)
		const maleKeywords = ["ardi", "andika", "male", "pria", "cowok", "david", "guy", "mark", "george", "natural", "deep"]
		const maleMatch = matchingLang.find((v) => {
			const n = (v.name || "").toLowerCase()
			return maleKeywords.some((k) => n.includes(k))
		})
		if (maleMatch) return maleMatch
	}

	if (matchingLang.length > 0) return matchingLang[0]
	return voices.find((v) => v.default) || voices[0] || null
}

let voiceSettings = {
	pitch: 0.72, // Nada rendah bariton macho
	rate: 0.94, // Tempo stabil, percaya diri, berwibawa
	macho: true,
}

export function setVoiceSettings(newSettings) {
	voiceSettings = { ...voiceSettings, ...newSettings }
}

export function getVoiceSettings() {
	return { ...voiceSettings }
}

if (typeof speechSynthesis !== "undefined") {
	speechSynthesis.addEventListener?.("voiceschanged", () => {
		cachedVoices = speechSynthesis.getVoices()
	})
}

export function stopBrowserTts() {
	try {
		speechSynthesis.cancel()
	} catch {
		/* abaikan */
	}
}

/**
 * Fallback gratis: suara browser. Lipsync memakai viseme dari teks; waktu
 * disinkronkan ulang tiap kata lewat event onboundary (bila browser mendukung).
 */
export function speakWithBrowser(text, { lang = "id-ID", onLevel, onMouth, pitch, rate } = {}) {
	return new Promise((resolve) => {
		if (typeof speechSynthesis === "undefined") return resolve()
		const utterance = new SpeechSynthesisUtterance(text)
		const voice = bestVoice(lang, voiceSettings.macho)
		if (voice) utterance.voice = voice
		utterance.lang = voice?.lang || lang
		utterance.rate = typeof rate === "number" ? rate : voiceSettings.rate
		utterance.pitch = typeof pitch === "number" ? pitch : voiceSettings.pitch

		const track = buildTrack(text, { rate: utterance.rate })
		let origin = 0
		let started = false
		let raf = 0
		const animate = () => {
			if (!started) {
				raf = requestAnimationFrame(animate)
				return
			}
			const t = (performance.now() - origin) / 1000
			const p = track.at(t)
			if (onMouth) onMouth(p)
			else onLevel?.(p.jaw, 0.5 + p.wide * 0.5 - p.round * 0.5)
			raf = requestAnimationFrame(animate)
		}
		raf = requestAnimationFrame(animate)

		utterance.onstart = () => {
			started = true
			origin = performance.now()
		}
		utterance.onboundary = (event) => {
			if (event.name && event.name !== "word") return
			const t0 = track.timeOfChar(event.charIndex || 0)
			if (t0 !== null) origin = performance.now() - t0 * 1000
		}
		const done = () => {
			cancelAnimationFrame(raf)
			onMouth?.(null)
			onLevel?.(0, 0.5)
			resolve()
		}
		utterance.onend = done
		utterance.onerror = done
		speechSynthesis.speak(utterance)
	})
}
