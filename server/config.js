/**
 * Konfigurasi terpusat. Semua provider bisa diganti lewat .env
 * tanpa mengubah kode.
 */

const LLM_PRESETS = {
	groq: {
		baseUrl: "https://api.groq.com/openai/v1",
		model: "llama-3.3-70b-versatile",
		keyEnv: "GROQ_API_KEY",
		label: "Groq",
	},
	openai: {
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
		keyEnv: "OPENAI_API_KEY",
		label: "OpenAI",
	},
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		model: "meta-llama/llama-3.3-70b-instruct",
		keyEnv: "OPENROUTER_API_KEY",
		label: "OpenRouter",
	},
	gemini: {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		model: "gemini-2.0-flash",
		keyEnv: "GEMINI_API_KEY",
		label: "Google Gemini",
	},
	deepseek: {
		baseUrl: "https://api.deepseek.com/v1",
		model: "deepseek-chat",
		keyEnv: "DEEPSEEK_API_KEY",
		label: "DeepSeek",
	},
	ollama: {
		baseUrl: "http://localhost:11434/v1",
		model: "qwen2.5:7b",
		keyEnv: null,
		label: "Ollama (lokal, gratis)",
	},
}

const STT_PRESETS = {
	browser: { label: "Browser (Web Speech API, gratis)" },
	groq: {
		baseUrl: "https://api.groq.com/openai/v1",
		model: "whisper-large-v3-turbo",
		keyEnv: "GROQ_API_KEY",
		label: "Groq Whisper Turbo",
	},
	openai: {
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini-transcribe",
		keyEnv: "OPENAI_API_KEY",
		label: "OpenAI Transcribe",
	},
	deepgram: {
		baseUrl: "https://api.deepgram.com/v1/listen",
		model: "nova-2",
		keyEnv: "DEEPGRAM_API_KEY",
		label: "Deepgram Nova-2",
	},
}

const TTS_PRESETS = {
	edge: { label: "Edge TTS (Suara Cowok Macho Indonesia, gratis)", keyEnv: null },
	browser: { label: "Browser (SpeechSynthesis, gratis)" },
	elevenlabs: { label: "ElevenLabs (kloning suara Anda)", keyEnv: "ELEVENLABS_API_KEY" },
	fishaudio: { label: "Fish Audio (murah, kloning suara)", keyEnv: "FISHAUDIO_API_KEY" },
	openai: { label: "OpenAI TTS", keyEnv: "OPENAI_API_KEY" },
}

// Wajah contoh Simli ("Mark") bila SIMLI_FACE_ID kosong. Buat wajah sendiri: npm run simli-face -- foto.jpg
const SIMLI_PRESET_FACE = "804c347a-26c9-4dcf-bb49-13df4bed61e8"
// Avatar contoh Anam ("Cara") bila ANAM_AVATAR_ID kosong. Avatar dari foto Anda: lab.anam.ai -> Build -> Avatar
const ANAM_PRESET_AVATAR = "30fa96d0-26c4-4e55-94a0-517025942e18"

const num = (value, fallback) => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}
const str = (value, fallback = "") => (value && String(value).trim()) || fallback
const bool = (value, fallback = false) => {
	if (value === undefined || value === "") return fallback
	return ["1", "true", "yes", "on"].includes(String(value).toLowerCase())
}

