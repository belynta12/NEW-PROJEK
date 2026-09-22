/**
 * QA offline: render beberapa pose mesh ke PPM tanpa browser (CPU rasterizer).
 * Pakai: node scripts/qa/render-frames.mjs <name> <W> <H> <rgb.raw> <landmarks.json|template:x1,y1,x2,y2,mx,my> <outdir>
 */
import fs from "node:fs"
import path from "node:path"
import { buildRigFromLandmarks, buildRigFromTemplate, buildMesh, deformMesh, defaultAnim } from "../../public/js/mesh.js"

const [, , name, Ws, Hs, rgbPath, rigSpec, outDir] = process.argv
const W = Number(Ws)
const H = Number(Hs)
const tex = fs.readFileSync(rgbPath)
if (tex.length !== W * H * 3) throw new Error(`ukuran tekstur salah: ${tex.length} vs ${W * H * 3}`)

let rig
if (rigSpec.startsWith("template:")) {
	const [x1, y1, x2, y2, mx, my] = rigSpec.slice(9).split(",").map(Number)
	rig = buildRigFromTemplate({ eyeLeftScreen: { x: x1, y: y1 }, eyeRightScreen: { x: x2, y: y2 }, mouth: { x: mx, y: my } }, W, H)
} else {
	const lm = JSON.parse(fs.readFileSync(rigSpec, "utf8")).map(([x, y, z]) => ({ x, y, z }))
	rig = buildRigFromLandmarks(lm, W, H)
}
const t0 = performance.now()
const mesh = buildMesh(rig)
console.log(`[${name}] rig=${rig.source} verts=${mesh.n} (face ${mesh.nFace}) tris=${mesh.tris.length / 3} build=${(performance.now() - t0).toFixed(1)}ms mouthW=${rig.mouth.w.toFixed(1)} face rx=${rig.face.rx.toFixed(0)} ry=${rig.face.ry.toFixed(0)}`)

function sample(u, v, out, o) {
	const x = Math.max(0, Math.min(W - 1.001, u * W - 0.5))
	const y = Math.max(0, Math.min(H - 1.001, v * H - 0.5))
	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	const fx = x - x0
	const fy = y - y0
	const i00 = (y0 * W + x0) * 3
	const i10 = i00 + 3
	const i01 = i00 + W * 3
	const i11 = i01 + 3
	for (let c = 0; c < 3; c++) {
		const top = tex[i00 + c] * (1 - fx) + tex[i10 + c] * fx
		const bot = tex[i01 + c] * (1 - fx) + tex[i11 + c] * fx
		out[o + c] = Math.round(top * (1 - fy) + bot * fy)
	}
}

function rasterize(pos) {
	const out = new Uint8Array(W * H * 3).fill(40)
	const { tris, uv } = mesh
	const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax)
	for (let t = 0; t < tris.length; t += 3) {
		const i0 = tris[t]
		const i1 = tris[t + 1]
		const i2 = tris[t + 2]
		const x0 = pos[i0 * 2]
		const y0 = pos[i0 * 2 + 1]
		const x1 = pos[i1 * 2]
		const y1 = pos[i1 * 2 + 1]
		const x2 = pos[i2 * 2]
		const y2 = pos[i2 * 2 + 1]
		const area = edge(x0, y0, x1, y1, x2, y2)
		if (Math.abs(area) < 1e-9) continue
		const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
		const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
		const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
		const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)))
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				const px = x + 0.5
				const py = y + 0.5
				const w0 = edge(x1, y1, x2, y2, px, py) / area
				const w1 = edge(x2, y2, x0, y0, px, py) / area
				const w2 = 1 - w0 - w1
				if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
				const u = w0 * uv[i0 * 2] + w1 * uv[i1 * 2] + w2 * uv[i2 * 2]
				const v = w0 * uv[i0 * 2 + 1] + w1 * uv[i1 * 2 + 1] + w2 * uv[i2 * 2 + 1]
				sample(u, v, out, (y * W + x) * 3)
			}
		}
	}
	return out
}

function inPoly(poly, px, py) {
	let inside = false
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i]
		const [xj, yj] = poly[j]
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}

