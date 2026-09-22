/**
 * mesh.js - geometri wajah untuk PhotoPuppet v2.
 *
 * Bebas DOM (bisa dijalankan di Node untuk pengujian). Berisi:
 *  - LM              : indeks landmark MediaPipe FaceLandmarker (478 titik)
 *  - buildRigFromLandmarks / buildRigFromTemplate : rig semantik wajah
 *  - buildMesh       : rig -> mesh segitiga (Delaunay) + bobot animasi per titik
 *  - deformMesh      : parameter animasi -> posisi titik per frame
 *  - delaunay        : triangulasi Bowyer-Watson sederhana
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smoothstep = (a, b, v) => {
	const t = clamp((v - a) / (b - a), 0, 1)
	return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------------------------ */
/*  Indeks landmark MediaPipe (dikonfirmasi dari FaceLandmarksConnections)  */
/* ------------------------------------------------------------------------ */
// Urutan ring bibir: sudut kiri layar -> jalur bawah -> sudut kanan layar -> jalur atas
export const LM = {
	lipsOuter: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
	lipsInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
	// eyeR = mata kanan subjek = sisi KIRI layar (x kecil). Urutan: sudut luar -> sudut dalam
	eyeR: { outer: 33, inner: 133, upper: [246, 161, 160, 159, 158, 157, 173], lower: [7, 163, 144, 145, 153, 154, 155], irisC: 468, iris: [469, 470, 471, 472] },
	eyeL: { outer: 263, inner: 362, upper: [466, 388, 387, 386, 385, 384, 398], lower: [249, 390, 373, 374, 380, 381, 382], irisC: 473, iris: [474, 475, 476, 477] },
	browR: { upper: [70, 63, 105, 66, 107], lower: [46, 53, 52, 65, 55] },
	browL: { upper: [300, 293, 334, 296, 336], lower: [276, 283, 282, 295, 285] },
	oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
	noseTip: 1,
	chin: 152,
	forehead: 10,
}

/* ------------------------------------------------------------------------ */
/*  Rig semantik                                                            */
/* ------------------------------------------------------------------------ */

/**
 * @param {Array<{x:number,y:number,z:number}>} landmarks 478 titik ternormalisasi (0..1) dari MediaPipe
 * @param {number} W lebar foto (px)  @param {number} H tinggi foto (px)
 */
export function buildRigFromLandmarks(landmarks, W, H) {
	if (!landmarks || landmarks.length < 468) throw new Error("Landmark wajah tidak lengkap")
	const pts = landmarks.map((p) => ({ x: p.x * W, y: p.y * H, z: (p.z || 0) * W }))
	const eye = (e) => ({ outer: e.outer, inner: e.inner, upper: e.upper.slice(), lower: e.lower.slice(), irisC: e.irisC, iris: e.iris.slice() })
	const hasIris = pts.length >= 478
	const eyeR = eye(LM.eyeR)
	const eyeL = eye(LM.eyeL)
	if (!hasIris) {
		eyeR.irisC = -1
		eyeR.iris = []
		eyeL.irisC = -1
		eyeL.iris = []
	}
	return finishRig({
		source: "mediapipe",
		W,
		H,
		pts,
		groups: {
			lipsOuter: LM.lipsOuter.slice(),
			lipsInner: LM.lipsInner.slice(),
			eyeR,
			eyeL,
			browR: { upper: LM.browR.upper.slice(), lower: LM.browR.lower.slice() },
			browL: { upper: LM.browL.upper.slice(), lower: LM.browL.lower.slice() },
			oval: LM.oval.slice(),
			noseTip: LM.noseTip,
			chin: LM.chin,
			forehead: LM.forehead,
		},
	})
}

/**
 * Rig cadangan dari 3 klik kalibrasi: mata kiri layar, mata kanan layar, tengah mulut.
 * Proporsi wajah rata-rata, skala dari jarak antar mata (D) dan jarak mata->mulut (M).
 */
