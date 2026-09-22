import { PhotoPuppet } from "./puppet.js"
import {
	Recorder,
	Speaker,
	BrowserStt,
	browserSttSupported,
	speakWithBrowser,
	stopBrowserTts,
	audioContext,
	setVoiceSettings,
} from "./audio.js"
import { configureVision, detectFace, readFaceCache, writeFaceCache, clearFaceCache, pointsFromArrays } from "./face-detect.js"

/* ------------------------------- elemen ------------------------------- */
const $ = (id) => document.getElementById(id)
const el = {
	canvas: $("avatarCanvas"),
	video: $("avatarVideo"),
	stage: $("stage"),
	stageEmpty: $("stageEmpty"),
	stateBadge: $("stateBadge"),
	stateText: $("stateText"),
	caption: $("caption"),
	statusPill: $("statusPill"),
	personaName: $("personaName"),
	micBtn: $("micBtn"),
	micLabel: $("micLabel"),
	handsFree: $("handsFree"),
	stopBtn: $("stopBtn"),
	chat: $("chat"),
	composer: $("composer"),
	textInput: $("textInput"),
	clearBtn: $("clearBtn"),
	drawer: $("drawer"),
	scrim: $("scrim"),
	settingsBtn: $("settingsBtn"),
	closeDrawer: $("closeDrawer"),
	photoInput: $("photoInput"),
	pickPhoto: $("pickPhoto"),
	useSample: $("useSample"),
	emptyUploadBtn: $("emptyUploadBtn"),
	calibrateBtn: $("calibrateBtn"),
	detectBtn: $("detectBtn"),
	calibHint: $("calibHint"),
	calibOverlay: $("calibOverlay"),
	calibStep: $("calibStep"),
	calibCancel: $("calibCancel"),
	bodyMotion: $("bodyMotion"),
	lipGain: $("lipGain"),
	voiceInput: $("voiceInput"),
	pickVoice: $("pickVoice"),
	voiceResult: $("voiceResult"),
	voicePreset: $("voicePreset"),
	voicePitch: $("voicePitch"),
	voiceRate: $("voiceRate"),
	statusList: $("statusList"),
	player: $("player"),
}

const STORE = { photo: "aal.photo", rig: "aal.rig.v2", tuning: "aal.tuning.v2", voice: "aal.voice" }
const SAMPLE_PHOTO = "assets/avatar.jpg"
const SAMPLE_LANDMARKS = "assets/avatar.landmarks.json"

/* -------------------------------- state ------------------------------- */
let config = {
	persona: { name: "Avatar AI Lifetime", language: "Bahasa Indonesia" },
	avatarMode: "puppet",
	llm: { ready: false, label: "-", model: "-" },
	stt: { provider: "browser", ready: true, label: "Browser", language: "id" },
	tts: { provider: "browser", ready: true, label: "Browser" },
}
let serverOnline = false
let history = []
let busy = false
let handsFree = false
let calibrating = null
let turnId = 0
let currentPhotoSrc = ""
let faceState = { status: "none", label: "Belum ada foto" } // none | detecting | auto | manual | failed
let faceJob = 0

const puppet = new PhotoPuppet(el.canvas)
const speaker = new Speaker(el.player, {
	onLevel: (level, tone) => puppet.setLevel(level, tone),
	onMouth: (m) => puppet.setMouth(m),
})
let recorder = null
let browserStt = null
let didModule = null
let simliModule = null

/* ------------------------------- utilitas ----------------------------- */
const STATE_LABEL = {
	idle: "Siap",
	listening: "Mendengarkan...",
	thinking: "Berpikir...",
	speaking: "Bicara",
}

function setState(state, label) {
	el.stateBadge.dataset.state = state
	el.stateText.textContent = label || STATE_LABEL[state] || state
	puppet.setState(state)
}

function addMessage(role, text) {
	const node = document.createElement("div")
	node.className = "msg " + role
	node.textContent = text
	el.chat.appendChild(node)
	el.chat.scrollTop = el.chat.scrollHeight
	return node
}

function showCaption(text) {
	el.caption.textContent = text || ""
	el.caption.classList.toggle("show", Boolean(text))
}

function setPill(text, tone) {
	el.statusPill.textContent = text
	el.statusPill.className = "pill " + (tone || "")
}

