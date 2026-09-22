/**
 * lipsync.js - viseme (bentuk mulut) dari TEKS + AUDIO.
 *
 * Bebas DOM. Alur:
 *   teks kalimat  -> textToPhones()   -> urutan fonem + bobot durasi
 *   audio (PCM)   -> analyzeEnvelope() -> amplop energi, wilayah bicara, puncak suku kata
 *   keduanya      -> alignPhones()     -> segmen viseme berwaktu (detik)
 *   saat diputar  -> VisemeTrack.at(t) -> parameter mulut yang sudah dihaluskan
 *
 * Bahasa Indonesia hampir fonetik, jadi huruf ~ fonem. Vokal a/i/u/e/o punya
 * bentuk mulut berbeda; konsonan bilabial (m,b,p) menutup bibir; f/v bibir
 * bawah masuk; s/z/c/j gigi rapat; dst.
 *
 * Penyelarasan: frasa (dipisah tanda baca) dipetakan ke wilayah bicara pada
 * audio (dipisah jeda sunyi), lalu vokal ditarik ke puncak energi terdekat.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export const VISEME = {
	rest: { jaw: 0.02, wide: 0.0, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.0 },
	A: { jaw: 0.85, wide: 0.15, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.1 },
	I: { jaw: 0.22, wide: 0.9, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.35 },
	U: { jaw: 0.28, wide: 0.0, round: 1.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.0 },
	E: { jaw: 0.45, wide: 0.55, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.15 },
	O: { jaw: 0.6, wide: 0.0, round: 0.75, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.0 },
	MBP: { jaw: 0.0, wide: 0.0, round: 0.05, press: 0.7, lowerLipIn: 0.0, upperRaise: 0.0 },
	FV: { jaw: 0.25, wide: 0.15, round: 0.0, press: 0.0, lowerLipIn: 0.6, upperRaise: 0.2 },
	S: { jaw: 0.15, wide: 0.45, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.35 },
	TDN: { jaw: 0.25, wide: 0.25, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.05 },
	KG: { jaw: 0.35, wide: 0.1, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.0 },
	W: { jaw: 0.2, wide: 0.0, round: 0.85, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.0 },
	Y: { jaw: 0.2, wide: 0.7, round: 0.0, press: 0.0, lowerLipIn: 0.0, upperRaise: 0.15 },
}
const PARAM_KEYS = ["jaw", "wide", "round", "press", "lowerLipIn", "upperRaise"]

const VOWEL = { a: "A", i: "I", u: "U", e: "E", o: "O" }
const CONSONANT = {
	m: "MBP", b: "MBP", p: "MBP",
	f: "FV", v: "FV",
	s: "S", z: "S", c: "S", j: "S", x: "S",
	t: "TDN", d: "TDN", n: "TDN", l: "TDN", r: "TDN",
	k: "KG", g: "KG", h: "KG", q: "KG",
	w: "W", y: "Y",
}
const WEIGHT = { A: 1.15, O: 1.1, U: 1.0, E: 1.0, I: 0.95, MBP: 0.6, FV: 0.6, S: 0.55, TDN: 0.5, KG: 0.5, W: 0.5, Y: 0.5, rest: 1 }
const DIGITS = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"]

/** Normalisasi teks untuk diucapkan: huruf kecil, angka -> kata, buang simbol. */
export function normalizeSpeechText(text) {
	return String(text || "")
		.toLowerCase()
		.replace(/[0-9]/g, (d) => " " + DIGITS[Number(d)] + " ")
		.replace(/[*_`#>"'()\[\]{}]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * Teks -> daftar fonem: [{ v, w, vowel, char, word, pause?, gap? }]
 *  pause = tanda baca (kemungkinan jeda di audio), gap = spasi antar kata
 */
export function textToPhones(rawText) {
	const text = String(rawText || "").toLowerCase()
	const phones = []
	let word = 0
	let inWord = false
	let lastWasSpace = true
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		const next = text[i + 1] || ""
		if (/[0-9]/.test(ch)) {
			if (!inWord) {
				word++
				inWord = true
			}
			for (const c of DIGITS[Number(ch)]) pushLetter(c, "", i)
			lastWasSpace = false
			continue
		}
		if (/[.!?]/.test(ch)) {
			pushPause(i, 1.8)
			continue
		}
		if (/[,;:\n]/.test(ch) || (ch === "-" && !(/[a-z]/.test(next) && /[a-z]/.test(text[i - 1] || "")))) {
			pushPause(i, 0.9)
			continue
		}
		if (/\s/.test(ch)) {
			// antar kata tidak ada penutupan mulut; fonem terakhir kata sedikit memanjang
			if (!lastWasSpace && phones.length) {
				const last = phones[phones.length - 1]
				if (!last.pause) last.w += 0.15
			}
			inWord = false
			lastWasSpace = true
			continue
		}
		if (!/[a-z]/.test(ch)) continue
		if (!inWord) {
			word++
			inWord = true
		}
		lastWasSpace = false
		if (ch === "n" && next === "g") {
			phones.push({ v: "KG", w: 0.55, vowel: false, char: i, word })
			i++
			continue
		}
		if (ch === "n" && next === "y") {
			phones.push({ v: "TDN", w: 0.5, vowel: false, char: i, word })
			i++
			continue
		}
		if (ch === "s" && next === "y") {
			phones.push({ v: "S", w: 0.55, vowel: false, char: i, word })
			i++
			continue
		}
		if (ch === "k" && next === "h") {
			phones.push({ v: "KG", w: 0.5, vowel: false, char: i, word })
			i++
			continue
		}
		pushLetter(ch, next, i)
	}
	while (phones.length && (phones[phones.length - 1].gap || phones[phones.length - 1].pause)) phones.pop()
	while (phones.length && (phones[0].gap || phones[0].pause)) phones.shift()
	return phones

	function pushPause(i, w) {
		// gabungkan tanda baca berurutan ("...", "?!") jadi satu jeda
		const last = phones[phones.length - 1]
		if (last && last.pause) {
			last.w = Math.max(last.w, w)
			return
		}
		phones.push({ v: "rest", w, vowel: false, char: i, word, pause: true })
		inWord = false
		lastWasSpace = true
	}

	function pushLetter(ch, next, i) {
		if (VOWEL[ch]) {
			phones.push({ v: VOWEL[ch], w: WEIGHT[VOWEL[ch]], vowel: true, char: i, word })
			return
		}
		const v = CONSONANT[ch]
		if (!v) return
		const prev = phones[phones.length - 1]
		const w = prev && !prev.vowel && !prev.gap && !prev.pause ? WEIGHT[v] * 0.75 : WEIGHT[v]
		phones.push({ v, w, vowel: false, char: i, word })
	}
}

/** Perkiraan durasi ucapan (detik) bila tidak ada audio: ~13.5 huruf/detik pada rate 1. */
export function estimateDuration(text, rate = 1) {
	const n = normalizeSpeechText(text).length
	return Math.max(0.4, n / (13.5 * clamp(rate, 0.5, 2)))
}

/**
 * Amplop energi dari PCM mono.
 * @returns {{env, hop, duration, speechStart, speechEnd, peaks, regions}}
 *  regions = wilayah bicara [{t0,t1}] dipisah jeda sunyi >= 150 ms
 */
export function analyzeEnvelope(samples, sampleRate, hopSec = 0.01, winSec = 0.025) {
	const hop = Math.max(1, Math.round(sampleRate * hopSec))
	const win = Math.max(hop, Math.round(sampleRate * winSec))
	const frames = Math.max(1, Math.floor((samples.length - win) / hop) + 1)
	const raw = new Float32Array(frames)
	for (let f = 0; f < frames; f++) {
		const start = f * hop
		let sum = 0
		for (let i = 0; i < win; i++) {
			const s = samples[start + i] || 0
			sum += s * s
		}
		raw[f] = Math.sqrt(sum / win)
	}
	const env = new Float32Array(frames)
	for (let f = 0; f < frames; f++) {
		const a = raw[Math.max(0, f - 1)]
		const b = raw[f]
		const c = raw[Math.min(frames - 1, f + 1)]
		env[f] = a * 0.25 + b * 0.5 + c * 0.25
	}
	const sorted = Array.from(env).sort((x, y) => x - y)
	const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
	const norm = p95 > 1e-5 ? 1 / p95 : 0
	for (let f = 0; f < frames; f++) env[f] = Math.min(1.25, env[f] * norm)

	const duration = samples.length / sampleRate
	const thr = 0.12
	// wilayah bicara: frame > thr, celah < 150 ms digabung, wilayah < 80 ms dibuang
	const regions = []
	let cur = null
	for (let f = 0; f < frames; f++) {
		if (env[f] > thr) {
			if (!cur) cur = { f0: f, f1: f }
			cur.f1 = f
		} else if (cur && f - cur.f1 > Math.round(0.15 / hopSec)) {
			regions.push(cur)
			cur = null
		}
	}
	if (cur) regions.push(cur)
	const out = regions
		.map((r) => ({ t0: Math.max(0, r.f0 * hopSec - 0.02), t1: Math.min(duration, (r.f1 + 1) * hopSec + 0.03) }))
		.filter((r) => r.t1 - r.t0 >= 0.08)
	const speechStart = out.length ? out[0].t0 : 0
	const speechEnd = out.length ? out[out.length - 1].t1 : duration

	const peaks = []
	const minGap = Math.round(0.08 / hopSec)
	for (let f = 1; f < frames - 1; f++) {
		if (env[f] < 0.3) continue
		if (env[f] >= env[f - 1] && env[f] > env[f + 1]) {
			const t = (f + 0.5) * hopSec
			if (peaks.length && f - peaks[peaks.length - 1].f < minGap) {
				if (env[f] > peaks[peaks.length - 1].e) peaks[peaks.length - 1] = { f, t, e: env[f] }
			} else peaks.push({ f, t, e: env[f] })
		}
	}
	return { env, hop: hopSec, duration, speechStart, speechEnd, peaks: peaks.map((p) => p.t), regions: out }
}

/** Tempatkan fonem secara proporsional di [tStart,tEnd], vokal ditarik ke puncak (monoton). */
function placePhones(phones, tStart, tEnd, peaks) {
	const times = new Array(phones.length + 1)
	if (!phones.length) return times
	const total = phones.reduce((s, p) => s + p.w, 0) || 1
	const span = Math.max(0.05, tEnd - tStart)
	const centers = new Array(phones.length)
	let acc = 0
	for (let i = 0; i < phones.length; i++) {
		centers[i] = tStart + ((acc + phones[i].w / 2) / total) * span
		acc += phones[i].w
	}
	const anchors = []
	if (peaks && peaks.length) {
		const nVowel = phones.filter((p) => p.vowel).length
		const tol = Math.min(0.16, 0.06 + span / Math.max(1, nVowel) * 0.5)
		let k = 0
		for (let i = 0; i < phones.length; i++) {
			if (!phones[i].vowel) continue
			let best = -1
			let bestD = Infinity
			for (let j = k; j < peaks.length; j++) {
				const d = Math.abs(peaks[j] - centers[i])
				if (d < bestD) {
					bestD = d
					best = j
				}
				if (peaks[j] > centers[i] + tol) break
			}
			if (best >= 0 && bestD <= tol) {
				anchors.push({ i, t: peaks[best] })
				k = best + 1
			}
		}
	}
	const fill = (i0, t0, i1, t1) => {
		let w = 0
		for (let i = i0; i < i1; i++) w += phones[i].w
		let a = 0
		times[i0] = t0
		for (let i = i0; i < i1; i++) {
			a += phones[i].w
			times[i + 1] = t0 + (w > 0 ? (a / w) * (t1 - t0) : 0)
		}
	}
	if (!anchors.length) {
		fill(0, tStart, phones.length, tEnd)
		return times
	}
	const scale = span / total
	let prevIdx = 0
	let prevT = tStart
	for (const an of anchors) {
		const half = (phones[an.i].w * scale) / 2
		const startT = Math.max(prevT + 0.02, an.t - half)
		fill(prevIdx, prevT, an.i, startT)
		prevIdx = an.i
		prevT = startT
	}
	fill(prevIdx, prevT, phones.length, Math.max(prevT + 0.05, tEnd))
	return times
}

/**
 * Sejajarkan fonem dengan audio.
 * @returns segmen [{t0, t1, v, char, vowel, word}]
 */
export function alignPhones(phones, tStart, tEnd, envInfo = null) {
	if (!phones.length) return []
	const toSegs = (list, times) =>
		list.map((p, i) => ({
			t0: times[i],
			t1: Math.max(times[i] + 0.015, times[i + 1]),
			v: p.v,
			char: p.char,
			vowel: p.vowel,
			word: p.word,
		}))

	const regions = envInfo && envInfo.regions && envInfo.regions.length ? envInfo.regions.slice() : null
	if (!regions) {
		const times = placePhones(phones, tStart, tEnd, envInfo ? envInfo.peaks : null)
		return toSegs(phones, times)
	}

	// frasa = fonem di antara tanda baca
	const phrases = []
	let curPh = []
	for (const p of phones) {
		if (p.pause) {
			if (curPh.length) phrases.push({ phones: curPh, w: curPh.reduce((s, q) => s + q.w, 0), pauseW: p.w })
			curPh = []
		} else curPh.push(p)
	}
	if (curPh.length) phrases.push({ phones: curPh, w: curPh.reduce((s, q) => s + q.w, 0), pauseW: 0 })
	if (!phrases.length) return []

	// samakan jumlah frasa dan wilayah bicara
	while (phrases.length > regions.length && phrases.length > 1) {
		// gabungkan pasangan frasa dengan jeda paling lemah (koma dulu), lalu bobot gabungan terkecil
		let best = 0
		let bestScore = Infinity
		for (let i = 0; i < phrases.length - 1; i++) {
			const score = phrases[i].pauseW * 10 + phrases[i].w + phrases[i + 1].w
			if (score < bestScore) {
				bestScore = score
				best = i
			}
		}
		const a = phrases[best]
		const b = phrases[best + 1]
		const gap = { v: "rest", w: Math.min(0.5, a.pauseW * 0.35), vowel: false, char: b.phones[0].char, word: b.phones[0].word, gap: true }
		phrases.splice(best, 2, { phones: [...a.phones, gap, ...b.phones], w: a.w + gap.w + b.w, pauseW: b.pauseW })
	}
	while (regions.length > phrases.length && regions.length > 1) {
		// gabungkan dua wilayah dengan celah tersempit
		let best = 0
		let bestGap = Infinity
		for (let i = 0; i < regions.length - 1; i++) {
			const gap = regions[i + 1].t0 - regions[i].t1
			if (gap < bestGap) {
				bestGap = gap
				best = i
			}
		}
		regions.splice(best, 2, { t0: regions[best].t0, t1: regions[best + 1].t1 })
	}

	const segs = []
	const peaks = envInfo.peaks || []
	for (let i = 0; i < phrases.length; i++) {
		const ph = phrases[i]
		const r = regions[i]
		const localPeaks = peaks.filter((t) => t >= r.t0 && t <= r.t1)
		const times = placePhones(ph.phones, r.t0, r.t1, localPeaks)
		if (i > 0) {
			const prev = segs[segs.length - 1]
			if (prev && r.t0 > prev.t1 + 0.01) segs.push({ t0: prev.t1, t1: r.t0, v: "rest", char: ph.phones[0].char, vowel: false, word: ph.phones[0].word })
		}
		segs.push(...toSegs(ph.phones, times))
	}
	return segs
}

/** Bangun track dari teks + (opsional) amplop audio. */
export function buildTrack(text, { envInfo = null, duration = null, rate = 1 } = {}) {
	const phones = textToPhones(text)
	const dur = envInfo ? envInfo.duration : duration || estimateDuration(text, rate)
	const tStart = envInfo ? envInfo.speechStart : 0.03
	const tEnd = envInfo ? envInfo.speechEnd : Math.max(0.1, dur - 0.05)
	const segs = alignPhones(phones, tStart, tEnd, envInfo)
	return new VisemeTrack(segs, envInfo, dur)
}

export class VisemeTrack {
	constructor(segments, envInfo, duration) {
		this.segs = segments
		this.env = envInfo
		this.duration = duration
		this.lookahead = 0.045
		this.cursor = 0
	}

	/** Energi ternormalisasi (0..1) pada waktu t. */
	energyAt(t) {
		if (!this.env) return t >= 0 && t <= this.duration ? 1 : 0
		const f = t / this.env.hop - 0.5
		const i = Math.floor(f)
		const env = this.env.env
		if (i < 0) return env[0] || 0
		if (i >= env.length - 1) return env[env.length - 1] || 0
		const fr = f - i
		return env[i] * (1 - fr) + env[i + 1] * fr
	}

	/** Waktu mulai segmen pertama yang indeks hurufnya >= charIndex (untuk onboundary). */
	timeOfChar(charIndex) {
		for (const s of this.segs) if (s.char >= charIndex) return s.t0
		return null
	}

	/**
	 * Parameter mulut pada waktu t (detik dari awal audio).
	 * Hasil: { jaw, wide, round, press, lowerLipIn, upperRaise, energy, active }
	 */
	at(t) {
		const tt = t + this.lookahead
		const segs = this.segs
		const out = { jaw: 0, wide: 0, round: 0, press: 0, lowerLipIn: 0, upperRaise: 0, energy: 0, active: false }
		if (!segs.length) return out
		let i = this.cursor
		if (i >= segs.length || tt < segs[i].t0) i = 0
		while (i < segs.length - 1 && tt >= segs[i].t1) i++
		this.cursor = i
		const cur = segs[i]
		let a = VISEME[cur.v] || VISEME.rest
		let b = null
		let mix = 0
		if (tt < cur.t0) {
			b = a
			a = VISEME.rest
			mix = clamp(1 - (cur.t0 - tt) / 0.08, 0, 1)
		} else if (tt > cur.t1) {
			b = VISEME.rest
			mix = clamp((tt - cur.t1) / 0.1, 0, 1)
		} else {
			const len = cur.t1 - cur.t0
			const tw = Math.min(0.07, len * 0.5)
			if (tt < cur.t0 + tw && i > 0) {
				b = VISEME[segs[i - 1].v] || VISEME.rest
				mix = 0.5 - 0.5 * ((tt - cur.t0) / tw)
			} else if (tt > cur.t1 - tw && i < segs.length - 1) {
				b = VISEME[segs[i + 1].v] || VISEME.rest
				mix = 0.5 * ((tt - (cur.t1 - tw)) / tw)
			}
		}
		for (const k of PARAM_KEYS) out[k] = b ? a[k] * (1 - mix) + b[k] * mix : a[k]

		const e = clamp(this.energyAt(t), 0, 1)
		out.energy = e
		out.active = t >= 0 && t <= this.duration
		if (this.env) {
			const gate = e < 0.06 ? 0.2 : 0.45 + 0.55 * Math.pow(e, 0.6)
			out.jaw *= gate
			const shape = 0.55 + 0.45 * Math.pow(e, 0.5)
			out.wide *= shape
			out.round *= shape
			out.upperRaise *= shape
		} else {
			out.jaw *= 0.75 + 0.25 * Math.sin(t * 9.1)
		}
		return out
	}
}
