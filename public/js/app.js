import { PhotoPuppet } from "./puppet.js?v=2070"
import {
	Recorder,
	Speaker,
	BrowserStt,
	browserSttSupported,
	speakWithBrowser,
	stopBrowserTts,
	audioContext,
	setVoiceSettings,
	getVoiceSettings,
} from "./audio.js?v=2070"

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
	resetRig: $("resetRig"),
	calibOverlay: $("calibOverlay"),
	calibStep: $("calibStep"),
	calibCancel: $("calibCancel"),
	mouthW: $("mouthW"),
	mouthH: $("mouthH"),
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

const STORE = { photo: "aal.photo", rig: "aal.rig", tuning: "aal.tuning", voice: "aal.voice" }
const SAMPLE_PHOTO = "assets/avatar.jpg"

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

const puppet = new PhotoPuppet(el.canvas)
const speaker = new Speaker(el.player, {
	onLevel: (level, tone) => puppet.setLevel(level, tone),
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

	el.personaName.textContent = config.persona.name || "Avatar AI Lifetime"
	document.title = el.personaName.textContent + " - Avatar AI"

	if (!serverOnline) setPill("Server tidak terhubung", "warn")
	else if (!config.llm.ready) setPill("API key LLM belum diisi", "warn")
	else setPill(config.llm.label + " + " + config.tts.label.split(" (")[0], "ok")

	renderStatus()
}

function renderStatus() {
	const mark = (ok) =>
		ok ? '<span class="good">siap</span>' : '<span class="bad">belum diisi</span>'
	const rows = [
		[
			"Server",
			serverOnline
				? '<span class="good">terhubung</span>'
				: '<span class="bad">mati</span>',
		],
		["Otak (LLM)", config.llm.label + " " + mark(config.llm.ready)],
		["Dengar (STT)", config.stt.label + " " + mark(config.stt.ready)],
		["Suara (TTS)", config.tts.label + " " + mark(config.tts.ready)],
		["Avatar", config.avatarMode],
	]
	el.statusList.innerHTML = rows
		.map((row) => "<li><b>" + row[0] + "</b><span>" + row[1] + "</span></li>")
		.join("")
}

/* --------------------------------- foto -------------------------------- */
function readJson(key) {
	try {
		return JSON.parse(localStorage.getItem(key) || "null")
	} catch {
		return null
	}
}

function saveRig() {
	try {
		localStorage.setItem(
			STORE.rig,
			JSON.stringify({ src: localStorage.getItem(STORE.photo), rig: puppet.rig }),
		)
	} catch {
		/* abaikan */
	}
}

async function applyPhoto(src, options) {
	const save = !options || options.save !== false
	await puppet.setImage(src)
	const savedRig = readJson(STORE.rig)
	if (src && (src.includes("avatar-nofal") || src.includes("avatar-04634437a696"))) {
		puppet.setRig({
			eyeL: { x: 435, y: 412, w: 32, h: 14 },
			eyeR: { x: 476, y: 416, w: 30, h: 14 },
			mouth: { x: 440, y: 476, w: 54, h: 20 },
			head: { x: 480, y: 430, rx: 115, ry: 150 },
		})
	} else if (src && src.includes("avatar.jpg")) {
		puppet.setRig({
			eyeL: { x: 176, y: 167, w: 30, h: 12 },
			eyeR: { x: 238, y: 169, w: 30, h: 12 },
			mouth: { x: 208, y: 229, w: 56, h: 16 },
			head: { x: 207, y: 168, rx: 105, ry: 135 },
		})
	} else if (savedRig && savedRig.src === src && savedRig.rig) {
		puppet.setRig(savedRig.rig)
	} else {
		puppet.autoRig()
	}
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
	syncSliders()
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
				await applyPhoto(data.url)
				return
			}
		} catch {
			/* jatuh ke data URL di bawah */
		}
	}
	await applyPhoto(await fileToDataUrl(file))
}