function sttLang() {
	const base = (config.stt && config.stt.language) || "id"
	return base.includes("-") ? base : base + "-" + base.toUpperCase()
}

function readJson(key) {
	try {
		return JSON.parse(localStorage.getItem(key) || "null")
	} catch {
		return null
	}
}

function writeJson(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value))
	} catch {
		/* penuh - abaikan */
	}
}

/* ------------------------------ konfigurasi --------------------------- */
async function loadConfig() {
	try {
		const response = await fetch("/api/config", { cache: "no-store" })
		if (!response.ok) throw new Error("gagal")
		config = await response.json()
		serverOnline = true
	} catch {
		serverOnline = false
	}
	if (config.vision) configureVision(config.vision)

	el.personaName.textContent = config.persona.name || "Avatar AI Lifetime"
	document.title = el.personaName.textContent + " - Avatar AI"

	if (!serverOnline) setPill("Server tidak terhubung", "warn")
	else if (config.llm.online === false) setPill("Mode demo (API key LLM kosong)", "warn")
	else setPill(config.llm.label + " + " + config.tts.label.split(" (")[0], "ok")

	renderStatus()
}

function renderStatus() {
	const mark = (ok) => (ok ? '<span class="good">siap</span>' : '<span class="bad">belum diisi</span>')
	const faceMark =
		faceState.status === "auto"
			? '<span class="good">' + faceState.label + "</span>"
			: faceState.status === "manual"
				? '<span class="good">' + faceState.label + "</span>"
				: faceState.status === "detecting"
					? "<span>" + faceState.label + "</span>"
					: '<span class="bad">' + faceState.label + "</span>"
	const rows = [
		["Server", serverOnline ? '<span class="good">terhubung</span>' : '<span class="bad">mati</span>'],
		["Otak (LLM)", config.llm.label + " " + mark(config.llm.online !== false)],
		["Dengar (STT)", config.stt.label + " " + mark(config.stt.ready)],
		["Suara (TTS)", config.tts.label + " " + mark(config.tts.ready)],
		["Avatar", avatarStatusLabel()],
		["Wajah", faceMark],
	]
	el.statusList.innerHTML = rows.map((row) => "<li><b>" + row[0] + "</b><span>" + row[1] + "</span></li>").join("")
}

function setFaceState(status, label) {
	faceState = { status, label }
	if (el.calibHint) el.calibHint.textContent = label
	renderStatus()
}

/* --------------------------------- foto -------------------------------- */
async function applyPhoto(src, options) {
	const save = !options || options.save !== false
	const fresh = Boolean(options && options.fresh)
	await puppet.setImage(src)
	currentPhotoSrc = src
	applyTuning()
	el.stageEmpty.hidden = true
	puppet.start()
	if (save) {
		try {
			localStorage.setItem(STORE.photo, src)
		} catch {
			/* foto terlalu besar untuk localStorage - tidak masalah */
		}
	}
	await setupFace(src, { fresh })
	if (config.avatarMode === "did" && didModule && !(options && options.skipDid)) {
		// foto berganti -> sesi D-ID dibuat ulang dengan foto baru
		didModule.restartDid({ photoUrl: src }).catch((error) => addMessage("err", "D-ID: " + error.message))
	}
}