export function buildRigFromTemplate({ eyeLeftScreen, eyeRightScreen, mouth }, W, H) {
	const a = eyeLeftScreen
	const b = eyeRightScreen
	const D = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y))
	const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
	const M = Math.max(D * 0.7, mouth.y - mid.y) // jarak vertikal garis mata -> mulut
	const pts = []
	const add = (x, y, z = 0) => {
		pts.push({ x, y, z })
		return pts.length - 1
	}
	// koordinat relatif: u dalam satuan D (horizontal), v: <0 pakai D (atas mata), >0 pakai M (bawah mata)
	const P = (u, v, z = 0) => add(mid.x + u * D, mid.y + (v < 0 ? v * D : v * M), z * D)

	const groups = {}
	// --- mata (elips) ---
	const makeEye = (c, sign) => {
		const hw = 0.31 * D
		const outer = add(c.x - sign * hw, c.y + 0.03 * D, 0.05 * D)
		const inner = add(c.x + sign * hw, c.y + 0.02 * D, 0.02 * D)
		const upper = []
		const lower = []
		for (let k = 1; k <= 5; k++) {
			const t = -1 + (2 * k) / 6
			const x = c.x - sign * t * hw
			const arc = Math.sqrt(1 - t * t)
			upper.push(add(x, c.y - 0.13 * D * arc, 0.04 * D))
			lower.push(add(x, c.y + 0.10 * D * arc, 0.04 * D))
		}
		// upper/lower diurut dari sudut luar ke sudut dalam (t dari -1..1, x = c.x - sign*t*hw)
		// lipatan kelopak (diam) supaya kedip hanya meregangkan kulit kelopak, bukan alis/pipi
		for (let k = 0; k <= 6; k++) {
			const t = -1.15 + (2.3 * k) / 6
			const x = c.x - sign * t * hw
			const arc = Math.sqrt(Math.max(0, 1.3 - t * t))
			add(x, c.y - 0.2 * D * arc, 0.03 * D)
			add(x, c.y + 0.16 * D * arc, 0.03 * D)
		}
		const irisC = add(c.x, c.y, 0.02 * D)
		const iris = []
		const r = 0.115 * D
		for (let k = 0; k < 4; k++) {
			const ang = (k / 4) * Math.PI * 2
			iris.push(add(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r, 0.02 * D))
		}
		return { outer, inner, upper, lower, irisC, iris }
	}
	groups.eyeR = makeEye(a, 1) // kiri layar: sudut luar di x lebih kecil
	groups.eyeL = makeEye(b, -1)

	// --- alis ---
	const makeBrow = (c, sign) => {
		const upper = []
		const lower = []
		for (let k = 0; k < 5; k++) {
			const t = -1 + k / 2 // -1..1, dari luar ke dalam
			const x = c.x - sign * t * 0.42 * D
			const arch = 0.06 * D * (1 - t * t)
			upper.push(add(x, c.y - 0.34 * D - arch, -0.05 * D))
			lower.push(add(x, c.y - 0.26 * D - arch * 0.8, -0.05 * D))
		}
		return { upper, lower }
	}
	groups.browR = makeBrow(a, 1)
	groups.browL = makeBrow(b, -1)

	// --- hidung ---
	P(0, -0.05, -0.2)
	P(0, 0.3, -0.3)
	groups.noseTip = P(0, 0.62, -0.5)
	P(-0.19, 0.7, -0.25)
	P(0.19, 0.7, -0.25)
	P(-0.11, 0.48, -0.3)
	P(0.11, 0.48, -0.3)
	// dahi & pipi
	groups.forehead = P(0, -1.15, -0.1)
	P(0, -0.65, -0.15)
	P(-0.5, -0.7, -0.05)
	P(0.5, -0.7, -0.05)
	P(-0.78, 0.5, 0.0)
	P(0.78, 0.5, 0.0)
	P(0, 0.82, -0.2) // philtrum

	// --- bibir (20 titik, urutan sama seperti MediaPipe) ---
	const lipRing = (hw, upH, lowH, z) => {
		const ring = []
		const cx = mouth.x
		const cy = mouth.y
		ring.push(add(cx - hw, cy, z)) // sudut kiri layar
		for (let k = 1; k <= 9; k++) {
			const t = -1 + k / 5 // -0.8..0.8
			const x = cx + t * hw
			const prof = Math.pow(1 - t * t, 0.6)
			ring.push(add(x, cy + lowH * prof, z - 0.08 * D * prof))
		}
		ring.push(add(cx + hw, cy, z)) // sudut kanan layar
		for (let k = 1; k <= 9; k++) {
			const t = 1 - k / 5 // 0.8..-0.8
			const x = cx + t * hw
			const prof = Math.pow(1 - t * t, 0.6)
			ring.push(add(x, cy - upH * prof, z - 0.08 * D * prof))
		}
		return ring
	}
	groups.lipsOuter = lipRing(0.40 * D, 0.13 * D, 0.17 * D, -0.15 * D)
	groups.lipsInner = lipRing(0.36 * D, 0.006 * D, 0.006 * D, -0.2 * D)

	// dagu & oval wajah
	groups.chin = add(mouth.x, mouth.y + 0.85 * D, -0.05 * D)
	add(mouth.x, mouth.y + 0.45 * D, -0.15 * D) // lipatan dagu
	const oval = []
	const topY = mid.y - 1.15 * D
	const botY = mouth.y + 0.88 * D
	const cyO = (topY + botY) / 2
	const ryO = (botY - topY) / 2
	for (let k = 0; k < 28; k++) {
		const ang = -Math.PI / 2 + (k / 28) * Math.PI * 2
		const cy = cyO + Math.sin(ang) * ryO
		// lebar mengecil ke arah dagu
		const tv = clamp((cy - mid.y) / (botY - mid.y), 0, 1)
		const rx = D * (1.05 - 0.62 * tv * tv)
		const x = mid.x + Math.cos(ang) * rx
		if (k === 21 && Math.abs(x - mouth.x) < 1) continue
		oval.push(add(x, cy, 0.12 * D))
	}
	groups.oval = oval

	return finishRig({ source: "template", W, H, pts, groups })
}

