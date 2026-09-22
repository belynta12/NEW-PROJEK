import { getConfig } from "../config.js"

/**
 * Mode avatar berbayar (opsional):
 * - HeyGen Streaming/Interactive Avatar: video real-time, kualitas paling mirip manusia.
 * - D-ID Talks: render video per jawaban dari SATU foto (lebih murah, ada jeda render).
 * Mode gratis (puppet) tidak butuh file ini.
 */

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
	return {
		token,
		avatarId: avatar.heygen.avatarId,
		voiceId: avatar.heygen.voiceId,
	}
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

/**
 * D-ID: buat video bicara dari foto + audio (audio boleh hasil ElevenLabs).
 * Catatan: sourceUrl dan audioUrl HARUS bisa diakses publik dari internet.
 */
export async function didCreateTalk({ sourceUrl, audioUrl, text }) {
	const { avatar } = getConfig()
	if (!avatar.did.apiKey) throw new Error("DID_API_KEY belum diisi di .env")
	const source = sourceUrl || avatar.did.sourceUrl
	if (!source) throw new Error("DID_SOURCE_URL (URL foto publik) belum diisi")

	const script = audioUrl
		? { type: "audio", audio_url: audioUrl }
		: { type: "text", input: text, provider: { type: "microsoft", voice_id: "id-ID-ArdiNeural" } }

	const response = await fetch("https://api.d-id.com/talks", {
		method: "POST",
		headers: {
			authorization: didAuth(),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			source_url: source,
			script,
			config: { stitch: true },
		}),
	})
	const detail = await response.text()
	if (!response.ok) throw new Error(`D-ID error ${response.status}: ${detail.slice(0, 300)}`)
	return JSON.parse(detail)
}

export async function didGetTalk(id) {
	const { avatar } = getConfig()
	if (!avatar.did.apiKey) throw new Error("DID_API_KEY belum diisi di .env")
	const response = await fetch(`https://api.d-id.com/talks/${encodeURIComponent(id)}`, {
		headers: { authorization: didAuth() },
	})
	const detail = await response.text()
	if (!response.ok) throw new Error(`D-ID error ${response.status}: ${detail.slice(0, 300)}`)
	return JSON.parse(detail)
}

function didAuth() {
	const { avatar } = getConfig()
	if (!avatar.did.apiKey) throw new Error("DID_API_KEY belum diisi di .env")
	return "Basic " + Buffer.from(avatar.did.apiKey).toString("base64")
}

let currentActiveStream = null

/** Buat sesi WebRTC streaming D-ID. Mengembalikan { id, offer, ice_servers, session_id } */
export async function didCreateStream() {
	const { avatar } = getConfig()
	const source = avatar.did.sourceUrl
	if (!source) throw new Error("DID_SOURCE_URL belum diisi di .env")

	// Jika ada stream lama yang masih tercatat, tutup dulu agar tidak melebihi kuota 1 stream concurrent D-ID
	if (currentActiveStream) {
		try {
			await didDeleteStream(currentActiveStream)
		} catch {}
		currentActiveStream = null
	}

	const maxAttempts = 3
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const response = await fetch("https://api.d-id.com/talks/streams", {
			method: "POST",
			headers: { authorization: didAuth(), "content-type": "application/json" },
			body: JSON.stringify({ source_url: source }),
		})
		const detail = await response.text()
		if (response.ok) {
			const resData = JSON.parse(detail)
			currentActiveStream = { streamId: resData.id, sessionId: resData.session_id }
			return resData
		}

		if (response.status === 403 && detail.includes("Max user sessions reached") && attempt < maxAttempts) {
			const delayMs = attempt * 2500
			console.log(`[did] Max user sessions reached (percobaan ${attempt}/${maxAttempts}), mencoba ulang dalam ${delayMs / 1000}s...`)
			await new Promise((r) => setTimeout(r, delayMs))
			continue
		}

		throw new Error(`D-ID stream create error ${response.status}: ${detail.slice(0, 300)}`)
	}
}