function build() {
	const llmProvider = str(process.env.LLM_PROVIDER, "groq").toLowerCase()
	const llmPreset = LLM_PRESETS[llmProvider] || LLM_PRESETS.groq

	const sttProvider = str(process.env.STT_PROVIDER, "browser").toLowerCase()
	const sttPreset = STT_PRESETS[sttProvider] || STT_PRESETS.browser

	const ttsProvider = str(process.env.TTS_PROVIDER, "edge").toLowerCase()
	const ttsPreset = TTS_PRESETS[ttsProvider] || TTS_PRESETS.browser

	return {
		port: num(process.env.PORT, 8787),
		llm: {
			provider: llmProvider,
			label: llmPreset.label,
			baseUrl: str(process.env.LLM_BASE_URL, llmPreset.baseUrl),
			model: str(process.env.LLM_MODEL, llmPreset.model),
			apiKey: llmPreset.keyEnv ? str(process.env[llmPreset.keyEnv]) : "",
			needsKey: Boolean(llmPreset.keyEnv),
			temperature: num(process.env.LLM_TEMPERATURE, 0.6),
			maxTokens: num(process.env.LLM_MAX_TOKENS, 400),
		},
		stt: {
			provider: sttProvider,
			label: sttPreset.label,
			baseUrl: str(process.env.STT_BASE_URL, sttPreset.baseUrl),
			model: str(process.env.STT_MODEL, sttPreset.model),
			apiKey: sttPreset.keyEnv ? str(process.env[sttPreset.keyEnv]) : "",
			language: str(process.env.STT_LANGUAGE, "id"),
		},
		tts: {
			provider: ttsProvider,
			label: ttsPreset.label,
			cache: bool(process.env.TTS_CACHE, true),
			elevenlabs: {
				apiKey: str(process.env.ELEVENLABS_API_KEY),
				voiceId: str(process.env.ELEVENLABS_VOICE_ID),
				modelId: str(process.env.ELEVENLABS_MODEL_ID, "eleven_flash_v2_5"),
				stability: num(process.env.ELEVENLABS_STABILITY, 0.45),
				similarity: num(process.env.ELEVENLABS_SIMILARITY, 0.85),
				speed: num(process.env.ELEVENLABS_SPEED, 1),
			},
			fishaudio: {
				apiKey: str(process.env.FISHAUDIO_API_KEY),
				voiceId: str(process.env.FISHAUDIO_VOICE_ID),
			},
			openai: {
				apiKey: str(process.env.OPENAI_API_KEY),
				model: str(process.env.OPENAI_TTS_MODEL, "gpt-4o-mini-tts"),
				voice: str(process.env.OPENAI_TTS_VOICE, "alloy"),
			},
		},
		avatar: {
			mode: str(process.env.AVATAR_MODE, "puppet").toLowerCase(),
			simli: {
				apiKey: str(process.env.SIMLI_API_KEY),
				faceId: str(process.env.SIMLI_FACE_ID, SIMLI_PRESET_FACE),
				preset: !str(process.env.SIMLI_FACE_ID),
				// sesi Simli dihitung per menit tersambung (termasuk saat diam):
				// idle pendek = hemat kuota; sesi tersambung lagi otomatis saat pengguna bertanya
				maxSession: num(process.env.SIMLI_MAX_SESSION, 900),
				maxIdle: num(process.env.SIMLI_MAX_IDLE, 90),
			},
			anam: {
				apiKey: str(process.env.ANAM_API_KEY),
				avatarId: str(process.env.ANAM_AVATAR_ID, ANAM_PRESET_AVATAR),
				preset: !str(process.env.ANAM_AVATAR_ID),
				avatarModel: str(process.env.ANAM_AVATAR_MODEL, "cara-4"),
				// Anam menagih per detik sesi (termasuk diam) -> tutup sesi setelah idle sekian detik
				maxIdle: num(process.env.ANAM_MAX_IDLE, 90),
				// batas panjang sesi (detik); 0 = ikut batas paket (Free 3 mnt, Starter 5, Explorer 10)
				maxSession: num(process.env.ANAM_MAX_SESSION, 0),
			},
			heygen: {
				apiKey: str(process.env.HEYGEN_API_KEY),
				avatarId: str(process.env.HEYGEN_AVATAR_ID),
				voiceId: str(process.env.HEYGEN_VOICE_ID),
			},
			did: {
				apiKey: str(process.env.DID_API_KEY),
				sourceUrl: str(process.env.DID_SOURCE_URL),
				// agents = API terbaru (fluent idle, latensi lebih rendah) | talks = legacy
				mode: str(process.env.DID_MODE, "agents").toLowerCase() === "talks" ? "talks" : "agents",
				fluent: bool(process.env.DID_FLUENT, true),
				resolution: num(process.env.DID_RESOLUTION, 512),
				// URL publik server ini (https). Bila diisi, D-ID membaca audio TTS langsung dari
				// server (tanpa unggah ke D-ID dulu) -> mulai bicara lebih cepat.
				publicBaseUrl: str(process.env.PUBLIC_BASE_URL),
			},
		},
		vision: {
			// Deteksi wajah di browser (MediaPipe). Boleh diarahkan ke salinan lokal/CDN lain.
			tasksUrl: str(process.env.VISION_TASKS_URL, "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"),
			modelUrl: str(
				process.env.VISION_MODEL_URL,
				"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
			),
			detectorUrl: str(
				process.env.VISION_DETECTOR_URL,
				"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
			),
		},
		persona: {
			name: str(process.env.PERSONA_NAME, "Avatar Saya"),
			language: str(process.env.PERSONA_LANGUAGE, "Bahasa Indonesia"),
			style: str(
				process.env.PERSONA_STYLE,
				"pria keren, macho, berwibawa, santai, percaya diri, bicara to-the-point dan ramah seperti bro ngobrol santai",
			),
			maxSentences: num(process.env.PERSONA_MAX_SENTENCES, 3),
		},
	}
}