/* ------------------------------ kalibrasi ------------------------------ */
const CALIB_STEPS = [
	{ key: "mouth", text: "Klik tengah MULUT pada foto" },
	{ key: "eyeL", text: "Klik mata KIRI (sebelah kiri layar)" },
	{ key: "eyeR", text: "Klik mata KANAN (sebelah kanan layar)" },
]

function startCalibration() {
	if (!puppet.image) return
	calibrating = { index: 0, picks: {} }
	el.calibOverlay.hidden = false
	el.stage.classList.add("calibrating")
	el.calibStep.textContent = CALIB_STEPS[0].text
	closeDrawer()
}

function endCalibration(apply) {
	if (apply && calibrating) {
		const picks = calibrating.picks
		const width = puppet.image.naturalWidth
		const height = puppet.image.naturalHeight
		const eyeDist = Math.max(width * 0.04, Math.abs(picks.eyeR.x - picks.eyeL.x))
		puppet.setRig({
			mouth: {
				x: picks.mouth.x,
				y: picks.mouth.y,
				w: eyeDist * 0.95,
				h: eyeDist * 0.42,
			},
			eyeL: { x: picks.eyeL.x, y: picks.eyeL.y, w: eyeDist * 0.42, h: eyeDist * 0.16 },
			eyeR: { x: picks.eyeR.x, y: picks.eyeR.y, w: eyeDist * 0.42, h: eyeDist * 0.16 },
			head: { x: width * 0.5, y: height * 0.3, rx: width * 0.2, ry: height * 0.26 },
		})
		puppet.deriveHead()
		saveRig()
		syncSliders()
	}
	calibrating = null
	el.calibOverlay.hidden = true
	el.stage.classList.remove("calibrating")
}

el.canvas.addEventListener("click", (event) => {
	if (!calibrating) return
	const point = puppet.clientToImage(event.clientX, event.clientY)
	calibrating.picks[CALIB_STEPS[calibrating.index].key] = point
	calibrating.index += 1
	if (calibrating.index >= CALIB_STEPS.length) endCalibration(true)
	else el.calibStep.textContent = CALIB_STEPS[calibrating.index].text
})

/* -------------------------- slider penyetelan ------------------------- */
function applyTuning() {
	const tuning = readJson(STORE.tuning) || {}
	const body = tuning.bodyMotion === undefined ? 100 : tuning.bodyMotion
	const lip = (tuning.lipGain === undefined || tuning.lipGain < 155) ? 160 : tuning.lipGain
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

	setVoiceSettings({
		pitch: pitch / 100,
		rate: rate / 100,
		macho: preset !== "normal",
	})
}

function saveTuning() {
	try {
		localStorage.setItem(
			STORE.tuning,
			JSON.stringify({
				bodyMotion: Number(el.bodyMotion.value),
				lipGain: Number(el.lipGain.value),
			}),
		)
	} catch {
		/* abaikan */
	}
}

function saveVoiceSettings() {
	if (!el.voicePitch) return
	const pitch = Number(el.voicePitch.value)
	const rate = Number(el.voiceRate.value)
	const preset = el.voicePreset ? el.voicePreset.value : "macho"
	setVoiceSettings({
		pitch: pitch / 100,
		rate: rate / 100,
		macho: preset !== "normal",
	})
	try {
		localStorage.setItem(STORE.voice, JSON.stringify({ pitch, rate, preset }))
	} catch {
		/* abaikan */
	}
}

function syncSliders() {
	if (!puppet.rig || !puppet.image) return
	el.mouthW.max = Math.round(puppet.image.naturalWidth * 0.5)
	el.mouthH.max = Math.round(puppet.image.naturalHeight * 0.3)
	el.mouthW.value = Math.round(puppet.rig.mouth.w)
	el.mouthH.value = Math.round(puppet.rig.mouth.h)
}