/** Siapkan rig wajah: landmark bawaan -> cache -> kalibrasi manual tersimpan -> deteksi otomatis. */
async function setupFace(src, { fresh = false, force = false } = {}) {
	const job = ++faceJob
	const alive = () => job === faceJob && currentPhotoSrc === src
	setFaceState("detecting", "Menyiapkan wajah...")

	const savedRig = readJson(STORE.rig)
	if (!force && savedRig && savedRig.src === src && savedRig.template && savedRig.preferManual) {
		try {
			puppet.setTemplateRig(savedRig.template)
			setFaceState("manual", "Kalibrasi manual aktif")
			return
		} catch (error) {
			console.warn("rig manual rusak:", error)
		}
	}

	if (!force && src === SAMPLE_PHOTO) {
		try {
			const response = await fetch(SAMPLE_LANDMARKS, { cache: "force-cache" })
			if (response.ok) {
				const data = await response.json()
				if (!alive()) return
				puppet.setLandmarks(pointsFromArrays(data.points))
				setFaceState("auto", "Wajah terdeteksi otomatis (478 titik)")
				return
			}
		} catch {
			/* lanjut ke deteksi */
		}
	}

	if (!force) {
		const cached = readFaceCache(src)
		if (cached) {
			try {
				puppet.setLandmarks(pointsFromArrays(cached.points))
				setFaceState("auto", "Wajah terdeteksi otomatis (478 titik)")
				return
			} catch (error) {
				console.warn("cache wajah rusak:", error)
			}
		}
	}

	try {
		const points = await detectFace(puppet.image, {
			onStatus: (msg) => {
				if (alive()) setFaceState("detecting", msg)
			},
		})
		if (!alive()) return
		puppet.setLandmarks(points)
		writeFaceCache(src, { points, W: puppet.image.naturalWidth, H: puppet.image.naturalHeight })
		setFaceState("auto", "Wajah terdeteksi otomatis (478 titik)")
		if (fresh) addMessage("sys", "Wajah terdeteksi otomatis. Avatar siap.")
	} catch (error) {
		if (!alive()) return
		console.warn("[face]", error)
		const savedTemplate = savedRig && savedRig.src === src && savedRig.template
		if (savedTemplate) {
			try {
				puppet.setTemplateRig(savedTemplate)
				setFaceState("manual", "Kalibrasi manual aktif")
				return
			} catch {
				/* lanjut */
			}
		}
		setFaceState("failed", "Wajah tidak terdeteksi otomatis. Klik Kalibrasi manual.")
		addMessage("err", error.message + " Anda bisa menandai mulut dan mata secara manual.")
		if (fresh) startCalibration()
	}
}

function fileToDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(reader.result)
		reader.onerror = () => reject(new Error("Gagal membaca file"))
		reader.readAsDataURL(file)
	})
}

async function uploadPhoto(file) {
	if (serverOnline) {
		try {
			const response = await fetch("/api/upload/photo", {
				method: "POST",
				headers: { "content-type": file.type || "image/png" },
				body: file,
			})
			if (response.ok) {
				const data = await response.json()
				await applyPhoto(data.url, { fresh: true })
				return
			}
		} catch {
			/* jatuh ke data URL di bawah */
		}
	}
	await applyPhoto(await fileToDataUrl(file), { fresh: true })
}

/* ------------------------------ kalibrasi ------------------------------ */
const CALIB_STEPS = [
	{ key: "mouth", text: "Klik tengah MULUT (garis pertemuan bibir)" },
	{ key: "eyeL", text: "Klik pupil mata KIRI (sebelah kiri layar)" },
	{ key: "eyeR", text: "Klik pupil mata KANAN (sebelah kanan layar)" },
]

function startCalibration() {
	if (!puppet.image) return
	calibrating = { index: 0, picks: {} }
	el.calibOverlay.hidden = false
	el.stage.classList.add("calibrating")
	el.calibStep.textContent = CALIB_STEPS[0].text
	puppet.showGuides = true
	closeDrawer()
}

function endCalibration(apply) {
	if (apply && calibrating) {
		const picks = calibrating.picks
		try {
			const template = { eyeLeftScreen: picks.eyeL, eyeRightScreen: picks.eyeR, mouth: picks.mouth }
			puppet.setTemplateRig(template)
			writeJson(STORE.rig, { src: currentPhotoSrc, template, preferManual: true })
			setFaceState("manual", "Kalibrasi manual aktif")
			addMessage("sys", "Kalibrasi tersimpan. Untuk hasil paling natural, gunakan foto yang wajahnya terdeteksi otomatis.")
		} catch (error) {
			addMessage("err", "Kalibrasi gagal: " + error.message)
		}
	}
	calibrating = null
	el.calibOverlay.hidden = true
	el.stage.classList.remove("calibrating")
	puppet.showGuides = false
}

el.canvas.addEventListener("click", (event) => {
	if (!calibrating) return
	const point = puppet.clientToImage(event.clientX, event.clientY)
	calibrating.picks[CALIB_STEPS[calibrating.index].key] = point
	calibrating.index += 1
	if (calibrating.index >= CALIB_STEPS.length) endCalibration(true)
	else el.calibStep.textContent = CALIB_STEPS[calibrating.index].text
})

