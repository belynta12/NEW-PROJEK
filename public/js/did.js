/**
 * did.js — klien D-ID Streaming (WebRTC).
 * Mendukung Agents Streams (API terbaru, opsi fluent) dan Talks Streams (legacy);
 * server (/api/avatar/did/*) yang memilih dan menyimpan API key.
 *
 * Alur:
 *   startDid()  -> POST stream -> RTCPeerConnection -> SDP/ICE -> tunggu "stream/ready"
 *   speakDid()  -> audio (Fish Audio/ElevenLabs) -> URL (unggah ke D-ID atau URL publik server)
 *                  -> POST talk -> tunggu "stream/started" ... "stream/done" lewat data channel
 *   onTalkState -> aplikasi menampilkan video saat bicara, puppet lokal saat diam (bila tidak fluent)
 */

const BASE = ""

let pc = null
let dataChannel = null
let stream = null // { id, session_id, agentId, mode, fluent, warmup, publicAudio }
let videoEl = null
let callbacks = {}
let connecting = null
let connected = false
let ready = false
let talking = false
let readyWaiters = []
let currentTalk = null
let lastLatencyMs = null
let lastPhotoUrl = ""
let framesSeen = false
let frameWatcher = 0

export function isDidReady() {
	return (
		connected &&
		Boolean(stream) &&
		Boolean(pc) &&
		!["closed", "failed"].includes(pc.connectionState) &&
		!["closed", "failed"].includes(pc.iceConnectionState)
	)
}

export function getDidState() {
	return {
		connected,
		ready,
		talking,
		mode: stream ? stream.mode : null,
		fluent: Boolean(stream && stream.fluent),
		streamId: stream ? stream.id : null,
		lastLatencyMs,
	}
}

function emitStatus(message) {
	console.log("[did]", message)
	callbacks.onStatus?.(message)
}

function setTalking(value) {
	if (talking === value) return
	talking = value
	callbacks.onTalkState?.(value, getDidState())
}

function markReady() {
	if (ready) return
	ready = true
	for (const resolve of readyWaiters) resolve(true)
	readyWaiters = []
	callbacks.onTrack?.(videoEl ? videoEl.srcObject : null, getDidState())
}

function waitReady(timeoutMs) {
	if (ready) return Promise.resolve(true)
	return new Promise((resolve) => {
		readyWaiters.push(resolve)
		setTimeout(() => {
			if (!ready && connected) {
				emitStatus("Warmup tidak mengirim sinyal siap, lanjut.")
				markReady()
			}
			resolve(ready)
		}, timeoutMs)
	})
}

/* ------------------------------ koneksi ------------------------------- */

/** Mulai sesi D-ID. Aman dipanggil berulang (mengembalikan promise koneksi yang sama). */
export async function startDid(options = {}) {
	if (options.videoEl) videoEl = options.videoEl
	if (options.photoUrl !== undefined) lastPhotoUrl = options.photoUrl
	callbacks = {
		onTrack: options.onTrack || callbacks.onTrack,
		onError: options.onError || callbacks.onError,
		onStatus: options.onStatus || callbacks.onStatus,
		onTalkState: options.onTalkState || callbacks.onTalkState,
	}
	if (connecting) return connecting
	if (isDidReady()) return true
	connecting = connect()
		.catch((error) => {
			callbacks.onError?.(error.message || String(error))
			throw error
		})
		.finally(() => {
			connecting = null
		})
	return connecting
}

