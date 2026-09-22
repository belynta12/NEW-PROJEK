/**
 * Smoke test modul D-ID server dengan API D-ID palsu (mock fetch).
 * Pakai: node scripts/qa/smoke-did-server.mjs
 */
import fs from "node:fs"
import path from "node:path"

process.env.DID_API_KEY = "user:test-key"
process.env.DID_MODE = "agents"
process.env.DID_FLUENT = "1"
process.env.PUBLIC_BASE_URL = ""
process.env.PERSONA_NAME = "Nofal"

const calls = []
let agentPolls = 0
let rejectFluent = true
let agentsForbidden = false
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
	const u = String(url)
	if (!u.startsWith("https://api.d-id.com")) return realFetch(url, init)
	const method = init.method || "GET"
	const p = u.replace("https://api.d-id.com", "")
	let body = null
	if (init.body && typeof init.body === "string") body = JSON.parse(init.body)
	calls.push({ method, p, body, form: init.body instanceof FormData })
	const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
	if (method === "POST" && p === "/images") return json(201, { url: "https://s3.example/img.jpg", id: "img1", faces: [{ size: 100 }] })
	if (method === "POST" && p === "/audios") return json(201, { url: "https://s3.example/audio.mp3", id: "aud1", duration: 2.5 })
	if (method === "POST" && p === "/agents") {
		if (agentsForbidden) return json(403, { kind: "PermissionError", description: "agents not allowed" })
		return json(201, { id: "agt_1", status: "created" })
	}
	if (method === "GET" && p === "/agents/agt_1") {
		agentPolls++
		return json(200, { id: "agt_1", status: agentPolls < 2 ? "created" : "done" })
	}
	if (method === "POST" && p === "/agents/agt_1/streams") {
		if (body.fluent && rejectFluent) return json(400, { kind: "ValidationError", description: "fluent not supported for this presenter" })
		return json(201, { id: "strm_1", session_id: "sess_1", jsep: { type: "offer", sdp: "v=0" }, ice_servers: [{ urls: ["stun:stun.d-id.com"] }] })
	}
	if (method === "POST" && p === "/agents/agt_1/streams/strm_1/sdp") return json(200, { status: "ok" })
	if (method === "POST" && p === "/agents/agt_1/streams/strm_1/ice") return json(200, {})
	if (method === "POST" && p === "/agents/agt_1/streams/strm_1") return json(200, { status: "started", duration: 2.5 })
	if (method === "DELETE" && p === "/agents/agt_1/streams/strm_1") return json(200, {})
	if (method === "POST" && p === "/talks/streams") return json(201, { id: "tstrm_1", session_id: "tsess_1", offer: { type: "offer", sdp: "v=0" }, ice_servers: [] })
	if (method === "POST" && p === "/talks/streams/tstrm_1") return json(200, { status: "started", duration: 3 })
	if (method === "DELETE" && p === "/talks/streams/tstrm_1") return json(200, {})
	return json(404, { kind: "NotFound", description: p })
}

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const cacheDir = path.join(ROOT, "cache", "did")
fs.rmSync(cacheDir, { recursive: true, force: true })

const av = await import("../../server/providers/avatarVideo.js")
const assert = (cond, msg) => {
	if (!cond) throw new Error("ASSERT: " + msg)
	console.log("  ok -", msg)
}

// 1. resolusi foto lokal
const local = av.resolveLocalPhoto("assets/avatar.jpg")
assert(local && local.buffer && local.mime === "image/jpeg", "assets/avatar.jpg terbaca sebagai JPG")
assert(av.resolveLocalPhoto("../../etc/passwd") === null, "path traversal ditolak")
assert(av.resolveLocalPhoto("https://cdn.example.com/x.jpg").url === "https://cdn.example.com/x.jpg", "URL publik dipakai langsung")
const dataUrl = "data:image/png;base64," + Buffer.from([137, 80, 78, 71]).toString("base64")
assert(av.resolveLocalPhoto(dataUrl).mime === "image/png", "data URL png terbaca")