async function redetectFace() {
	if (!puppet.image || !currentPhotoSrc) return
	clearFaceCache(currentPhotoSrc)
	const savedRig = readJson(STORE.rig)
	if (savedRig && savedRig.src === currentPhotoSrc) writeJson(STORE.rig, { ...savedRig, preferManual: false })
	closeDrawer()
	await setupFace(currentPhotoSrc, { force: true })
}

/* -------------------------- slider penyetelan ------------------------- */
function applyTuning() {
	const tuning = readJson(STORE.tuning) || {}
	const body = tuning.bodyMotion === undefined ? 100 : tuning.bodyMotion
	const lip = tuning.lipGain === undefined ? 100 : tuning.lipGain
	puppet.bodyMotion = body / 100
	puppet.lipGain = lip / 100
	el.bodyMotion.value = body
	el.lipGain.value = lip

	const voice = readJson(STORE.voice) || {}
	const pitch = voice.pitch !== undefined ? voice.pitch : 72
	const rate = voice.rate !== undefined ? voice.rate : 94
	const preset = voice.preset || "macho"
	if (el.voicePitch) el.voicePitch.value = pitch
	if (el.voiceRate) el.voiceRate.value = rate
	if (el.voicePreset) el.voicePreset.value = preset
	setVoiceSettings({ pitch: pitch / 100, rate: rate / 100, macho: preset !== "normal" })
}

function saveTuning() {
	writeJson(STORE.tuning, { bodyMotion: Number(el.bodyMotion.value), lipGain: Number(el.lipGain.value) })
}

function saveVoiceSettings() {
	if (!el.voicePitch) return
	const pitch = Number(el.voicePitch.value)
	const rate = Number(el.voiceRate.value)
	const preset = el.voicePreset ? el.voicePreset.value : "macho"
	setVoiceSettings({ pitch: pitch / 100, rate: rate / 100, macho: preset !== "normal" })
	writeJson(STORE.voice, { pitch, rate, preset })
}

el.bodyMotion.addEventListener("input", () => {
	puppet.bodyMotion = Number(el.bodyMotion.value) / 100
	saveTuning()
})
el.lipGain.addEventListener("input", () => {
	puppet.lipGain = Number(el.lipGain.value) / 100
	saveTuning()
})
el.voicePitch?.addEventListener("input", saveVoiceSettings)
el.voiceRate?.addEventListener("input", saveVoiceSettings)
el.voicePreset?.addEventListener("change", () => {
	const preset = el.voicePreset.value
	if (preset === "macho") {
		el.voicePitch.value = 72
		el.voiceRate.value = 94
	} else if (preset === "bass") {
		el.voicePitch.value = 58
		el.voiceRate.value = 90
	} else {
		el.voicePitch.value = 100
		el.voiceRate.value = 100
	}
	saveVoiceSettings()
})

/* --------------------------- pipeline bicara -------------------------- */
function extractSentences(text, isFinal) {
	if (!text) return []
	const result = []
	let current = ""
	const wordsCount = (s) => (s.trim().match(/\S+/g) || []).length

	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		current += ch

		const isMajorEnd = ch === "." || ch === "!" || ch === "?" || ch === "\n"
		// Khusus chunk awal: pecah lebih dini pada koma (>= 3 kata) atau setelah 7 kata
		// agar TTS memproses audio secara instan (memangkas delay respons)
		const isMinorEnd =
			result.length === 0 &&
			(((ch === "," || ch === ";" || ch === ":") && wordsCount(current) >= 3) ||
				(wordsCount(current) >= 7 && /\s/.test(ch)))

		if (isMajorEnd || isMinorEnd) {
			const nextCh = text[i + 1]
			if (!nextCh || /\s/.test(nextCh)) {
				const trimmed = current.trim()
				if (trimmed.length > 0) {
					result.push(trimmed)
					current = ""
				}
			}
		}
	}
	if (isFinal && current.trim().length > 0) {
		result.push(current.trim())
	}
	return result
}