/** Lengkapi rig dengan ukuran turunan (mulut, mata, wajah). */
function finishRig(rig) {
	const { pts, groups: g } = rig
	const P = (i) => pts[i]
	const mean = (idx) => {
		let x = 0
		let y = 0
		let z = 0
		for (const i of idx) {
			x += P(i).x
			y += P(i).y
			z += P(i).z
		}
		return { x: x / idx.length, y: y / idx.length, z: z / idx.length }
	}
	const inner = g.lipsInner
	const outer = g.lipsOuter
	const cornerL = P(outer[0])
	const cornerR = P(outer[10])
	const mouthW = Math.max(6, Math.hypot(cornerR.x - cornerL.x, cornerR.y - cornerL.y))
	const seam = mean(inner)
	const eyeInfo = (e) => {
		const o = P(e.outer)
		const i = P(e.inner)
		const up = mean(e.upper)
		const lo = mean(e.lower)
		const w = Math.max(4, Math.hypot(i.x - o.x, i.y - o.y))
		return { cx: (o.x + i.x) / 2, cy: (up.y + lo.y) / 2, w, h: Math.max(1.5, lo.y - up.y) }
	}
	const ovalPts = g.oval.map(P)
	let minX = Infinity
	let maxX = -Infinity
	let minY = Infinity
	let maxY = -Infinity
	for (const p of ovalPts) {
		minX = Math.min(minX, p.x)
		maxX = Math.max(maxX, p.x)
		minY = Math.min(minY, p.y)
		maxY = Math.max(maxY, p.y)
	}
	const ovalMean = mean(g.oval)
	rig.face = {
		cx: (minX + maxX) / 2,
		cy: (minY + maxY) / 2,
		rx: Math.max(10, (maxX - minX) / 2),
		ry: Math.max(10, (maxY - minY) / 2),
		zRef: ovalMean.z,
		chinY: P(g.chin).y,
		topY: minY,
	}
	rig.mouth = { x: seam.x, y: seam.y, w: mouthW, hw: mouthW / 2 }
	rig.eyes = { L: eyeInfo(g.eyeL), R: eyeInfo(g.eyeR) }
	return rig
}

