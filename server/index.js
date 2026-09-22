import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { loadEnv } from "./env.js"
import { getConfig, publicConfig } from "./config.js"
import * as llm from "./providers/llm.js"
import * as stt from "./providers/stt.js"
import * as tts from "./providers/tts.js"
import * as avatarVideo from "./providers/avatarVideo.js"
import { buildSystemPrompt, reloadKnowledge, knowledgeStats } from "./knowledge.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const PUBLIC_DIR = path.join(ROOT, "public")
const UPLOAD_DIR = path.join(ROOT, "uploads")
const CACHE_DIR = path.join(ROOT, "cache", "tts")
const KNOWLEDGE_DIR = path.join(ROOT, "knowledge")

loadEnv(path.join(ROOT, ".env"))
const config = getConfig(true)
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
tts.setCacheDir(CACHE_DIR)
const kb = reloadKnowledge(KNOWLEDGE_DIR)

const MAX_BODY = 30 * 1024 * 1024 // 30 MB (cukup untuk sample suara & foto)

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".webm": "audio/webm",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
	".task": "application/octet-stream",
	".tflite": "application/octet-stream",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
}

function sendJson(res, status, data) {
	const body = JSON.stringify(data)
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	})
	res.end(body)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on("data", (chunk) => {
			size += chunk.length
			if (size > MAX_BODY) {
				req.destroy()
				reject(new Error("Data terlalu besar (maks 30 MB)"))
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => resolve(Buffer.concat(chunks)))
		req.on("error", reject)
	})
}

async function readJson(req) {
	const buffer = await readBody(req)
	if (!buffer.length) return {}
	try {
		return JSON.parse(buffer.toString("utf8"))
	} catch {
		throw new Error("Body bukan JSON yang valid")
	}
}

function serveStatic(res, filePath) {
	fs.stat(filePath, (error, stat) => {
		if (error || !stat.isFile()) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
			res.end("404 - tidak ditemukan")
			return
		}
		const ext = path.extname(filePath).toLowerCase()
		const isCode = [".html", ".js", ".mjs", ".css", ".json"].includes(ext)
		const headers = {
			"content-type": MIME[ext] || "application/octet-stream",
			"content-length": stat.size,
			"cache-control": isCode ? "no-store, no-cache, must-revalidate, max-age=0" : "public, max-age=86400",
		}
		if (isCode) headers["pragma"] = "no-cache"
		res.writeHead(200, headers)
		fs.createReadStream(filePath).pipe(res)
	})
}

function sanitizeHistory(messages) {
	if (!Array.isArray(messages)) return []
	return messages
		.filter((m) => m && typeof m.content === "string" && ["user", "assistant"].includes(m.role))
		.slice(-12)
		.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
}

/* ------------------------------- ROUTES -------------------------------- */

async function handleChat(req, res, url) {
	const body = await readJson(req)
	const history = sanitizeHistory(body.messages)
	const lastUser = [...history].reverse().find((m) => m.role === "user")
	if (!lastUser) return sendJson(res, 400, { error: "Belum ada pesan dari pengguna" })
	if (!llm.isReady()) {
		return sendJson(res, 503, {
			error: `API key untuk LLM (${config.llm.provider}) belum diisi di .env`,
			hint: "Isi GROQ_API_KEY (gratis di console.groq.com) atau ganti LLM_PROVIDER",
		})
	}

	const messages = [{ role: "system", content: buildSystemPrompt(lastUser.content) }, ...history]
	const wantsStream = url.searchParams.get("stream") === "1"

	if (!wantsStream) {
		const reply = await llm.chat(messages)
		return sendJson(res, 200, { reply })
	}

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	})
	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	try {
		const full = await llm.chatStream(messages, (delta) => send("delta", { text: delta }))
		send("done", { text: full })
	} catch (error) {
		send("error", { message: error.message })
	}
	res.end()
}

async function handleStt(req, res, url) {
	const buffer = await readBody(req)
	if (!buffer.length) return sendJson(res, 400, { error: "Audio kosong" })
	const mimeType = url.searchParams.get("mime") || req.headers["content-type"] || "audio/webm"
	const text = await stt.transcribe(buffer, mimeType)
	sendJson(res, 200, { text })
}

async function handleTts(req, res) {
	const body = await readJson(req)
	const { buffer, contentType, cached } = await tts.synthesize(body.text)
	res.writeHead(200, {
		"content-type": contentType,
		"content-length": buffer.length,
		"x-tts-cache": cached ? "hit" : "miss",
		"cache-control": "no-store",
	})
	res.end(buffer)
}

async function handleVoiceClone(req, res, url) {
	const buffer = await readBody(req)
	if (buffer.length < 20000) {
		return sendJson(res, 400, {
			error: "Sample suara terlalu pendek. Rekam 1-3 menit bicara jelas tanpa musik.",
		})
	}
	const name = url.searchParams.get("name") || "Suara Saya"
	const mimeType = req.headers["content-type"] || "audio/mpeg"
	const fileName = mimeType.includes("webm") ? "sample.webm" : "sample.mp3"
	const result = await tts.cloneVoice({ buffer, fileName, mimeType, name })
	sendJson(res, 200, {
		voiceId: result.voiceId,
		note: "Simpan ke .env sebagai ELEVENLABS_VOICE_ID lalu restart server.",
	})
}