// 2. stream agents: fluent ditolak -> stream biasa; agent dipoll sampai done
const s1 = await av.didCreateStream({ photoUrl: "assets/avatar.jpg" })
assert(s1.mode === "agents" && s1.agentId === "agt_1" && s1.id === "strm_1", "stream agents dibuat")
assert(s1.fluent === false && s1.notes.some((n) => n.includes("fluent")), "fallback fluent -> non-fluent tercatat")
assert(s1.offer && s1.offer.type === "offer", "offer dinormalisasi dari jsep")
assert(calls.filter((c) => c.p === "/images").length === 1, "foto diunggah ke /images sekali")
assert(calls.filter((c) => c.p === "/agents" && c.method === "POST").length === 1, "agent dibuat sekali")
assert(agentPolls >= 2, "status agent dipoll sampai done")

// 3. talk + delete
const talk = await av.didStreamTalk({ streamId: s1.id, agentId: s1.agentId, sessionId: s1.session_id, audioUrl: "https://s3.example/audio.mp3" })
assert(talk.status === "started", "talk agents terkirim")
const talkCall = calls.find((c) => c.p === "/agents/agt_1/streams/strm_1" && c.method === "POST")
assert(talkCall.body.script.audio_url === "https://s3.example/audio.mp3" && talkCall.body.session_id === "sess_1" && !talkCall.body.config, "body talk agents benar")
await av.didStreamIce({ streamId: s1.id, agentId: s1.agentId, sessionId: s1.session_id, candidate: null })
const iceCall = calls.find((c) => c.p.endsWith("/ice"))
assert(iceCall && !("candidate" in iceCall.body) && iceCall.body.session_id === "sess_1", "akhir kandidat ICE hanya kirim session_id")

// 4. stream kedua: cache foto & agent dipakai ulang, stream lama dihapus dulu
calls.length = 0
rejectFluent = false
const s2 = await av.didCreateStream({ photoUrl: "assets/avatar.jpg" })
assert(calls.some((c) => c.method === "DELETE" && c.p === "/agents/agt_1/streams/strm_1"), "stream lama dihapus")
assert(!calls.some((c) => c.p === "/images"), "foto dari cache (tidak unggah ulang)")
assert(!calls.some((c) => c.p === "/agents" && c.method === "POST"), "agent dari cache")
assert(s2.fluent === true, "fluent aktif saat didukung")

// 5. audio URL publik lewat ttsKey
process.env.PUBLIC_BASE_URL = "https://avatar.contoh.id/"
const { getConfig } = await import("../../server/config.js")
getConfig(true)
calls.length = 0
await av.didStreamTalk({ streamId: s2.id, agentId: s2.agentId, sessionId: s2.session_id, ttsKey: "a".repeat(40) })
assert(calls[0].body.script.audio_url === "https://avatar.contoh.id/tts-cache/" + "a".repeat(40) + ".mp3", "URL audio publik dari ttsKey")

// 6. fallback ke talks streams bila agents ditolak
agentsForbidden = true
fs.rmSync(cacheDir, { recursive: true, force: true })
calls.length = 0
const s3 = await av.didCreateStream({ photoUrl: "assets/avatar.jpg" })
assert(s3.mode === "talks" && s3.id === "tstrm_1", "fallback ke talks streams")
const talksCreate = calls.find((c) => c.p === "/talks/streams")
assert(talksCreate.body.stream_warmup === true && talksCreate.body.output_resolution === 512 && talksCreate.body.compatibility_mode === "auto", "opsi talks stream (warmup, resolusi, codec)")
const t3 = await av.didStreamTalk({ streamId: s3.id, agentId: null, sessionId: s3.session_id, audioUrl: "https://s3.example/audio.mp3" })
assert(t3.status === "started", "talk legacy terkirim")
const legacyTalk = calls.find((c) => c.p === "/talks/streams/tstrm_1" && c.method === "POST")
assert(legacyTalk.body.config && legacyTalk.body.config.stitch === true, "talk legacy memakai stitch")

// 7. upload audio
const up = await av.didUploadAudio(Buffer.from([1, 2, 3]), "audio/mpeg")
assert(up.url === "https://s3.example/audio.mp3", "upload audio ke /audios")

fs.rmSync(cacheDir, { recursive: true, force: true })
console.log("SMOKE D-ID SERVER OK")
process.exit(0)