el.mouthW.addEventListener("input", () => {
	if (!puppet.rig) return
	puppet.rig.mouth.w = Number(el.mouthW.value)
	saveRig()
})
el.mouthH.addEventListener("input", () => {
	if (!puppet.rig) return
	puppet.rig.mouth.h = Number(el.mouthH.value)
	saveRig()
})
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
			(
				((ch === "," || ch === ";" || ch === ":") && wordsCount(current) >= 3) ||
				(wordsCount(current) >= 7 && /\s/.test(ch))
			)

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

async function fetchTts(text) {
	const response = await fetch("/api/tts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	})
	if (!response.ok) {
		const detail = await response.json().catch(() => ({}))
		throw new Error(detail.error || "TTS gagal (" + response.status + ")")
	}
	return URL.createObjectURL(await response.blob())
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
	return await response.blob()
}

/** Antrean kalimat: kalimat pertama diucapkan sementara sisanya masih dibuat. */
function createSpeechQueue(myTurn) {
	let chain = Promise.resolve()
	const useServerTts =
		serverOnline && config.tts.provider !== "browser" && config.tts.ready
	const isDid = Boolean(config.avatarMode === "did" && didModule)
	const isSimli = Boolean(config.avatarMode === "simli" && simliModule && simliModule.isSimliReady())

	const push = (sentence) => {
		const text = cleanForSpeech(sentence)
		if (!text) return
		const prefetchBlob = (useServerTts && (isDid || isSimli))
			? fetchTtsBlob(text).catch((error) => error)
			: null
		const prefetchUrl = (useServerTts && !isDid && !isSimli)
			? fetchTts(text).catch((error) => error)
			: null

		chain = chain.then(async () => {
			if (turnId !== myTurn) return
			setState("speaking")
			showCaption(text)
			try {
				if (isSimli && prefetchBlob) {
					const blob = await prefetchBlob
					if (blob instanceof Error) throw blob
					if (turnId !== myTurn) return
					const audioUrl = URL.createObjectURL(blob)
					await Promise.all([
						speaker.enqueue(audioUrl),
						simliModule.speakSimli(blob).catch((err) => console.warn("[simli] speak error:", err.message)),
					])
				} else if (isDid && prefetchBlob) {
					const blob = await prefetchBlob
					if (blob instanceof Error) throw blob
					if (turnId !== myTurn) return
					try {
						await didModule.speakDid(blob)
					} catch (didErr) {
						console.warn("[did] gagal bicara, fallback ke audio:", didErr.message)
						addMessage("err", "D-ID (" + didErr.message + ") -> Memutar suara langsung...")
						const audioUrl = URL.createObjectURL(blob)
						el.video.hidden = true
						el.canvas.hidden = false
						puppet.start()
						await speaker.enqueue(audioUrl)
					}
				} else if (prefetchUrl) {
					const url = await prefetchUrl
					if (url instanceof Error) throw url
					if (turnId !== myTurn) return
					await speaker.enqueue(url)
				} else {
					await speakWithBrowser(text, {
						lang: sttLang(),
						onLevel: (level, tone) => puppet.setLevel(level, tone),
					})
				}
			} catch (error) {
				addMessage("err", "Suara gagal: " + error.message)
				if (!isDid) {
					await speakWithBrowser(text, {
						lang: sttLang(),
						onLevel: (level, tone) => puppet.setLevel(level, tone),
					})
				}
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
		if (config.avatarMode === "did") {
			if (final && full.trim() && spokenUpTo === 0) {
				spokenUpTo = 1
				queue.push(full.trim())
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
					const response = await fetch(
						"/api/stt?mime=" + encodeURIComponent(blob.type || "audio/webm"),
						{
							method: "POST",
							headers: { "content-type": blob.type || "audio/webm" },
							body: blob,
						},
					)
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
	try {
		await uploadPhoto(file)
		addMessage("sys", "Foto dipasang. Lanjutkan kalibrasi agar mulut pas.")
		startCalibration()
	} catch (error) {
		addMessage("err", error.message)
	}
})
el.useSample.addEventListener("click", async () => {
	try {
		await applyPhoto(SAMPLE_PHOTO)
		closeDrawer()
	} catch (error) {
		addMessage("err", error.message)
	}
})

el.calibrateBtn.addEventListener("click", startCalibration)
el.calibCancel.addEventListener("click", () => endCalibration(false))
el.resetRig.addEventListener("click", () => {
	puppet.autoRig()
	saveRig()
	syncSliders()
})

el.pickVoice.addEventListener("click", () => el.voiceInput.click())
el.voiceInput.addEventListener("change", async () => {
	const file = el.voiceInput.files && el.voiceInput.files[0]
	if (!file) return
	el.voiceResult.textContent = "Mengunggah dan mengkloning suara..."
	try {
		const response = await fetch(
			"/api/voice/clone?name=" + encodeURIComponent("Suara Saya"),
			{
				method: "POST",
				headers: { "content-type": file.type || "audio/mpeg" },
				body: file,
			},
		)
		const data = await response.json()
		if (!response.ok) throw new Error(data.error || "Gagal")
		el.voiceResult.innerHTML =
			"Berhasil. Salin ke file .env lalu restart server:<br><code>ELEVENLABS_VOICE_ID=" +
			data.voiceId +
			"</code>"
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

setInterval(() => {
	if (calibrating) puppet.drawGuides()
}, 140)

/* -------------------------------- mulai ------------------------------- */
async function init() {
	setState("idle")
	el.calibOverlay.hidden = true
	calibrating = null
	await loadConfig()

	// 1. Muat foto portrait avatar yang sebelumnya (assets/avatar.jpg)
	let photoToUse = localStorage.getItem(STORE.photo)
	if (photoToUse && (photoToUse.includes("avatar-nofal") || photoToUse.includes("avatar-04634437a696"))) {
		try { localStorage.removeItem(STORE.photo); localStorage.removeItem(STORE.rig) } catch {}
		photoToUse = SAMPLE_PHOTO
	}
	if (!photoToUse) photoToUse = SAMPLE_PHOTO
	try {
		await applyPhoto(photoToUse, { save: true })
	} catch {
		try {
			await applyPhoto(SAMPLE_PHOTO, { save: true })
		} catch {
			el.stageEmpty.hidden = false
		}
	}
	el.canvas.hidden = false
	el.video.hidden = true

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
				onStatus: (msg) => {
					console.log("[Simli]", msg)
				},
			})
		} catch (error) {
			console.error("Simli startup error:", error)
			el.canvas.hidden = false
			el.video.hidden = true
			puppet.start()
		}
	} else if (config.avatarMode === "did" && serverOnline) {
		try {
			didModule = await import("./did.js")
			didModule.startDid({
				videoEl: el.video,
				onTrack: () => {
					el.stageEmpty.hidden = true
					el.canvas.hidden = true
					el.video.hidden = false
					puppet.stop()
					addMessage("sys", "Avatar video real-time D-ID aktif!")
				},
				onError: (err) => {
					console.warn("D-ID streaming issue:", err)
					el.video.hidden = true
					el.canvas.hidden = false
					puppet.start()
				},
			}).catch((error) => {
				console.warn("D-ID info:", error.message)
				didModule = null
				el.canvas.hidden = false
				el.video.hidden = true
				puppet.start()
			})
		} catch (error) {
			console.error("D-ID import error:", error)
		}
	} else if (config.avatarMode === "heygen" && serverOnline) {
		try {
			const module = await import("./heygen.js")
			await module.startHeygen({
				videoEl: el.video,
				canvasEl: el.canvas,
				onMessage: addMessage,
			})
			el.stageEmpty.hidden = true
		} catch (error) {
			addMessage("err", "Mode HeyGen gagal: " + error.message + ". Kembali ke mode foto.")
		}
	}

	addMessage(
		"sys",
		serverOnline
			? "Tekan tombol mikrofon lalu tanyakan apa saja. Bisa juga ketik di kolom bawah."
			: "Server belum terhubung. Jalankan npm start lalu buka http://localhost:8787",
	)
}

init()
