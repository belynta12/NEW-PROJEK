/**
 * QA offline: uji lipsync dengan audio TTS sungguhan.
 * Pakai: node scripts/qa/lipsync-strip.mjs <pcm_f32le_mono_16k.raw> "<teks>" <rgb.raw> <W> <H> <landmarks.json> <outdir>
 * Mencetak segmen viseme dan merender potongan mulut pada 12 waktu.
 */
import fs from "node:fs"
import path from "node:path"
import { analyzeEnvelope, buildTrack, normalizeSpeechText } from "../../public/js/lipsync.js"
import { buildRigFromLandmarks, buildMesh, deformMesh, defaultAnim } from "../../public/js/mesh.js"

const [, , pcmPath, text, rgbPath, Ws, Hs, lmPath, outDir] = process.argv
const W = Number(Ws)
const H = Number(Hs)
const pcmBuf = fs.readFileSync(pcmPath)
const samples = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 4))
const info = analyzeEnvelope(samples, 16000)
console.log(`audio ${info.duration.toFixed(2)}s speech ${info.speechStart.toFixed(2)}..${info.speechEnd.toFixed(2)} peaks=${info.peaks.map((p) => p.toFixed(2)).join(",")}`)
const track = buildTrack(normalizeSpeechText(text), { envInfo: info })
console.log("segmen:", track.segs.map((s) => `${s.v}@${s.t0.toFixed(2)}`).join(" "))

const tex = fs.readFileSync(rgbPath)
const lm = JSON.parse(fs.readFileSync(lmPath, "utf8")).map(([x, y, z]) => ({ x, y, z }))
const mesh = buildMesh(buildRigFromLandmarks(lm, W, H))
const pos = new Float32Array(mesh.n * 2)

function sample(u, v, out, o) {
	const x = Math.max(0, Math.min(W - 1.001, u * W - 0.5))
	const y = Math.max(0, Math.min(H - 1.001, v * H - 0.5))
	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	const fx = x - x0
	const fy = y - y0
	const i00 = (y0 * W + x0) * 3
	for (let c = 0; c < 3; c++) {
		const top = tex[i00 + c] * (1 - fx) + tex[i00 + 3 + c] * fx
		const bot = tex[i00 + W * 3 + c] * (1 - fx) + tex[i00 + W * 3 + 3 + c] * fx
		out[o + c] = Math.round(top * (1 - fy) + bot * fy)
	}
}
const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax)
function render(crop) {
	const [cx0, cy0, cw, ch] = crop
	const out = new Uint8Array(cw * ch * 3).fill(40)
	const { tris, uv } = mesh
	for (let t = 0; t < tris.length; t += 3) {
		const i0 = tris[t]
		const i1 = tris[t + 1]
		const i2 = tris[t + 2]
		const x0 = pos[i0 * 2] - cx0
		const y0 = pos[i0 * 2 + 1] - cy0
		const x1 = pos[i1 * 2] - cx0
		const y1 = pos[i1 * 2 + 1] - cy0
		const x2 = pos[i2 * 2] - cx0
		const y2 = pos[i2 * 2 + 1] - cy0
		const area = edge(x0, y0, x1, y1, x2, y2)
		if (Math.abs(area) < 1e-9) continue
		const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
		const maxX = Math.min(cw - 1, Math.ceil(Math.max(x0, x1, x2)))
		const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
		const maxY = Math.min(ch - 1, Math.ceil(Math.max(y0, y1, y2)))
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				const px = x + 0.5
				const py = y + 0.5
				const w0 = edge(x1, y1, x2, y2, px, py) / area
				const w1 = edge(x2, y2, x0, y0, px, py) / area
				const w2 = 1 - w0 - w1
				if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
				sample(w0 * uv[i0 * 2] + w1 * uv[i1 * 2] + w2 * uv[i2 * 2], w0 * uv[i0 * 2 + 1] + w1 * uv[i1 * 2 + 1] + w2 * uv[i2 * 2 + 1], out, (y * cw + x) * 3)
			}
		}
	}
	// rongga + gigi sederhana
	const inner = mesh.lips.inner.map((i) => [pos[i * 2] - cx0, pos[i * 2 + 1] - cy0])
	let maxGap = 0
	for (let k = 1; k <= 9; k++) maxGap = Math.max(maxGap, inner[k][1] - inner[20 - k][1])
	if (maxGap > 0.7) {
		const inPoly = (poly, px, py) => {
			let inside = false
			for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
				const [xi, yi] = poly[i]
				const [xj, yj] = poly[j]
				if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
			}
			return inside
		}
		const upper = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0].map((k) => inner[k])
		const toothH = mesh.lips.hw * 0.3
		const teeth = [...upper, ...upper.slice().reverse().map(([x, y]) => [x, y + toothH])]
		for (let y = 0; y < ch; y++) {
			for (let x = 0; x < cw; x++) {
				const px = x + 0.5
				const py = y + 0.5
				if (!inPoly(inner, px, py)) continue
				const o = (y * cw + x) * 3
				out[o] = 38
				out[o + 1] = 10
				out[o + 2] = 12
				if (inPoly(teeth, px, py)) {
					out[o] = 236
					out[o + 1] = 230
					out[o + 2] = 218
				}
			}
		}
	}
	return out
}

fs.mkdirSync(outDir, { recursive: true })
const crop = [140, 190, 140, 90]
const N = 12
const t0 = info.speechStart
const t1 = info.speechEnd
for (let i = 0; i < N; i++) {
	const t = t0 + ((i + 0.5) / N) * (t1 - t0)
	const p = track.at(t)
	const anim = { ...defaultAnim(), jaw: p.jaw, wide: p.wide, round: p.round, press: p.press, lowerLipIn: p.lowerLipIn, upperRaise: p.upperRaise }
	deformMesh(mesh, anim, pos, { jawScale: 1 })
	const seg = track.segs[track.cursor]
	console.log(`t=${t.toFixed(2)} ${seg ? seg.v : "-"} jaw=${p.jaw.toFixed(2)} wide=${p.wide.toFixed(2)} round=${p.round.toFixed(2)} press=${p.press.toFixed(2)} e=${p.energy.toFixed(2)}`)
	const out = render(crop)
	const header = Buffer.from(`P6\n${crop[2]} ${crop[3]}\n255\n`)
	fs.writeFileSync(path.join(outDir, `strip-${String(i).padStart(2, "0")}-${seg ? seg.v : "x"}.ppm`), Buffer.concat([header, Buffer.from(out.buffer)]))
}
