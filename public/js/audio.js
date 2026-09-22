/**
 * Semua urusan audio di browser:
 *  - Recorder   : rekam mikrofon + deteksi diam (VAD) untuk mode ngobrol otomatis
 *  - Speaker    : mainkan audio balasan sambil mengukur amplitudo (untuk lipsync)
 *  - BrowserStt : pengenalan suara gratis bawaan Chrome/Edge
 *  - browserTts : suara bawaan browser (dipakai kalau belum ada API key)
 */

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

/** Pemutar audio balasan + pengukur amplitudo untuk lipsync. */
export class Speaker {
	constructor(audioElement, { onLevel, onStart, onEnd } = {}) {
		this.el = audioElement
		this.onLevel = onLevel || (() => {})
		this.onStart = onStart || (() => {})
		this.onEnd = onEnd || (() => {})
		this.queue = []
		this.playing = false
		this.stopped = false
		this.connected = false
		// JANGAN set crossOrigin - blob URL dari same-origin tidak butuh CORS
		// dan setting ini menyebabkan Chrome memblokir analyser (semua nilai = 128/nol)
	}

	connect() {
		if (this.connected) return
		try {
			const ctx = audioContext()
			this.node = ctx.createMediaElementSource(this.el)
			this.analyser = ctx.createAnalyser()
			this.analyser.fftSize = 1024
			this.analyser.smoothingTimeConstant = 0.1
			this.node.connect(this.analyser)
			this.analyser.connect(ctx.destination)
			this.timeData = new Uint8Array(this.analyser.fftSize)
			this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
			this.connected = true
			this.watch()
		} catch (error) {
			console.warn("Analyser gagal:", error)
		}
	}

	watch() {
		let runningMin = 0.03
		let runningMax = 0.08

		const tick = () => {
			if (this.analyser && !this.el.paused && !this.el.ended) {
				this.analyser.getByteTimeDomainData(this.timeData)
				let sum = 0
				for (let i = 0; i < this.timeData.length; i++) {
					const v = (this.timeData[i] - 128) / 128
					sum += v * v
				}
				const rms = Math.sqrt(sum / this.timeData.length)

				// Analisis spektrum frekuensi 512-bin untuk fonem & viseme
				this.analyser.getByteFrequencyData(this.freqData)

				// 1. Pelacak dinamis min & max suara bicara agar mulut bisa mengatup rapat di jeda
				if (rms > 0.005) {
					runningMin = Math.min(runningMin * 0.999 + rms * 0.001, rms)
					runningMax = Math.max(runningMax * 0.995 + rms * 0.005, rms)
				}
				const dynamicFloor = Math.max(0.015, runningMin * 1.35)
				const dynamicRange = Math.max(0.035, runningMax - dynamicFloor)

				// 2. Pita formasi vokal & konsonan
				let fLow = 0   // 180 - 750 Hz: vokal terbuka (/a/, /o/, /u/)
				for (let i = 4; i < 18; i++) fLow += this.freqData[i]
				fLow /= 14 * 255

				let fMid = 0   // 1000 - 2800 Hz: vokal depan lebar (/i/, /e/)
				for (let i = 24; i < 65; i++) fMid += this.freqData[i]
				fMid /= 41 * 255

				let fHigh = 0  // 3200 - 7000 Hz: frikatif & sibilan (/s/, /t/, /c/)
				for (let i = 75; i < 160; i++) fHigh += this.freqData[i]
				fHigh /= 85 * 255

				// 3. Tingkat bukaan mulut (level: 0.0 = mengatup total, 1.0 = vokal terbuka maksimal)
				let level = 0
				if (rms > dynamicFloor) {
					const norm = Math.min(1, Math.max(0, (rms - dynamicFloor) / dynamicRange))
					// Respon ekspresif: kurva power 0.88 agar bukaan vokal lebih leluasa dan terbuka jelas
					level = Math.min(1, Math.pow(norm, 0.88) * 1.25)

					// Jika konsonan desis/gigi (s, t, c) dominan, tahan bukaan agar gigi merapat
					if (fHigh > 0.08 && fHigh > fLow * 0.9) {
						level = Math.min(level, 0.32)
					}
				}

				// 4. Bentuk lebar bibir (tone): 0.0 = bulat /o/ /u/, 1.0 = senyum lebar /i/ /e/
				let tone = 0.5
				if (fMid > fLow * 1.05) {
					// Vokal /i/ atau /e/: bibir melebar ke samping
					tone = Math.min(1, 0.5 + (fMid - fLow) * 1.8)
				} else if (fLow > fMid * 1.15) {
					// Vokal /o/ atau /u/: bibir membulat ke tengah
					tone = Math.max(0, 0.5 - (fLow - fMid) * 1.5)
				}

				this.onLevel(level, tone)
			}
			requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	}

	/** Tambahkan potongan audio ke antrean lalu mainkan berurutan. */
	async enqueue(url) {
		this.queue.push(url)
		if (!this.playing) await this.pump()
	}

	async pump() {
		this.playing = true
		this.stopped = false
		this.onStart()
		while (this.queue.length && !this.stopped) {
			const url = this.queue.shift()
			await this.playOne(url)
		}
		this.playing = false
		this.onLevel(0, 0.5)
		this.onEnd()
	}

	playOne(url) {
		return new Promise((resolve) => {
			this.connect()
			const ctx = audioContext()
			if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {})
			const cleanup = () => {
				this.el.onended = null
				this.el.onerror = null
				if (url.startsWith("blob:")) URL.revokeObjectURL(url)
				resolve()
			}
			this.el.onended = cleanup
			this.el.onerror = cleanup
			this.el.src = url
			this.el.play().catch(cleanup)
		})
	}

	stop() {
		this.stopped = true
		this.queue = []
		try {
			this.el.pause()
			this.el.currentTime = 0
		} catch {
			/* abaikan */
		}
		stopBrowserTts()
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
	rate: 0.94,  // Tempo stabil, percaya diri, berwibawa
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
 * Fallback gratis: suara browser. Dioptimalkan untuk suara cowok macho
 * dengan pitch rendah (0.72) dan cadence berwibawa (0.94).
 */
export function speakWithBrowser(text, { lang = "id-ID", onLevel, pitch, rate } = {}) {
	return new Promise((resolve) => {
		if (typeof speechSynthesis === "undefined") return resolve()
		const utterance = new SpeechSynthesisUtterance(text)
		const voice = bestVoice(lang, voiceSettings.macho)
		if (voice) utterance.voice = voice
		utterance.lang = voice?.lang || lang

		// Gunakan nada cowok macho yang dalam dan berwibawa
		utterance.rate = typeof rate === "number" ? rate : voiceSettings.rate
		utterance.pitch = typeof pitch === "number" ? pitch : voiceSettings.pitch

		let raf = 0
		const t0 = performance.now()
		const animate = () => {
			const t = (performance.now() - t0) / 1000
			// Simulasi gerakan mulut per suku kata (vokal-konsonan bergantian)
			const syllable = 0.5 + 0.5 * Math.sin(t * 10.5)
			const accent = 0.6 + 0.4 * Math.sin(t * 2.5 + 0.8)
			const level = Math.max(0, Math.min(1, syllable * accent))
			onLevel?.(level, 0.4 + 0.28 * Math.sin(t * 4.2))
			raf = requestAnimationFrame(animate)
		}
		raf = requestAnimationFrame(animate)

		const done = () => {
			cancelAnimationFrame(raf)
			onLevel?.(0, 0.5)
			resolve()
		}
		utterance.onend = done
		utterance.onerror = done
		speechSynthesis.speak(utterance)
	})
}
