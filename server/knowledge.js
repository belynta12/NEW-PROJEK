import fs from "node:fs"
import path from "node:path"
import { getConfig } from "./config.js"

/**
 * "Otak pengetahuan pribadi" avatar.
 * Semua file .md / .txt di folder knowledge/ dipecah jadi potongan kecil,
 * lalu potongan yang paling relevan dengan pertanyaan diselipkan ke prompt.
 * Ringan, tanpa vector database.
 */

let chunks = []
let knowledgeDir = ""

const STOPWORDS = new Set([
	"yang", "dan", "di", "ke", "dari", "itu", "ini", "untuk", "dengan", "pada",
	"apa", "apakah", "siapa", "bagaimana", "kenapa", "mengapa", "kapan", "dimana",
	"saya", "aku", "kamu", "anda", "the", "a", "an", "is", "are", "of", "to", "in",
	"what", "who", "how", "why", "when", "where", "you", "your", "my",
])

function tokenize(text) {
	return String(text)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w))
}

function splitIntoChunks(text, source, size = 900) {
	const paragraphs = text.split(/\n{2,}/)
	const out = []
	let buffer = ""
	for (const paragraph of paragraphs) {
		if ((buffer + "\n\n" + paragraph).length > size && buffer) {
			out.push({ source, text: buffer.trim() })
			buffer = paragraph
		} else {
			buffer = buffer ? buffer + "\n\n" + paragraph : paragraph
		}
	}
	if (buffer.trim()) out.push({ source, text: buffer.trim() })
	return out
}

export function reloadKnowledge(dir) {
	if (dir) knowledgeDir = dir
	chunks = []
	try {
		if (!knowledgeDir || !fs.existsSync(knowledgeDir)) return { files: 0, chunks: 0 }
		const files = fs
			.readdirSync(knowledgeDir)
			.filter((f) => /\.(md|txt)$/i.test(f))
			.sort()
		for (const file of files) {
			const text = fs.readFileSync(path.join(knowledgeDir, file), "utf8")
			if (!text.trim()) continue
			chunks.push(...splitIntoChunks(text, file))
		}
		for (const chunk of chunks) chunk.tokens = new Set(tokenize(chunk.text))
		return { files: files.length, chunks: chunks.length }
	} catch (error) {
		console.warn("[knowledge] gagal memuat:", error.message)
		return { files: 0, chunks: 0 }
	}
}

export function retrieve(query, max = 5) {
	if (!chunks.length) return []
	const queryTokens = tokenize(query)
	if (!queryTokens.length) return chunks.slice(0, max)
	const scored = chunks.map((chunk) => {
		let score = 0
		for (const token of queryTokens) {
			if (chunk.tokens.has(token)) score += 2
			else if ([...chunk.tokens].some((t) => t.startsWith(token))) score += 1
		}
		return { chunk, score }
	})
	const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
	// Selalu sertakan file pertama (profil utama) sebagai konteks dasar.
	const base = chunks[0] ? [chunks[0]] : []
	const picked = [...base, ...hits.slice(0, max).map((h) => h.chunk)]
	return [...new Set(picked)].slice(0, max + 1)
}

export function knowledgeStats() {
	return { chunks: chunks.length }
}

export function buildSystemPrompt(userQuery = "") {
	const { persona } = getConfig()
	const context = retrieve(userQuery)
		.map((c) => `[${c.source}]\n${c.text}`)
		.join("\n\n---\n\n")

	return [
		`Kamu adalah "${persona.name}" - avatar digital AI interaktif yang berbicara langsung sebagai diri sendiri (gunakan kata "saya" atau "aku").`,
		`Karakter & gaya bicara: ${persona.style}. Ramah, cerdas, percaya diri, dan selalu memberikan jawaban yang jelas, informatif, dan tuntas.`,
		`Bahasa: ${persona.language}. Selalu gunakan tata bahasa Indonesia yang baik, lugas, enak didengar saat diucapkan, dan mudah dipahami.`,
		"",
		"PEDOMAN MENJAWAB (PENTING AGAR JAWABAN SANGAT JELAS):",
		"1. Jawab dengan LENGKAP, JELAS, dan TUNTAS. Jangan memberi jawaban yang menggantung, ambigu, atau terlalu singkat tanpa makna.",
		`2. Panjang jawaban ideal: 2 sampai 4 kalimat yang padat dan berbobot. Berikan penjelasan yang tepat sasaran.`,
		"3. JANGAN gunakan format markdown, bullet points, tanda bintang, tabel, angka Romawi, atau emoji (karena teks akan dibacakan suara oleh TTS).",
		"4. Tulis angka, singkatan, dan istilah asing dalam ejaan lisan yang mudah diucapkan dan dipahami pendengar.",
		"5. Jika ditanya identitas seperti 'kamu siapa', perkenalkan dirimu dengan jelas: 'Saya Nofal, asisten avatar AI kamu yang siap membantu menjawab pertanyaan, berdiskusi, dan mencari solusi untuk apa pun yang ingin kamu ketahui.'",
		"6. Jika pengguna bertanya tentang topik umum, sains, teknologi, tips, atau bantuan praktis, jawablah dengan wawasan yang akurat, informatif, dan solutif.",
		context ? `\nDATA PRIBADI & PENGETAHUAN TAMBAHAN:\n${context}` : "",
	].filter(Boolean).join("\n")
}