let cached = null

export function getConfig(force = false) {
	if (!cached || force) cached = build()
	return cached
}

/** Versi aman untuk dikirim ke browser (tanpa API key). */
export function publicConfig() {
	const c = getConfig()
	const ttsReady =
		c.tts.provider === "edge" ||
		c.tts.provider === "browser" ||
		(c.tts.provider === "elevenlabs" &&
			Boolean(c.tts.elevenlabs.apiKey && c.tts.elevenlabs.voiceId)) ||
		(c.tts.provider === "fishaudio" && Boolean(c.tts.fishaudio.apiKey)) ||
		(c.tts.provider === "openai" && Boolean(c.tts.openai.apiKey))

	return {
		persona: c.persona,
		avatarMode: c.avatar.mode,
		vision: c.vision,
		llm: {
			provider: c.llm.provider,
			label: Boolean(c.llm.apiKey) ? c.llm.label : `${c.llm.label} (Demo)`,
			model: c.llm.model,
			ready: true,
			online: !c.llm.needsKey || Boolean(c.llm.apiKey),
		},
		stt: {
			provider: c.stt.provider,
			label: c.stt.label,
			language: c.stt.language,
			ready: c.stt.provider === "browser" || Boolean(c.stt.apiKey),
		},
		tts: {
			provider: c.tts.provider,
			label: c.tts.label,
			ready: ttsReady,
		},
		heygenReady: Boolean(c.avatar.heygen.apiKey),
		didReady: Boolean(c.avatar.did.apiKey),
		did: {
			ready: Boolean(c.avatar.did.apiKey),
			mode: c.avatar.did.mode,
			fluent: c.avatar.did.fluent,
			publicAudio: Boolean(c.avatar.did.publicBaseUrl),
			hasSourceUrl: Boolean(c.avatar.did.sourceUrl),
		},
		anam: {
			ready: Boolean(c.avatar.anam.apiKey),
			avatarId: c.avatar.anam.avatarId,
			preset: c.avatar.anam.preset,
			avatarModel: c.avatar.anam.avatarModel,
			maxIdle: c.avatar.anam.maxIdle,
		},
		simliReady: Boolean(c.avatar.simli.apiKey),
		simli: {
			ready: Boolean(c.avatar.simli.apiKey),
			faceId: c.avatar.simli.faceId,
			preset: c.avatar.simli.preset,
			maxIdle: c.avatar.simli.maxIdle,
			maxSession: c.avatar.simli.maxSession,
		},
	}
}

export { LLM_PRESETS, STT_PRESETS, TTS_PRESETS }