async function connect() {
	closePeer()
	emitStatus("Menyambungkan D-ID...")
	const t0 = performance.now()
	const sess = await api("POST", "/api/avatar/did/stream", { photoUrl: lastPhotoUrl })
	stream = {
		id: sess.id,
		session_id: sess.session_id,
		agentId: sess.agentId || null,
		mode: sess.mode || "talks",
		fluent: Boolean(sess.fluent),
		warmup: sess.warmup !== false,
		publicAudio: Boolean(sess.publicAudio),
	}
	if (Array.isArray(sess.notes) && sess.notes.length) emitStatus("Catatan: " + sess.notes.join(" | "))

	const iceServers = (sess.ice_servers || []).map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }))
	pc = new RTCPeerConnection({ iceServers })
	const thisPc = pc

	// D-ID mewajibkan data channel bernama JanusDataChannel; di sinilah event stream/* datang
	dataChannel = pc.createDataChannel("JanusDataChannel")
	dataChannel.onmessage = onDataMessage

	pc.ontrack = onTrack
	pc.onicecandidate = (event) => {
		if (pc !== thisPc || !stream) return
		const c = event.candidate
		api("POST", "/api/avatar/did/stream/ice", {
			streamId: stream.id,
			sessionId: stream.session_id,
			agentId: stream.agentId,
			candidate: c ? c.candidate : null,
			sdpMid: c ? c.sdpMid : undefined,
			sdpMLineIndex: c ? c.sdpMLineIndex : undefined,
		}).catch((error) => console.warn("[did] ice:", error.message))
	}
	pc.oniceconnectionstatechange = () => {
		if (pc !== thisPc) return
		const state = pc.iceConnectionState
		console.log("[did] ICE:", state)
		if (state === "connected" || state === "completed") {
			connected = true
			if (!stream.warmup) setTimeout(markReady, 800)
		} else if (state === "failed") {
			connected = false
			ready = false
			failCurrentTalk(new Error("Koneksi WebRTC D-ID gagal"))
			callbacks.onError?.("Koneksi D-ID WebRTC gagal menghubungkan jalur media.")
		} else if (state === "disconnected" || state === "closed") {
			connected = false
			ready = false
		}
	}
	pc.onconnectionstatechange = () => {
		if (pc !== thisPc) return
		console.log("[did] connection:", pc.connectionState)
		if (pc.connectionState === "connected") connected = true
		if (pc.connectionState === "failed" || pc.connectionState === "closed") {
			connected = false
			ready = false
			setTalking(false)
		}
	}

	await pc.setRemoteDescription(new RTCSessionDescription(sess.offer))
	const answer = await pc.createAnswer()
	await pc.setLocalDescription(answer)
	await api("POST", "/api/avatar/did/stream/sdp", {
		streamId: stream.id,
		sessionId: stream.session_id,
		agentId: stream.agentId,
		answer,
	})
	connected = true
	await waitReady(15000)
	emitStatus(`D-ID siap (${stream.mode}${stream.fluent ? ", fluent" : ""}) dalam ${((performance.now() - t0) / 1000).toFixed(1)} s`)
	return true
}

function onTrack(event) {
	const mediaStream = (event.streams && event.streams[0]) || new MediaStream([event.track])
	if (!videoEl || videoEl.srcObject === mediaStream) return
	videoEl.srcObject = mediaStream
	videoEl.playsInline = true
	videoEl.autoplay = true
	const playPromise = videoEl.play()
	if (playPromise) {
		playPromise.catch(() => {
			// autoplay dengan suara diblokir sebelum ada interaksi: putar tanpa suara dulu
			videoEl.muted = true
			videoEl.play().catch(() => {})
		})
	}
	// tandai siap bila frame video benar-benar datang (cadangan bila stream/ready tidak muncul)
	watchFrames()
}

function watchFrames() {
	cancelAnimationFrame(frameWatcher)
	framesSeen = false
	if (videoEl && "requestVideoFrameCallback" in HTMLVideoElement.prototype) {
		const onFrame = () => {
			framesSeen = true
			if (!stream || !stream.warmup) markReady()
			if (talking || !ready) {
				/* frame saat bicara: tidak perlu apa-apa */
			}
			videoEl.requestVideoFrameCallback(onFrame)
		}
		videoEl.requestVideoFrameCallback(onFrame)
		return
	}
	let lastFrames = -1
	const poll = async () => {
		if (!pc || !videoEl || !videoEl.srcObject) return
		try {
			const stats = await pc.getStats()
			stats.forEach((report) => {
				if (report.type === "inbound-rtp" && report.kind === "video") {
					if (report.framesDecoded > lastFrames && lastFrames >= 0) {
						framesSeen = true
						if (!stream || !stream.warmup) markReady()
					}
					lastFrames = report.framesDecoded
				}
			})
		} catch {
			/* abaikan */
		}
		frameWatcher = requestAnimationFrame(() => setTimeout(poll, 400))
	}
	poll()
}

function onDataMessage(message) {
	const raw = typeof message.data === "string" ? message.data : ""
	const [event, ...rest] = raw.split(":")
	const payload = rest.join(":")
	switch (event) {
		case "stream/ready":
			markReady()
			break
		case "stream/started":
			setTalking(true)
			if (currentTalk && !currentTalk.startedAt) {
				currentTalk.startedAt = performance.now()
				lastLatencyMs = Math.round(currentTalk.startedAt - currentTalk.t0)
				emitStatus(`Mulai bicara ${(lastLatencyMs / 1000).toFixed(1)} s setelah audio siap`)
			}
			break
		case "stream/done":
			setTalking(false)
			finishCurrentTalk()
			break
		case "stream/error":
			setTalking(false)
			failCurrentTalk(new Error("D-ID stream error" + (payload ? ": " + payload : "")))
			break
		default:
			// chat/*, agent/* dll. tidak dipakai (kita bawa audio sendiri)
			break
	}
}