function drawMouth(out, pos) {
	const inner = mesh.lips.inner.map((i) => [pos[i * 2], pos[i * 2 + 1]])
	let minY = Infinity
	let maxY = -Infinity
	let minX = Infinity
	let maxX = -Infinity
	for (const [x, y] of inner) {
		minY = Math.min(minY, y)
		maxY = Math.max(maxY, y)
		minX = Math.min(minX, x)
		maxX = Math.max(maxX, x)
	}
	if (maxY - minY < 0.8) return
	// gigi atas: kurva bibir atas dalam (indeks 10..19,0) digeser ke bawah
	const upper = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0].map((k) => inner[k])
	const toothH = mesh.lips.hw * 0.3
	const teeth = [...upper, ...upper.slice().reverse().map(([x, y]) => [x, y + toothH])]
	const lower = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => inner[k])
	const lowTeeth = [...lower, ...lower.slice().reverse().map(([x, y]) => [x, y - toothH * 0.6])]
	for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
		for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
			if (x < 0 || y < 0 || x >= W || y >= H) continue
			const px = x + 0.5
			const py = y + 0.5
			if (!inPoly(inner, px, py)) continue
			const o = (y * W + x) * 3
			out[o] = 38
			out[o + 1] = 10
			out[o + 2] = 12
			if (inPoly(lowTeeth, px, py)) {
				out[o] = 190
				out[o + 1] = 180
				out[o + 2] = 168
			}
			if (inPoly(teeth, px, py)) {
				out[o] = 238
				out[o + 1] = 232
				out[o + 2] = 220
			}
		}
	}
}

function drawWire(out, pos) {
	const { tris } = mesh
	const put = (x, y) => {
		x = Math.round(x)
		y = Math.round(y)
		if (x < 0 || y < 0 || x >= W || y >= H) return
		const o = (y * W + x) * 3
		out[o] = 80
		out[o + 1] = 255
		out[o + 2] = 120
	}
	const line = (x0, y0, x1, y1) => {
		const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
		for (let s = 0; s <= steps; s++) put(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps)
	}
	for (let t = 0; t < tris.length; t += 3) {
		const a = tris[t]
		const b = tris[t + 1]
		const c = tris[t + 2]
		line(pos[a * 2], pos[a * 2 + 1], pos[b * 2], pos[b * 2 + 1])
		line(pos[b * 2], pos[b * 2 + 1], pos[c * 2], pos[c * 2 + 1])
		line(pos[c * 2], pos[c * 2 + 1], pos[a * 2], pos[a * 2 + 1])
	}
}

const poses = {
	rest: {},
	A: { jaw: 0.85, wide: 0.15 },
	U: { jaw: 0.28, round: 1.0 },
	I: { jaw: 0.22, wide: 0.9, upperRaise: 0.35 },
	O: { jaw: 0.6, round: 0.75 },
	MBP: { press: 0.7 },
	blink: { blinkL: 1, blinkR: 1 },
	halfblink: { blinkL: 0.5, blinkR: 0.5 },
	head: { yaw: 0.1, pitch: 0.05, roll: 0.03, browL: 0.7, browR: 0.7, smile: 0.6, gazeX: 0.5 },
	headneg: { yaw: -0.1, pitch: -0.05, roll: -0.03, tx: 3, ty: -2, breath: 1, sway: 0.004 },
}
fs.mkdirSync(outDir, { recursive: true })
const pos = new Float32Array(mesh.n * 2)
for (const [pname, p] of Object.entries(poses)) {
	const anim = { ...defaultAnim(), ...p }
	const t1 = performance.now()
	deformMesh(mesh, anim, pos, { jawScale: 1 })
	let nan = 0
	for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) nan++
	const t2 = performance.now()
	const out = rasterize(pos)
	drawMouth(out, pos)
	const header = Buffer.from(`P6\n${W} ${H}\n255\n`)
	fs.writeFileSync(path.join(outDir, `${name}-${pname}.ppm`), Buffer.concat([header, Buffer.from(out.buffer)]))
	if (pname === "rest" || pname === "A") {
		drawWire(out, pos)
		fs.writeFileSync(path.join(outDir, `${name}-${pname}-wire.ppm`), Buffer.concat([header, Buffer.from(out.buffer)]))
	}
	console.log(`  ${pname}: deform=${(t2 - t1).toFixed(2)}ms nan=${nan}`)
}
