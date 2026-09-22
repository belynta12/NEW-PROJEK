import { getConfig } from "../config.js"
import { retrieve } from "../knowledge.js"

/**
 * Semua provider LLM di sini memakai format OpenAI-compatible
 * (/chat/completions), jadi Groq, OpenRouter, Gemini, DeepSeek, Ollama,
 * dan OpenAI bisa dipakai dengan kode yang sama.
 */

function headers() {
	const { llm } = getConfig()
	const h = { "content-type": "application/json" }
	if (llm.apiKey) h.authorization = `Bearer ${llm.apiKey}`
	if (llm.provider === "openrouter") {
		h["http-referer"] = "http://localhost"
		h["x-title"] = "Avatar AI Lifetime"
	}
	return h
}

export function hasApiKey() {
	const { llm } = getConfig()
	return !llm.needsKey || Boolean(llm.apiKey)
}

export function isReady() {
	return true
}

function generateLocalReply(messages) {
	const { persona } = getConfig()
	const lastUser = [...messages].reverse().find((m) => m.role === "user")
	const text = (lastUser?.content || "").trim().toLowerCase()

	// 1. Pertanyaan sapaan
	if (/^(halo|hai|hey|hi|selamat|assalam|pagi|siang|sore|malam)/i.test(text)) {
		return `Halo! Saya adalah ${persona.name}. Senang bisa berbicara dengan Anda. Ada yang bisa saya bantu hari ini?`
	}

	// 2. Pertanyaan identitas
	if (/(siapa kamu|namamu|siapa anda|kamu siapa|nama kamu|tentang kamu|profil)/i.test(text)) {
		return "Saya Nofal, asisten avatar AI pribadi Anda. Saya siap membantu menjawab berbagai pertanyaan, berdiskusi, serta memberikan solusi dengan jelas dan tuntas. Ada yang ingin Anda diskusikan?"
	}

	// 3. Pertanyaan kabar
	if (/(apa kabar|bagaimana kabarmu|gimana kabarmu|sehat)/i.test(text)) {
		return "Kabar saya luar biasa baik dan selalu siap membantu Anda! Bagaimana dengan Anda hari ini?"
	}

	// 4. Uji coba suara / bicara
	if (/(tes|test|cek suara|ngomong|bicara|coba bicara)/i.test(text)) {
		return "Tes suara berhasil! Gerakan mulut dan ekspresi saya sudah sinkron dengan suara yang Anda dengar."
	}

	// 5. Cek kecocokan di knowledge base
	const hits = retrieve(text, 2)
	if (hits.length > 0 && hits[0].text) {
		const snippet = hits[0].text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 3).join(" ")
		if (snippet) return snippet
	}

	// 6. Respon percakapan umum
	return `Halo! Saya mendengarkan pertanyaan Anda: "${lastUser?.content}". Saat ini saya berjalan dalam mode demo interaktif. Untuk mengaktifkan jawaban cerdas tentang segala hal, Anda dapat menambahkan API key gratis dari console.groq.com ke file .env.`
}

async function request(messages, stream) {
	const { llm } = getConfig()
	const response = await fetch(`${llm.baseUrl}/chat/completions`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			model: llm.model,
			messages,
			temperature: llm.temperature,
			max_tokens: llm.maxTokens,
			stream: Boolean(stream),
		}),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`LLM ${llm.provider} error ${response.status}: ${detail.slice(0, 400)}`)
	}
	return response
}

/** Jawaban sekali kirim (non-streaming). */
export async function chat(messages) {
	if (!hasApiKey()) {
		return generateLocalReply(messages)
	}
	const response = await request(messages, false)
	const data = await response.json()
	return data?.choices?.[0]?.message?.content?.trim() || ""
}

/**
 * Streaming token demi token supaya avatar bisa mulai bicara
 * sebelum seluruh jawaban selesai dibuat.
 */
export async function chatStream(messages, onDelta) {
	if (!hasApiKey()) {
		const reply = generateLocalReply(messages)
		const words = reply.split(" ")
		for (let i = 0; i < words.length; i++) {
			const word = (i === 0 ? "" : " ") + words[i]
			await onDelta(word)
			await new Promise((r) => setTimeout(r, 40))
		}
		return reply
	}

	const response = await request(messages, true)
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	let full = ""

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		const lines = buffer.split("\n")
		buffer = lines.pop() || ""
		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed.startsWith("data:")) continue
			const payload = trimmed.slice(5).trim()
			if (!payload || payload === "[DONE]") continue
			try {
				const json = JSON.parse(payload)
				const delta = json?.choices?.[0]?.delta?.content
				if (delta) {
					full += delta
					await onDelta(delta)
				}
			} catch {
				/* potongan JSON belum lengkap - abaikan */
			}
		}
	}
	return full.trim()
}
