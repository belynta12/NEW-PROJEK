import { getConfig } from "../config.js"

/** Suara pengunjung (webm/mp4/wav) -> teks. */
export async function transcribe(buffer, mimeType = "audio/webm") {
	const { stt } = getConfig()
	if (stt.provider === "browser") {
		throw new Error("STT_PROVIDER=browser: transkripsi dilakukan di browser, bukan di server.")
	}
	if (!stt.apiKey) throw new Error(`API key untuk STT (${stt.provider}) belum diisi di .env`)

	if (stt.provider === "deepgram") return transcribeDeepgram(buffer, mimeType, stt)
	return transcribeOpenAiCompatible(buffer, mimeType, stt)
}

function extFor(mimeType) {
	if (mimeType.includes("webm")) return "webm"
	if (mimeType.includes("ogg")) return "ogg"
	if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a"
	if (mimeType.includes("wav")) return "wav"
	if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3"
	return "webm"
}

async function transcribeOpenAiCompatible(buffer, mimeType, stt) {
	const form = new FormData()
	form.append("file", new Blob([buffer], { type: mimeType }), `audio.${extFor(mimeType)}`)
	form.append("model", stt.model)
	form.append("response_format", "json")
	if (stt.language) form.append("language", stt.language)

	const response = await fetch(`${stt.baseUrl}/audio/transcriptions`, {
		method: "POST",
		headers: { authorization: `Bearer ${stt.apiKey}` },
		body: form,
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`STT ${stt.provider} error ${response.status}: ${detail.slice(0, 300)}`)
	}
	const data = await response.json()
	return (data.text || "").trim()
}

async function transcribeDeepgram(buffer, mimeType, stt) {
	const url = new URL(stt.baseUrl)
	url.searchParams.set("model", stt.model)
	url.searchParams.set("smart_format", "true")
	if (stt.language) url.searchParams.set("language", stt.language)

	const response = await fetch(url, {
		method: "POST",
		headers: { authorization: `Token ${stt.apiKey}`, "content-type": mimeType },
		body: buffer,
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(`STT deepgram error ${response.status}: ${detail.slice(0, 300)}`)
	}
	const data = await response.json()
	return (data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim()
}