/* ------------------------------------------------------------------------ */
/*  Delaunay (Bowyer-Watson)                                                */
/* ------------------------------------------------------------------------ */
export function delaunay(points) {
	const n = points.length
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const p of points) {
		if (p[0] < minX) minX = p[0]
		if (p[1] < minY) minY = p[1]
		if (p[0] > maxX) maxX = p[0]
		if (p[1] > maxY) maxY = p[1]
	}
	const dmax = Math.max(maxX - minX, maxY - minY) * 20 + 1
	const midx = (minX + maxX) / 2
	const midy = (minY + maxY) / 2
	const pts = points.map((p) => [p[0], p[1]])
	pts.push([midx - dmax, midy - dmax], [midx, midy + dmax], [midx + dmax, midy - dmax])

	const makeTri = (a, b, c) => {
		const [ax, ay] = pts[a]
		const [bx, by] = pts[b]
		const [cx, cy] = pts[c]
		const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
		if (Math.abs(d) < 1e-9) return { a, b, c, cx: 0, cy: 0, r2: Infinity }
		const a2 = ax * ax + ay * ay
		const b2 = bx * bx + by * by
		const c2 = cx * cx + cy * cy
		const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
		const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
		return { a, b, c, cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 }
	}

	let tris = [makeTri(n, n + 1, n + 2)]
	const edgeCount = new Map()
	for (let i = 0; i < n; i++) {
		const [px, py] = pts[i]
		const bad = []
		const good = []
		for (const t of tris) {
			const dx = t.cx - px
			const dy = t.cy - py
			if (dx * dx + dy * dy <= t.r2) bad.push(t)
			else good.push(t)
		}
		edgeCount.clear()
		for (const t of bad) {
			for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
				const k = a < b ? a * 65536 + b : b * 65536 + a
				edgeCount.set(k, (edgeCount.get(k) || 0) + 1)
			}
		}
		for (const t of bad) {
			for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
				const k = a < b ? a * 65536 + b : b * 65536 + a
				if (edgeCount.get(k) === 1) good.push(makeTri(a, b, i))
			}
		}
		tris = good
	}
	const out = []
	for (const t of tris) {
		if (t.a < n && t.b < n && t.c < n) out.push(t.a, t.b, t.c)
	}
	return out
}

/* ------------------------------------------------------------------------ */
/*  Mesh + bobot animasi                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Bangun mesh dari rig. Menambah titik pinggir foto, grid badan/latar,
 * dan ring rambut supaya kepala bisa bergerak terpisah dari badan.
 */