/* ------------------------------- bicara -------------------------------- */

function finishCurrentTalk() {
	if (!currentTalk) return
	const t = currentTalk
	currentTalk = null
	clearTimeout(t.startTimer)
	clearTimeout(t.doneTimer)
	t.resolve({ startedAt: t.startedAt || null })
}

function failCurrentTalk(error) {
	if (!currentTalk) return
	const t = currentTalk
	currentTalk = null
	clearTimeout(t.startTimer)
	clearTimeout(t.doneTimer)
	t.reject(error)
}

/** Unggah audio ke D-ID lebih awal (opsional; dipanggil saat prefetch). */
export async function prepareDidAudio(blob) {
	const uploaded = await apiRaw("POST", "/api/avatar/did/audio", blob, blob.type || "audio/mpeg")
	return uploaded.url
}

/**
 * Ucapkan audio lewat avatar D-ID.
 * @param {Blob} audioBlob  audio MP3 hasil TTS
 * @param {{text?:string, duration?:number, ttsKey?:string, audioUrl?:string}} opts
 */
export async function speakDid(audioBlob, opts = {}) {
	if (!isDidReady()) {
		emitStatus("Menghubungkan ulang sebelum bicara...")
		await startDid({})
	}
	if (currentTalk) await currentTalk.promise.catch(() => {})
	const t0 = performance.now()
	let audioUrl = opts.audioUrl || null
	let ttsKey = null
	if (!audioUrl) {
		if (stream.publicAudio && opts.ttsKey) ttsKey = opts.ttsKey
		else audioUrl = await prepareDidAudio(audioBlob)
	}
	if (videoEl) {
		videoEl.muted = false
		videoEl.play().catch(() => {})
	}
	const response = await api("POST", "/api/avatar/did/stream/talk", {
		streamId: stream.id,
		sessionId: stream.session_id,
		agentId: stream.agentId,
		audioUrl: audioUrl || undefined,
		ttsKey: ttsKey || undefined,
	})
	const durationSec = Number(response && response.duration) || Number(opts.duration) || Math.max(1.5, (audioBlob.size || 0) / 6000)
	const talk = { t0, startedAt: null }
	talk.promise = new Promise((resolve, reject) => {
		talk.resolve = resolve
		talk.reject = reject
	})
	currentTalk = talk
	// cadangan bila event data channel tidak datang
	talk.startTimer = setTimeout(() => {
		if (currentTalk === talk && !talk.startedAt) {
			talk.startedAt = performance.now()
			setTalking(true)
		}
	}, 2500)
	talk.doneTimer = setTimeout(() => {
		if (currentTalk === talk) {
			setTalking(false)
			finishCurrentTalk()
		}
	}, (durationSec + 6) * 1000)
	const outcome = await talk.promise
	setTalking(false)
	return { ...response, durationSec, latencyMs: outcome.startedAt ? Math.round(outcome.startedAt - t0) : null }
}

export function muteDid(muted) {
	if (videoEl) videoEl.muted = Boolean(muted)
}

/** Ganti foto: tutup sesi lama lalu buat yang baru. */
export async function restartDid({ photoUrl } = {}) {
	await stopDid()
	return startDid({ photoUrl })
}

function closePeer() {
	cancelAnimationFrame(frameWatcher)
	if (pc) {
		try {
			pc.close()
		} catch {
			/* abaikan */
		}
	}
	pc = null
	dataChannel = null
	connected = false
	ready = false
	setTalking(false)
	failCurrentTalk(new Error("Sesi D-ID ditutup"))
	if (videoEl) videoEl.srcObject = null
}

/** Tutup sesi D-ID dan WebRTC. */
export async function stopDid() {
	const s = stream
	stream = null
	closePeer()
	if (s && s.id) {
		try {
			await fetch(BASE + "/api/avatar/did/stream", {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ streamId: s.id, sessionId: s.session_id, agentId: s.agentId }),
				keepalive: true,
			})
		} catch {
			/* abaikan */
		}
	}
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => {
		stopDid()
	})
}

/* ---------- helpers ---------- */

async function api(method, path, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { "content-type": "application/json" },
		body: body != null ? JSON.stringify(body) : undefined,
	})
	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new Error(err.error || "D-ID API error " + res.status)
	}
	return res.json()
}

async function apiRaw(method, path, blob, mimeType) {
	const res = await fetch(BASE + path, { method, headers: { "content-type": mimeType }, body: blob })
	if (!res.ok) {
		const err = await res.json().catch(() => ({}))
		throw new Error(err.error || "Upload audio error " + res.status)
	}
	return res.json()
}