async function handlePhotoUpload(req, res) {
	const buffer = await readBody(req)
	if (!buffer.length) return sendJson(res, 400, { error: "Foto kosong" })
	const type = req.headers["content-type"] || "image/png"
	const ext = type.includes("jpeg") || type.includes("jpg")
		? ".jpg"
		: type.includes("webp")
			? ".webp"
			: ".png"
	const name = `avatar-${crypto.randomBytes(6).toString("hex")}${ext}`
	fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer)
	sendJson(res, 200, { url: `/uploads/${name}` })
}

const ROUTES = [
	["GET", "/api/health", async (req, res) => sendJson(res, 200, { ok: true, knowledge: knowledgeStats() })],
	["GET", "/api/config", async (req, res) => sendJson(res, 200, publicConfig())],
	["POST", "/api/chat", handleChat],
	["POST", "/api/stt", handleStt],
	["POST", "/api/tts", handleTts],
	["POST", "/api/voice/clone", handleVoiceClone],
	["GET", "/api/voices", async (req, res) => sendJson(res, 200, { voices: await tts.listVoices() })],
	["POST", "/api/upload/photo", handlePhotoUpload],
	[
		"POST",
		"/api/avatar/simli/token",
		async (req, res) => sendJson(res, 200, await avatarVideo.simliSessionToken()),
	],
	[
		"POST",
		"/api/avatar/heygen/token",
		async (req, res) => sendJson(res, 200, await avatarVideo.heygenSessionToken()),
	],
	[
		"GET",
		"/api/avatar/heygen/avatars",
		async (req, res) => sendJson(res, 200, { avatars: await avatarVideo.heygenAvatars() }),
	],
	[
		"POST",
		"/api/avatar/did/talk",
		async (req, res) => {
			const body = await readJson(req)
			sendJson(res, 200, await avatarVideo.didCreateTalk(body))
		},
	],
	[
		"GET",
		"/api/avatar/did/talk",
		async (req, res, url) => {
			const id = url.searchParams.get("id")
			if (!id) return sendJson(res, 400, { error: "Parameter id wajib" })
			sendJson(res, 200, await avatarVideo.didGetTalk(id))
		},
	],
	[
		"POST",
		"/api/knowledge/reload",
		async (req, res) => sendJson(res, 200, reloadKnowledge(KNOWLEDGE_DIR)),
	],
	// D-ID Streaming WebRTC
	["POST", "/api/avatar/did/stream", async (req, res) => sendJson(res, 200, await avatarVideo.didCreateStream())],
	[
		"POST",
		"/api/avatar/did/stream/sdp",
		async (req, res) => {
			const body = await readJson(req)
			sendJson(res, 200, await avatarVideo.didStreamSdp(body))
		},
	],
	[
		"POST",
		"/api/avatar/did/stream/ice",
		async (req, res) => {
			const body = await readJson(req)
			await avatarVideo.didStreamIce(body)
			sendJson(res, 200, { ok: true })
		},
	],
	[
		"POST",
		"/api/avatar/did/stream/talk",
		async (req, res) => {
			const body = await readJson(req)
			sendJson(res, 200, await avatarVideo.didStreamTalk(body))
		},
	],
	[
		"DELETE",
		"/api/avatar/did/stream",
		async (req, res) => {
			const body = await readJson(req)
			await avatarVideo.didDeleteStream(body)
			sendJson(res, 200, { ok: true })
		},
	],
	[
		"POST",
		"/api/avatar/did/audio",
		async (req, res) => {
			const buffer = await readBody(req)
			const mimeType = req.headers["content-type"] || "audio/mpeg"
			const result = await avatarVideo.didUploadAudio(buffer, mimeType)
			sendJson(res, 200, result)
		},
	],
]

process.on("uncaughtException", (err) => {
	console.error("[server error] uncaughtException:", err.message)
})
process.on("unhandledRejection", (reason) => {
	console.error("[server error] unhandledRejection:", reason?.message || reason)
})

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost")
	const pathname = decodeURIComponent(url.pathname)

	res.setHeader("access-control-allow-origin", "*")
	res.setHeader("access-control-allow-headers", "content-type")
	res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
	if (req.method === "OPTIONS") {
		res.writeHead(204)
		res.end()
		return
	}

	const route = ROUTES.find(([method, routePath]) => method === req.method && routePath === pathname)
	if (route) {
		try {
			await route[2](req, res, url)
		} catch (error) {
			console.error(`[api] ${pathname}:`, error.message)
			if (!res.headersSent) sendJson(res, 500, { error: error.message })
			else res.end()
		}
		return
	}

	if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Endpoint tidak ada" })

	// File statis
	if (pathname.startsWith("/uploads/")) {
		const target = path.join(UPLOAD_DIR, path.normalize(pathname.slice(9)).replace(/^(\.\.[/\\])+/, ""))
		if (!target.startsWith(UPLOAD_DIR)) return sendJson(res, 403, { error: "Akses ditolak" })
		return serveStatic(res, target)
	}
	const relative = pathname === "/" ? "index.html" : path.normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "")
	const target = path.join(PUBLIC_DIR, relative)
	if (!target.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Akses ditolak" })
	serveStatic(res, target)
})

server.listen(config.port, () => {
	const line = (label, value) => console.log(`  ${label.padEnd(9)} ${value}`)
	console.log("\n  AVATAR AI LIFETIME siap.")
	console.log(`  http://localhost:${config.port}\n`)
	line("Otak", `${config.llm.label} (${config.llm.model}) ${llm.hasApiKey() ? "OK (Online)" : "Mode Demo (Siap)"}`)
	line("Dengar", config.stt.label)
	line("Suara", config.tts.label)
	line("Avatar", config.avatar.mode)
	line("Data", `${kb.files} file, ${kb.chunks} potongan pengetahuan`)
	console.log("")
})