export function buildMesh(rig) {
	const { W, H, pts, groups: g, face, mouth, eyes } = rig
	const verts = pts.map((p) => ({ x: p.x, y: p.y, z: p.z, face: true }))
	const nFace = verts.length

	// ring rambut/kepala: elips di luar oval wajah, ikut kepala sebagian
	const hairRing = []
	for (let k = 0; k < 20; k++) {
		const ang = (k / 20) * Math.PI * 2
		const ry = Math.sin(ang) < 0 ? face.ry * 1.5 : face.ry * 1.22
		const x = face.cx + Math.cos(ang) * face.rx * 1.38
		const y = face.cy + Math.sin(ang) * ry
		if (x < 2 || x > W - 2 || y < 2 || y > H - 2) continue
		hairRing.push(verts.length)
		verts.push({ x, y, z: face.zRef, face: false })
	}

	// grid badan & latar (spasi ~1/8 lebar foto), lewati yang terlalu dekat wajah
	const step = Math.max(24, Math.min(W, H) / 8)
	const cols = Math.max(2, Math.round(W / step))
	const rows = Math.max(2, Math.round(H / step))
	const nearFace = (x, y) => {
		const ry = y < face.cy ? face.ry * 1.55 : face.ry * 1.15
		const d = Math.hypot((x - face.cx) / (face.rx * 1.45), (y - face.cy) / ry)
		return d < 1.12
	}
	for (let r = 0; r <= rows; r++) {
		for (let c = 0; c <= cols; c++) {
			const x = (c / cols) * W
			const y = (r / rows) * H
			const border = r === 0 || c === 0 || r === rows || c === cols
			if (!border && nearFace(x, y)) continue
			// hindari terlalu dekat dengan titik ring rambut
			let tooClose = false
			if (!border) {
				for (const hi of hairRing) {
					if (Math.hypot(verts[hi].x - x, verts[hi].y - y) < step * 0.35) {
						tooClose = true
						break
					}
				}
			}
			if (tooClose) continue
			verts.push({ x, y, z: face.zRef, face: false, border })
		}
	}

	const n = verts.length
	const rest = new Float32Array(n * 2)
	const uv = new Float32Array(n * 2)
	const zrel = new Float32Array(n)
	for (let i = 0; i < n; i++) {
		rest[i * 2] = verts[i].x
		rest[i * 2 + 1] = verts[i].y
		uv[i * 2] = verts[i].x / W
		uv[i * 2 + 1] = verts[i].y / H
		zrel[i] = verts[i].face ? verts[i].z - face.zRef : 0
	}

	// --- triangulasi: bibir dalam "dibelah" sedikit supaya ada strip segitiga di celah mulut ---
	const triPts = []
	const seen = new Map()
	const nudge = Math.max(0.6, mouth.w * 0.02)
	const innerUpper = new Set(g.lipsInner.slice(11, 20))
	const innerLower = new Set(g.lipsInner.slice(1, 10))
	for (let i = 0; i < n; i++) {
		let x = rest[i * 2]
		let y = rest[i * 2 + 1]
		if (innerUpper.has(i)) y -= nudge
		else if (innerLower.has(i)) y += nudge
		let key = `${x.toFixed(2)},${y.toFixed(2)}`
		while (seen.has(key)) {
			x += 0.03
			y += 0.017
			key = `${x.toFixed(2)},${y.toFixed(2)}`
		}
		seen.set(key, i)
		triPts.push([x, y])
	}
	const triList = delaunay(triPts)
	const tris = n < 65535 ? new Uint16Array(triList) : new Uint32Array(triList)

	/* ----------------------------- bobot ------------------------------ */
	const wHead = new Float32Array(n)
	const wJaw = new Float32Array(n)
	const wBody = new Float32Array(n)
	const wRound = new Float32Array(n)
	const wBrowL = new Float32Array(n)
	const wBrowR = new Float32Array(n)
	const wCheek = new Float32Array(n)

	const hw = mouth.hw
	const mx = mouth.x
	const seamY = mouth.y
	const chinY = face.chinY
	const browC = (b) => {
		const idx = [...b.upper, ...b.lower]
		let x = 0
		let y = 0
		for (const i of idx) {
			x += pts[i].x
			y += pts[i].y
		}
		return { x: x / idx.length, y: y / idx.length }
	}
	const bL = browC(g.browL)
	const bR = browC(g.browR)
	const eyeW = (eyes.L.w + eyes.R.w) / 2
	const cheekL = { x: mx + hw * 1.15, y: seamY - hw * 0.95 }
	const cheekR = { x: mx - hw * 1.15, y: seamY - hw * 0.95 }
	const eyeBottom = Math.max(eyes.L.cy + eyes.L.h * 0.6, eyes.R.cy + eyes.R.h * 0.6)

	for (let i = 0; i < n; i++) {
		const x = rest[i * 2]
		const y = rest[i * 2 + 1]
		// kepala
		const ry = y < face.cy ? face.ry * 1.45 : face.ry * 1.0
		const d = Math.hypot((x - face.cx) / (face.rx * 1.08), (y - face.cy) / ry)
		wHead[i] = 1 - smoothstep(1.0, 1.65, d)
		if (verts[i].face) wHead[i] = 1
		// napas badan (bahu/dada), tidak untuk area kepala
		const shoulder = smoothstep(chinY + face.ry * 0.1, chinY + face.ry * 1.3, y) * (1 - smoothstep(H * 0.85, H, y))
		wBody[i] = shoulder * (1 - wHead[i])
		// rahang
		const vy = (y - seamY) / hw
		const below = smoothstep(0.0, 0.6, vy)
		const lat = Math.pow(1 - clamp(Math.abs(x - mx) / (face.rx * 1.05), 0, 1), 1.25)
		const nf = 1 - smoothstep(chinY + 0.1 * (chinY - seamY), chinY + 1.0 * (chinY - seamY), y)
		wJaw[i] = below * lat * nf
		// bulat (o/u): area sekitar mulut merapat ke tengah
		if (verts[i].face) {
			const dm = Math.hypot((x - mx) / (hw * 1.9), (y - seamY) / (hw * 1.4))
			const fall = Math.exp(-dm * dm * 2.2)
			wRound[i] = -Math.sign(x - mx) * fall
			// alis -> dahi
			if (y < bL.y + eyeW * 0.35) {
				const dl = Math.hypot((x - bL.x) / (eyeW * 1.1), (y - bL.y) / (eyeW * 0.9))
				const dr = Math.hypot((x - bR.x) / (eyeW * 1.1), (y - bR.y) / (eyeW * 0.9))
				wBrowL[i] = Math.exp(-dl * dl)
				wBrowR[i] = Math.exp(-dr * dr)
			}
			// pipi (senyum)
			if (y > eyeBottom) {
				const dl = Math.hypot((x - cheekL.x) / (hw * 0.9), (y - cheekL.y) / (hw * 0.8))
				const dr = Math.hypot((x - cheekR.x) / (hw * 0.9), (y - cheekR.y) / (hw * 0.8))
				wCheek[i] = Math.min(1, Math.exp(-dl * dl) + Math.exp(-dr * dr))
			}
		}
	}
	// override eksplisit: bibir & alis tidak ikut medan umum (ditangani terpisah)
	for (const i of g.lipsOuter) {
		wJaw[i] = 0
		wRound[i] = 0
		wCheek[i] = 0
	}
	for (const i of g.lipsInner) {
		wJaw[i] = 0
		wRound[i] = 0
		wCheek[i] = 0
	}
	for (const b of [g.browL, g.browR]) {
		for (const i of b.upper) {
			wBrowL[i] = 0
			wBrowR[i] = 0
		}
		for (const i of b.lower) {
			wBrowL[i] = 0
			wBrowR[i] = 0
		}
	}
	for (const i of g.browL.upper) wBrowL[i] = 1
	for (const i of g.browL.lower) wBrowL[i] = 0.9
	for (const i of g.browR.upper) wBrowR[i] = 1
	for (const i of g.browR.lower) wBrowR[i] = 0.9
	// mata: tidak ikut pipi/rahang
	for (const e of [g.eyeL, g.eyeR]) {
		for (const i of [e.outer, e.inner, ...e.upper, ...e.lower, e.irisC, ...e.iris]) {
			if (i >= 0) {
				wCheek[i] = 0
				wJaw[i] = 0
			}
		}
	}

	// profil bibir: 0 di sudut, 1 di tengah jalur bawah (k=5) dan atas (k=15)
	const lipProfile = new Float32Array(20)
	for (let k = 0; k < 20; k++) {
		const j = k % 10
		lipProfile[k] = j === 0 ? 0 : Math.sin((Math.PI * j) / 10)
	}
	// target kedip: jarak kelopak atas -> kelopak bawah pada x yang sama
	const eyeInfo = (e, info) => {
		const lower = e.lower.map((i) => ({ x: rest[i * 2], y: rest[i * 2 + 1] })).sort((a, b) => a.x - b.x)
		const lowerYAt = (x) => {
			if (x <= lower[0].x) return lower[0].y
			for (let k = 1; k < lower.length; k++) {
				if (x <= lower[k].x) {
					const t = (x - lower[k - 1].x) / Math.max(1e-6, lower[k].x - lower[k - 1].x)
					return lower[k - 1].y + (lower[k].y - lower[k - 1].y) * t
				}
			}
			return lower[lower.length - 1].y
		}
		const upperDy = e.upper.map((i) => Math.max(0, lowerYAt(rest[i * 2]) - rest[i * 2 + 1]))
		const iris = e.irisC >= 0 ? [e.irisC, ...e.iris] : []
		return { upper: e.upper.slice(), lower: e.lower.slice(), upperDy, iris, corners: [e.outer, e.inner], w: info.w, h: info.h, cx: info.cx, cy: info.cy }
	}

	return {
		n,
		nFace,
		W,
		H,
		rest,
		uv,
		zrel,
		tris,
		wHead,
		wJaw,
		wBody,
		wRound,
		wBrowL,
		wBrowR,
		wCheek,
		lips: { outer: g.lipsOuter.slice(), inner: g.lipsInner.slice(), profile: lipProfile, hw, mx, seamY },
		eyes: { L: eyeInfo(g.eyeL, eyes.L), R: eyeInfo(g.eyeR, eyes.R) },
		brows: { L: g.browL, R: g.browR },
		face: { ...face, pivot: { x: face.cx, y: chinY + face.ry * 0.35 } },
		eyeW,
	}
}