function cleanForSpeech(text) {
	return text
		.replace(/[*_`#>]/g, "")
		.replace(/\s+/g, " ")
		.trim()
}

async function fetchTtsBlob(text) {
	const response = await fetch("/api/tts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	})
	if (!response.ok) {
		const detail = await response.json().catch(() => ({}))
		throw new Error(detail.error || "TTS gagal (" + response.status + ")")
	}
	return { blob: await response.blob(), key: response.headers.get("x-tts-key") || "" }
}

const browserSpeak = (text) => speakWithBrowser(text, { lang: sttLang(), onMouth: (m) => puppet.setMouth(m) })

/** Antrean kalimat: kalimat pertama diucapkan sementara sisanya masih dibuat. */
function createSpeechQueue(myTurn) {
	let chain = Promise.resolve()
	const useServerTts = serverOnline && config.tts.provider !== "browser" && config.tts.ready
	const isDid = Boolean(config.avatarMode === "did" && didModule)
	const isSimli = Boolean(config.avatarMode === "simli" && simliModule && simliModule.isSimliReady())

	const push = (sentence) => {
		const text = cleanForSpeech(sentence)
		if (!text) return
		// unduh audio + siapkan lipsync lebih awal (sambil kalimat sebelumnya masih diputar)
		const prefetch = useServerTts
			? fetchTtsBlob(text)
					.then(async ({ blob, key }) => {
						const item = await speaker.prepare({ blob, text })
						item.key = key
						if (isDid && !(config.did && config.did.publicAudio && key)) {
							// unggah ke D-ID lebih awal supaya saat giliran bicara cukup satu panggilan
							item.didAudioUrl = await didModule.prepareDidAudio(blob).catch(() => null)
						}
						return item
					})
					.catch((error) => error)
			: null

		chain = chain.then(async () => {
			if (turnId !== myTurn) return
			setState("speaking")
			showCaption(text)
			try {
				if (prefetch) {
					const item = await prefetch
					if (item instanceof Error) throw item
					if (turnId !== myTurn) return
					if (isSimli) {
						await Promise.all([
							speaker.enqueue(item),
							simliModule.speakSimli(item.blob).catch((err) => console.warn("[simli] speak error:", err.message)),
						])
					} else if (isDid) {
						try {
							const state = didModule.getDidState()
							if (state.fluent && state.connected) showDidVideo(true)
							const result = await didModule.speakDid(item.blob, {
								text,
								duration: item.duration,
								ttsKey: item.key,
								audioUrl: item.didAudioUrl,
							})
							if (result && result.latencyMs) console.log("[did] mulai bicara setelah", result.latencyMs, "ms")
							renderStatus()
						} catch (didErr) {
							console.warn("[did] gagal bicara, fallback ke audio:", didErr.message)
							addMessage("err", "D-ID (" + didErr.message + ") -> memutar suara lewat avatar foto.")
							showDidVideo(false)
							await speaker.enqueue(item)
						}
					} else {
						await speaker.enqueue(item)
					}
				} else {
					await browserSpeak(text)
				}
			} catch (error) {
				addMessage("err", "Suara gagal: " + error.message)
				if (!isDid && turnId === myTurn) await browserSpeak(text)
			}
		})
	}

	return { push, done: () => chain }
}

/* ------------------------------ satu giliran -------------------------- */
async function ask(userText) {
	const text = (userText || "").trim()
	if (!text || busy) return
	busy = true
	turnId += 1
	const myTurn = turnId
	audioContext()
	speaker.stop()
	stopBrowserTts()

	addMessage("user", text)
	history.push({ role: "user", content: text })
	setState("thinking")
	showCaption("")

	const bubble = addMessage("bot", "...")
	const queue = createSpeechQueue(myTurn)
	let full = ""
	let spokenUpTo = 0

	const flush = (final) => {
		if (config.avatarMode === "did" && didModule) {
			// D-ID: kalimat pertama segera dikirim (respons cepat), sisanya digabung jadi satu talk
			// supaya tidak ada jeda antar kalimat (setiap talk punya overhead ~1-2 detik).
			const sentences = extractSentences(full, final)
			if (spokenUpTo === 0 && sentences.length >= 1) {
				queue.push(sentences[0])
				spokenUpTo = 1
			}
			if (final && sentences.length > spokenUpTo) {
				queue.push(sentences.slice(spokenUpTo).join(" "))
				spokenUpTo = sentences.length
			}
			return
		}
		const sentences = extractSentences(full, final)
		for (let i = spokenUpTo; i < sentences.length; i++) {
			queue.push(sentences[i])
		}
		spokenUpTo = sentences.length
	}

	try {
		if (!serverOnline) throw new Error("Server belum jalan. Jalankan: npm start")
		const response = await fetch("/api/chat?stream=1", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: history }),
		})
		if (!response.ok) {
			const detail = await response.json().catch(() => ({}))
			throw new Error(detail.error || "Server menolak (" + response.status + ")")
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) break
			buffer += decoder.decode(chunk.value, { stream: true })
			const blocks = buffer.split("\n\n")
			buffer = blocks.pop() || ""
			for (const block of blocks) {
				const eventMatch = block.match(/^event:\s*(.+)$/m)
				const dataMatch = block.match(/^data:\s*(.+)$/m)
				if (!eventMatch || !dataMatch) continue
				const name = eventMatch[1].trim()
				const data = JSON.parse(dataMatch[1])
				if (name === "delta") {
					full += data.text
					bubble.textContent = full
					el.chat.scrollTop = el.chat.scrollHeight
					flush(false)
				} else if (name === "error") {
					throw new Error(data.message)
				}
			}
		}
		flush(true)
		if (!full.trim()) throw new Error("Jawaban kosong dari model")
		bubble.textContent = full
		history.push({ role: "assistant", content: full })
		await queue.done()
	} catch (error) {
		bubble.remove()
		addMessage("err", error.message)
	} finally {
		if (turnId === myTurn) {
			showCaption("")
			setState("idle")
			busy = false
			if (handsFree) setTimeout(() => startListening(true), 350)
		}
	}
}

/* --------------------------------- mic -------------------------------- */
function useBrowserStt() {
	return config.stt.provider === "browser" || !serverOnline || !config.stt.ready
}

function stopListeningUi() {
	el.micBtn.classList.remove("recording")
	el.micLabel.textContent = handsFree ? "Mulai ngobrol" : "Tahan untuk bicara"
}

async function startListening(auto) {
	if (busy || calibrating) return
	audioContext()
	speaker.stop()
	stopBrowserTts()
	setState("listening")
	el.micBtn.classList.add("recording")
	el.micLabel.textContent = auto ? "Silakan bicara..." : "Lepas untuk kirim"

	if (useBrowserStt()) {
		if (!browserSttSupported()) {
			addMessage(
				"err",
				"Browser ini belum mendukung pengenalan suara. Pakai Chrome/Edge, atau isi STT_PROVIDER=groq di .env.",
			)
			stopListeningUi()
			setState("idle")
			return
		}
		browserStt = new BrowserStt({
			lang: sttLang(),
			onPartial: (text) => showCaption(text),
			onFinal: (text) => {
				showCaption("")
				ask(text)
			},
			onEnd: (text) => {
				stopListeningUi()
				if (!text) {
					if (!busy) setState("idle")
					if (handsFree && !busy) setTimeout(() => startListening(true), 600)
				}
			},
			onError: (code) => {
				stopListeningUi()
				setState("idle")
				if (code !== "no-speech" && code !== "aborted") {
					addMessage("err", "Mikrofon: " + code)
				}
			},
		})
		browserStt.start()
		return
	}

	if (!recorder) {
		recorder = new Recorder({
			onSpeechEnd: async (result) => {
				stopListeningUi()
				if (result.empty) {
					setState("idle")
					if (handsFree && !busy) setTimeout(() => startListening(true), 500)
					return
				}
				setState("thinking", "Mengubah suara ke teks...")
				try {
					const blob = result.blob
					const response = await fetch("/api/stt?mime=" + encodeURIComponent(blob.type || "audio/webm"), {
						method: "POST",
						headers: { "content-type": blob.type || "audio/webm" },
						body: blob,
					})
					const data = await response.json()
					if (!response.ok) throw new Error(data.error || "STT gagal")
					if (!data.text) {
						setState("idle")
						if (handsFree) setTimeout(() => startListening(true), 400)
						return
					}
					ask(data.text)
				} catch (error) {
					addMessage("err", error.message)
					setState("idle")
				}
			},
		})
	}

	try {
		await recorder.start({ autoStop: Boolean(auto) || handsFree })
	} catch (error) {
		addMessage("err", "Mikrofon tidak bisa dipakai: " + error.message)
		stopListeningUi()
		setState("idle")
	}
}

function stopListening() {
	if (useBrowserStt()) {
		if (browserStt) browserStt.stop()
	} else if (recorder) {
		recorder.stop()
	}
	stopListeningUi()
}

/* ------------------------------ event UI ------------------------------ */
el.micBtn.addEventListener("pointerdown", (event) => {
	event.preventDefault()
	if (handsFree) {
		if (el.micBtn.classList.contains("recording")) stopListening()
		else startListening(true)
		return
	}
	startListening(false)
})
el.micBtn.addEventListener("pointerup", () => {
	if (!handsFree) stopListening()
})
el.micBtn.addEventListener("pointercancel", () => {
	if (!handsFree) stopListening()
})
el.micBtn.addEventListener("pointerleave", () => {
	if (!handsFree && el.micBtn.classList.contains("recording")) stopListening()
})

el.handsFree.addEventListener("change", () => {
	handsFree = el.handsFree.checked
	stopListeningUi()
	if (handsFree && !busy) startListening(true)
	else stopListening()
})

el.stopBtn.addEventListener("click", () => {
	turnId += 1
	speaker.stop()
	stopBrowserTts()
	stopListening()
	if (didModule) didModule.muteDid(true)
	showCaption("")
	busy = false
	setState("idle")
})

el.composer.addEventListener("submit", (event) => {
	event.preventDefault()
	const text = el.textInput.value
	el.textInput.value = ""
	ask(text)
})

el.clearBtn.addEventListener("click", () => {
	history = []
	el.chat.innerHTML = ""
	addMessage("sys", "Percakapan dibersihkan.")
})

function openDrawer() {
	el.drawer.hidden = false
	el.scrim.hidden = false
}
function closeDrawer() {
	el.drawer.hidden = true
	el.scrim.hidden = true
}
el.settingsBtn.addEventListener("click", openDrawer)
el.closeDrawer.addEventListener("click", closeDrawer)
el.scrim.addEventListener("click", closeDrawer)

el.pickPhoto.addEventListener("click", () => el.photoInput.click())
el.emptyUploadBtn.addEventListener("click", () => el.photoInput.click())
el.photoInput.addEventListener("change", async () => {
	const file = el.photoInput.files && el.photoInput.files[0]
	if (!file) return
	el.photoInput.value = ""
	try {
		closeDrawer()
		addMessage("sys", "Foto dipasang. Mendeteksi wajah...")
		await uploadPhoto(file)
	} catch (error) {
		addMessage("err", error.message)
	}
})
el.useSample.addEventListener("click", async () => {
	try {
		closeDrawer()
		await applyPhoto(SAMPLE_PHOTO)
	} catch (error) {
		addMessage("err", error.message)
	}
})

el.calibrateBtn.addEventListener("click", startCalibration)
el.detectBtn?.addEventListener("click", () => redetectFace().catch((error) => addMessage("err", error.message)))
el.calibCancel.addEventListener("click", () => endCalibration(false))

el.pickVoice.addEventListener("click", () => el.voiceInput.click())
el.voiceInput.addEventListener("change", async () => {
	const file = el.voiceInput.files && el.voiceInput.files[0]
	if (!file) return
	el.voiceResult.textContent = "Mengunggah dan mengkloning suara..."
	try {
		const response = await fetch("/api/voice/clone?name=" + encodeURIComponent("Suara Saya"), {
			method: "POST",
			headers: { "content-type": file.type || "audio/mpeg" },
			body: file,
		})
		const data = await response.json()
		if (!response.ok) throw new Error(data.error || "Gagal")
		el.voiceResult.innerHTML =
			"Berhasil. Salin ke file .env lalu restart server:<br><code>ELEVENLABS_VOICE_ID=" + data.voiceId + "</code>"
	} catch (error) {
		el.voiceResult.textContent = "Gagal: " + error.message
	}
})

window.addEventListener("keydown", (event) => {
	if (event.code === "Space" && document.activeElement === document.body) {
		event.preventDefault()
		if (!el.micBtn.classList.contains("recording")) startListening(false)
	}
	if (event.key === "Escape") {
		if (calibrating) endCalibration(false)
		else closeDrawer()
	}
})
window.addEventListener("keyup", (event) => {
	if (event.code === "Space" && !handsFree) stopListening()
})

/* -------------------------------- D-ID -------------------------------- */
/** Tampilkan video D-ID (true) atau avatar foto lokal (false). */
function showDidVideo(show) {
	if (show) {
		el.stageEmpty.hidden = true
		el.video.hidden = false
		el.canvas.hidden = true
	} else {
		el.video.hidden = true
		el.canvas.hidden = false
		puppet.start()
	}
	renderStatus()
}

function connectDid() {
	if (!didModule) return Promise.resolve(false)
	return didModule
		.startDid({
			videoEl: el.video,
			photoUrl: currentPhotoSrc,
			onTrack: (_stream, state) => {
				// fluent: video D-ID selalu tampil (gerak diam alami dari D-ID).
				// tidak fluent: video hanya saat bicara, sisanya avatar foto lokal yang bernapas & berkedip.
				if (state.fluent) showDidVideo(true)
				addMessage("sys", "Avatar video D-ID aktif (" + state.mode + (state.fluent ? ", fluent" : ", video saat bicara") + ").")
				renderStatus()
			},
			onTalkState: (talking, state) => {
				if (state.fluent) return
				showDidVideo(talking)
			},
			onStatus: (message) => {
				console.log("[D-ID]", message)
				renderStatus()
			},
			onError: (err) => {
				console.warn("D-ID streaming issue:", err)
				showDidVideo(false)
			},
		})
		.catch((error) => {
			console.warn("D-ID info:", error.message)
			addMessage("err", "D-ID: " + error.message + " Sementara memakai avatar foto.")
			showDidVideo(false)
			return false
		})
}

function avatarStatusLabel() {
	if (config.avatarMode === "did") {
		const s = didModule ? didModule.getDidState() : null
		if (!s || !s.connected) return "D-ID belum tersambung (cadangan: avatar foto)"
		return (
			"D-ID " + (s.mode || "") + (s.fluent ? " fluent" : "") +
			(s.lastLatencyMs ? " · mulai bicara " + (s.lastLatencyMs / 1000).toFixed(1) + " s" : "")
		)
	}
	return config.avatarMode + (puppet.legacy ? " (2D, tanpa WebGL)" : " (mesh 3D)")
}

/* -------------------------------- mulai ------------------------------- */
async function init() {
	setState("idle")
	el.calibOverlay.hidden = true
	calibrating = null
	await loadConfig()

	// 1. Muat foto: yang terakhir dipakai, atau foto contoh
	let photoToUse = localStorage.getItem(STORE.photo) || SAMPLE_PHOTO
	el.canvas.hidden = false
	el.video.hidden = true
	try {
		await applyPhoto(photoToUse, { save: false })
	} catch (error) {
		console.warn("foto tersimpan gagal dimuat:", error)
		try {
			localStorage.removeItem(STORE.photo)
			await applyPhoto(SAMPLE_PHOTO, { save: false })
		} catch {
			el.stageEmpty.hidden = false
		}
	}

	// 2. Hubungkan avatar video streaming jika aktif
	if (config.avatarMode === "simli" && serverOnline) {
		try {
			simliModule = await import("./simli.js")
			await simliModule.startSimli({
				videoEl: el.video,
				onTrack: () => {
					el.stageEmpty.hidden = true
					el.canvas.hidden = true
					el.video.hidden = false
					puppet.stop()
					addMessage("sys", "Avatar video AI real-time Simli aktif!")
				},
				onError: (err) => {
					console.warn("Simli issue:", err)
					el.video.hidden = true
					el.canvas.hidden = false
					puppet.start()
				},
				onStatus: (msg) => console.log("[Simli]", msg),
			})
		} catch (error) {
			console.error("Simli startup error:", error)
			addMessage("err", "Simli gagal (" + error.message + "). Memakai avatar foto.")
			el.canvas.hidden = false
			el.video.hidden = true
			puppet.start()
		}
	} else if (config.avatarMode === "did" && serverOnline) {
		try {
			didModule = await import("./did.js")
			connectDid()
		} catch (error) {
			console.error("D-ID import error:", error)
		}
	} else if (config.avatarMode === "heygen" && serverOnline) {
		addMessage(
			"err",
			"Mode HeyGen belum tersedia di versi web ini (butuh SDK HeyGen). Memakai avatar foto. Ubah AVATAR_MODE=puppet di .env untuk menghilangkan pesan ini.",
		)
	}

	addMessage(
		"sys",
		serverOnline
			? "Tekan tombol mikrofon lalu tanyakan apa saja. Bisa juga ketik di kolom bawah."
			: "Server belum terhubung. Jalankan npm start lalu buka http://localhost:8787",
	)
}

init()