/** Kirim SDP answer browser ke D-ID setelah RTCPeerConnection dibuat. */
export async function didStreamSdp({ streamId, answer, sessionId }) {
	const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/sdp`, {
		method: "POST",
		headers: { authorization: didAuth(), "content-type": "application/json" },
		body: JSON.stringify({ answer, session_id: sessionId }),
	})
	const detail = await response.text()
	if (!response.ok) throw new Error(`D-ID SDP error ${response.status}: ${detail.slice(0, 300)}`)
	return JSON.parse(detail)
}

/** Kirim ICE candidate browser ke D-ID. */
export async function didStreamIce({ streamId, candidate, sdpMid, sdpMLineIndex, sessionId }) {
	const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/ice`, {
		method: "POST",
		headers: { authorization: didAuth(), "content-type": "application/json" },
		body: JSON.stringify({
			candidate,
			sdpMid,
			sdpMLineIndex,
			session_id: sessionId,
		}),
	})
	return response.ok
}

/** Kirim audio ke stream D-ID (memicu bibir bergerak & video keluar). */
export async function didStreamTalk({ streamId, audioUrl, sessionId }) {
	const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
		method: "POST",
		headers: { authorization: didAuth(), "content-type": "application/json" },
		body: JSON.stringify({
			script: { type: "audio", audio_url: audioUrl },
			session_id: sessionId,
			config: { stitch: true },
		}),
	})
	const detail = await response.text()
	if (!response.ok) throw new Error(`D-ID talk error ${response.status}: ${detail.slice(0, 300)}`)
	return JSON.parse(detail)
}

/** Tutup sesi streaming D-ID. */
export async function didDeleteStream({ streamId, sessionId }) {
	if (!streamId) return
	try {
		await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
			method: "DELETE",
			headers: { authorization: didAuth(), "content-type": "application/json" },
			body: JSON.stringify({ session_id: sessionId }),
		})
	} catch {}
	if (currentActiveStream && currentActiveStream.streamId === streamId) {
		currentActiveStream = null
	}
}

/** Upload buffer audio ke D-ID, kembalikan URL S3 untuk dipakai di didStreamTalk. */
export async function didUploadAudio(audioBuffer, mimeType = "audio/mpeg") {
	const ext = mimeType.includes("mp3") || mimeType.includes("mpeg") ? "audio.mp3" : "audio.wav"
	const form = new FormData()
	form.append("audio", new Blob([audioBuffer], { type: mimeType }), ext)
	const response = await fetch("https://api.d-id.com/audios", {
		method: "POST",
		headers: { authorization: didAuth() },
		body: form,
	})
	const detail = await response.text()
	if (!response.ok) throw new Error(`D-ID audio upload error ${response.status}: ${detail.slice(0, 300)}`)
	return JSON.parse(detail) // { url, id, duration }
}

/** Simli: dapatkan session token untuk WebRTC streaming di browser. */
export async function simliSessionToken() {
	const { avatar } = getConfig()
	const apiKey = avatar.simli?.apiKey || process.env.SIMLI_API_KEY
	if (!apiKey) throw new Error("SIMLI_API_KEY belum diisi di .env")
	const faceId = avatar.simli?.faceId || process.env.SIMLI_FACE_ID || "804c347a-26c9-4dcf-bb49-13df4bed61e8"

	const response = await fetch("https://api.simli.ai/compose/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-simli-api-key": apiKey,
		},
		body: JSON.stringify({
			faceId,
			handleSilence: true,
			maxSessionLength: 600,
			maxIdleTime: 120,
		}),
	})
	if (!response.ok) {
		const err = await response.text()
		throw new Error(`Simli token error ${response.status}: ${err}`)
	}
	const data = await response.json()
	return {
		session_token: data.session_token,
		faceId,
	}
}