/** Parameter animasi default (semua nol = foto asli). */
export function defaultAnim() {
	return {
		jaw: 0, wide: 0, round: 0, press: 0, lowerLipIn: 0, upperRaise: 0,
		smile: 0, squint: 0,
		browL: 0, browR: 0,
		blinkL: 0, blinkR: 0,
		gazeX: 0, gazeY: 0,
		yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0,
		breath: 0, sway: 0,
	}
}

/**
 * Hitung posisi semua titik untuk satu frame.
 * @param mesh hasil buildMesh
 * @param a    parameter animasi (lihat defaultAnim)
 * @param out  Float32Array(2n) tujuan
 * @param opts { jawScale: 1 }
 */
export function deformMesh(mesh, a, out, opts = {}) {
	const { n, rest, zrel, wHead, wJaw, wBody, wRound, wBrowL, wBrowR, wCheek, lips, eyes, face, H } = mesh
	const hw = lips.hw
	const jawScale = opts.jawScale === undefined ? 1 : opts.jawScale
	const jawMax = hw * 2 * 0.3 * jawScale
	const jawPx = clamp(a.jaw, 0, 1.2) * jawMax
	const breathAmp = H * 0.004
	const px = face.pivot.x
	const py = face.pivot.y
	const headShiftX = a.yaw * face.ry * 0.35
	const headShiftY = a.pitch * face.ry * 0.3
	const browAmp = mesh.eyeW * 0.16
	const cheekAmp = hw * 0.07

	for (let i = 0; i < n; i++) {
		const x = rest[i * 2]
		const y = rest[i * 2 + 1]
		let dx = -(y - H) * a.sway
		let dy = -a.breath * breathAmp * wBody[i]
		const wh = wHead[i]
		if (wh > 0) {
			const z = zrel[i]
			const rx = x - px
			const ry = y - py
			dx += wh * (a.tx + headShiftX - z * a.yaw - ry * a.roll)
			dy += wh * (a.ty + headShiftY - z * a.pitch + rx * a.roll)
		}
		dy += wJaw[i] * jawPx
		dx += wRound[i] * a.round * hw * 0.06
		dy -= (wBrowL[i] * a.browL + wBrowR[i] * a.browR) * browAmp
		dy -= wCheek[i] * a.smile * cheekAmp
		out[i * 2] = x + dx
		out[i * 2 + 1] = y + dy
	}

	/* ------------------------------ bibir ------------------------------ */
	const prof = lips.profile
	const wide = clamp(a.wide, 0, 1)
	const round = clamp(a.round, 0, 1)
	const press = clamp(a.press, 0, 1)
	const lipIn = clamp(a.lowerLipIn, 0, 1)
	const upRaise = clamp(a.upperRaise, 0, 1)
	const smile = clamp(a.smile, 0, 1)
	for (let ring = 0; ring < 2; ring++) {
		const idx = ring === 0 ? lips.outer : lips.inner
		const isInner = ring === 1
		for (let k = 0; k < 20; k++) {
			const i = idx[k]
			const p = prof[k]
			const isLower = k >= 1 && k <= 9
			const isCorner = k === 0 || k === 10
			const sideSign = k === 0 ? -1 : 1 // sudut kiri layar bergerak ke kiri saat melebar
			let dx = 0
			let dy = 0
			// rahang: bukaan berbentuk lensa (tengah turun penuh, dekat sudut lebih sedikit)
			if (isLower) dy += jawPx * (isInner ? 0.5 + 0.5 * p : 0.7 + 0.3 * p)
			else if (isCorner) dy += jawPx * 0.3
			else dy -= jawPx * (isInner ? 0.04 : 0.06) // bibir atas sedikit terangkat
			// lebar (i/e) & bulat (o/u)
			if (isCorner) {
				dx += sideSign * (wide * hw * (isInner ? 0.08 : 0.1) - round * hw * (isInner ? 0.22 : 0.25))
				dy -= wide * hw * 0.02
				// senyum: sudut naik & melebar
				dx += sideSign * smile * hw * (isInner ? 0.09 : 0.12)
				dy -= smile * hw * (isInner ? 0.08 : 0.1)
			} else {
				const towardSeam = isLower ? -1 : 1
				dy += towardSeam * wide * hw * 0.04 * p // bibir menipis saat melebar
				dy -= towardSeam * round * hw * (isInner ? 0.08 : 0.1) * p // mengerucut saat bulat
				dy += towardSeam * press * hw * 0.03 * p // bibir merapat/menekan (m,b,p)
				if (isLower) dy -= lipIn * hw * (isInner ? 0.1 : 0.08) * p // bibir bawah masuk (f,v)
				else dy -= upRaise * hw * 0.05 * p // bibir atas naik (gigi terlihat)
				// senyum: jalur atas & bawah ikut sedikit ke sudut
				const side = k < 10 ? (k - 5) / 5 : (15 - k) / 5 // -1..1 kiri->kanan
				dx += side * smile * hw * 0.05
				if (isLower) dy -= smile * hw * 0.02 * p
			}
			out[i * 2] += dx
			out[i * 2 + 1] += dy
		}
	}

	/* ------------------------------ mata ------------------------------- */
	const eye = (e, blink, browRaise) => {
		const b = clamp(blink, 0, 1)
		const sq = clamp(a.squint, 0, 1) + smile * 0.35
		for (let k = 0; k < e.upper.length; k++) {
			const i = e.upper[k]
			out[i * 2 + 1] += e.upperDy[k] * 0.85 * b - browRaise * mesh.eyeW * 0.05 * (1 - b)
		}
		for (let k = 0; k < e.lower.length; k++) {
			const i = e.lower[k]
			const gap = e.h
			out[i * 2 + 1] -= gap * (0.15 * b + 0.2 * sq * (1 - b))
		}
		// arah pandang: iris bergeser + kompensasi putaran kepala (tetap menatap kamera)
		if (e.iris.length) {
			const gx = clamp(a.gazeX, -1, 1) * e.w * 0.12 - a.yaw * e.w * 0.55
			const gy = clamp(a.gazeY, -1, 1) * e.h * 0.25 - a.pitch * e.w * 0.35 + b * e.h * 0.2
			for (const i of e.iris) {
				out[i * 2] += gx
				out[i * 2 + 1] += gy
			}
		}
	}
	eye(eyes.L, a.blinkL, clamp(a.browL, -1, 1))
	eye(eyes.R, a.blinkR, clamp(a.browR, -1, 1))
	return out
}

/** Titik bantu untuk gambar panduan kalibrasi (semua indeks fitur). */
export function rigFeatureIndices(rig) {
	const g = rig.groups
	const eyes = [g.eyeL, g.eyeR].flatMap((e) => [e.outer, e.inner, ...e.upper, ...e.lower, ...(e.irisC >= 0 ? [e.irisC, ...e.iris] : [])])
	const brows = [g.browL, g.browR].flatMap((b) => [...b.upper, ...b.lower])
	return { lips: [...g.lipsOuter, ...g.lipsInner], eyes, brows, oval: g.oval.slice() }
}
