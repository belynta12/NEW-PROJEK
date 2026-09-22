/**
 * PhotoPuppet v2 - menghidupkan SATU foto menjadi avatar yang bergerak seperti manusia.
 * Semua di browser, tanpa API berbayar.
 *
 * Cara kerja:
 *  1. 478 titik wajah (MediaPipe, lihat face-detect.js) atau rig cadangan dari 3 klik.
 *  2. Foto dipecah menjadi ~1.100 segitiga (mesh.js) dan dirender ulang tiap frame
 *     dengan WebGL (warp.js) sehingga rahang, bibir, kelopak, alis, pipi, dan kepala
 *     benar-benar berubah bentuk, bukan sekadar ditempel.
 *  3. Rongga mulut, gigi, dan lidah digambar di dalam celah bibir.
 *  4. Bentuk mulut mengikuti viseme (lipsync.js) dari teks + audio, bukan hanya volume.
 *  5. Perilaku hidup: napas, kedip natural, sakadik mata, gerak kepala mikro,
 *     angguk saat menekankan kata, alis, senyum kecil, dan ekspresi per status.
 */

import { buildRigFromLandmarks, buildRigFromTemplate, buildMesh, deformMesh, defaultAnim, rigFeatureIndices } from "./mesh.js"
import { MeshWarper } from "./warp.js"
import { LegacyPuppet, loadImage } from "./puppet-legacy.js"

export { loadImage }

const DPR = Math.min(window.devicePixelRatio || 1, 2)
const OVERSCAN = 1.025
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)))
const rand = (a, b) => a + Math.random() * (b - a)
// derau halus (jumlah sinus dengan frekuensi tak sebanding)
const noise = (t, s) => Math.sin(t * 0.61 + s) * 0.5 + Math.sin(t * 1.37 + s * 1.7) * 0.3 + Math.sin(t * 2.93 + s * 2.3) * 0.2

const MOUTH_KEYS = ["jaw", "wide", "round", "press", "lowerLipIn", "upperRaise"]

export class PhotoPuppet {
	constructor(canvas) {
		this.canvas = canvas
		this.ctx = canvas.getContext("2d")
		this.image = null
		this.rig = null
		this.mesh = null
		this.positions = null
		this.state = "idle"
		this.bodyMotion = 1
		this.lipGain = 1
		this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
		this.running = false
		this.showGuides = false
		this.onFrame = null

		this.anim = defaultAnim()
		this.mouth = { jaw: 0, wide: 0, round: 0, press: 0, lowerLipIn: 0, upperRaise: 0 }
		this.mouthTarget = null
		this.level = { raw: 0, tone: 0.5 }
		this.energy = 0
		this.energySlow = 0
		this.beat = 0

		const now = performance.now()
		this.blink = { next: now + rand(900, 2200), start: 0, active: false, double: false, value: 0 }
		this.gaze = { x: 0, y: 0, tx: 0, ty: 0, next: now + 1200 }
		this.head = { yaw: 0, pitch: 0, roll: 0, tYaw: 0, tPitch: 0, tRoll: 0, next: now + 1500, tx: 0, ty: 0 }
		this.brow = { l: 0, r: 0, extra: 0, next: now + rand(2500, 6000), until: 0 }
		this.smile = { v: 0.12, target: 0.15, burstUntil: 0 }
		this.lastFrame = now

		this.colors = { cavityTop: "rgb(30,9,11)", cavityBottom: "rgb(78,26,32)", teeth: [240, 234, 222], tongue: "rgb(152,72,82)" }
		this.texCanvas = document.createElement("canvas")
		this.legacy = null
		try {
			this.warper = new MeshWarper()
		} catch (error) {
			console.warn("[puppet] WebGL tidak tersedia, memakai mode 2D sederhana:", error.message)
			this.warper = null
			this.legacy = new LegacyPuppet(canvas)
		}
	}

	/* ----------------------------- setup ------------------------------ */

	async setImage(src) {
		const image = await loadImage(src)
		this.image = image
		this.rig = null
		this.mesh = null
		this.positions = null
		this.resize()
		if (this.legacy) {
			await this.legacy.setImage(src)
			return image
		}
		// tekstur: cukup sebesar canvas (menghindari aliasing), dibatasi kemampuan GPU
		const maxSide = Math.min(this.warper.maxTex || 4096, 2048)
		const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight), Math.max(this.canvas.width, 720) / image.naturalWidth)
		const tw = Math.max(2, Math.round(image.naturalWidth * scale))
		const th = Math.max(2, Math.round(image.naturalHeight * scale))
		this.texCanvas.width = tw
		this.texCanvas.height = th
		const tctx = this.texCanvas.getContext("2d")
		tctx.imageSmoothingQuality = "high"
		tctx.drawImage(image, 0, 0, tw, th)
		this.warper.setTexture(this.texCanvas)
		return image
	}

	resize() {
		if (!this.image) return
		const maxW = 720
		const ratio = this.image.naturalHeight / this.image.naturalWidth
		const w = Math.min(maxW, this.image.naturalWidth)
		const h = Math.round(w * ratio)
		this.canvas.width = Math.round(w * DPR)
		this.canvas.height = Math.round(h * DPR)
		this.canvas.style.aspectRatio = `${w} / ${h}`
		this.viewW = w
		this.viewH = h
		if (this.warper) this.warper.setSize(this.canvas.width, this.canvas.height)
	}

	/** Pasang 478 titik MediaPipe (ternormalisasi 0..1). */
	setLandmarks(points) {
		if (!this.image) throw new Error("Foto belum dipasang")
		const rig = buildRigFromLandmarks(points, this.image.naturalWidth, this.image.naturalHeight)
		this.applyRig(rig)
		return rig
	}

	/** Rig cadangan dari 3 klik: mata kiri layar, mata kanan layar, tengah mulut (piksel foto). */
	setTemplateRig({ eyeLeftScreen, eyeRightScreen, mouth }) {
		if (!this.image) throw new Error("Foto belum dipasang")
		const rig = buildRigFromTemplate({ eyeLeftScreen, eyeRightScreen, mouth }, this.image.naturalWidth, this.image.naturalHeight)
		this.applyRig(rig)
		return rig
	}

	applyRig(rig) {
		this.rig = rig
		this.mesh = buildMesh(rig)
		this.positions = new Float32Array(this.mesh.n * 2)
		this.positions.set(this.mesh.rest)
		this.sampleColors()
		if (this.warper) this.warper.setMesh(this.mesh)
		if (this.legacy) {
			const R = rig.eyes.R
			const L = rig.eyes.L
			this.legacy.setRig({
				eyeL: { x: R.cx, y: R.cy, w: R.w, h: Math.max(3, R.h * 0.6) },
				eyeR: { x: L.cx, y: L.cy, w: L.w, h: Math.max(3, L.h * 0.6) },
				mouth: { x: rig.mouth.x, y: rig.mouth.y, w: rig.mouth.w, h: rig.mouth.w * 0.3 },
			})
			this.legacy.deriveHead()
		}
	}

	hasFace() {
		return Boolean(this.rig)
	}

	/** Ambil warna bibir & terang kulit dari foto untuk mewarnai rongga mulut dan gigi. */
	sampleColors() {
		try {
			const { rig, image } = this
			const c = document.createElement("canvas")
			c.width = image.naturalWidth
			c.height = image.naturalHeight
			const cx = c.getContext("2d")
			cx.drawImage(image, 0, 0)
			const px = (x, y) => cx.getImageData(clamp(Math.round(x), 0, c.width - 1), clamp(Math.round(y), 0, c.height - 1), 1, 1).data
			const avg = (idx) => {
				let r = 0
				let g = 0
				let b = 0
				for (const i of idx) {
					const p = rig.pts[i]
					const d = px(p.x, p.y)
					r += d[0]
					g += d[1]
					b += d[2]
				}
				return [r / idx.length, g / idx.length, b / idx.length]
			}
			const lip = avg(rig.groups.lipsOuter.slice(3, 8))
			const hw = rig.mouth.hw
			const skinPts = [
				[rig.mouth.x - hw * 1.6, rig.mouth.y - hw * 0.6],
				[rig.mouth.x + hw * 1.6, rig.mouth.y - hw * 0.6],
				[rig.mouth.x, rig.mouth.y + hw * 1.1],
			]
			let lum = 0
			for (const [x, y] of skinPts) {
				const d = px(x, y)
				lum += 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]
			}
			lum /= skinPts.length
			const bright = clamp(lum / 175, 0.55, 1.05)
			const dark = (k) => `rgb(${Math.round(lip[0] * k)},${Math.round(lip[1] * k * 0.55)},${Math.round(lip[2] * k * 0.6)})`
			this.colors = {
				cavityTop: dark(0.16),
				cavityBottom: dark(0.42),
				teeth: [240 * bright, 234 * bright, 222 * bright],
				tongue: `rgb(${Math.round(clamp(lip[0] * 0.85, 90, 190))},${Math.round(clamp(lip[1] * 0.5, 40, 100))},${Math.round(clamp(lip[2] * 0.55, 45, 110))})`,
			}
		} catch {
			/* foto lintas-domain: pakai warna default */
		}
	}

	/* ------------------------------ input ------------------------------ */

	setState(state) {
		if (state === this.state) return
		const prev = this.state
		this.state = state
		const now = performance.now()
		if (prev === "speaking" && state === "idle") this.smile.burstUntil = now + 1300
		if (state === "thinking") {
			this.gaze.tx = Math.random() < 0.5 ? -0.7 : 0.7
			this.gaze.ty = -0.6
			this.gaze.next = now + rand(700, 1400)
			this.head.next = now // langsung ganti pose
		}
		if (state === "listening" || state === "speaking") this.head.next = now
		if (state !== "speaking") {
			this.mouthTarget = null
			this.level.raw = 0
		}
		if (this.legacy) this.legacy.setState(state)
	}

	/** Jalur lama: level 0..1 dari volume, tone 0..1 (tinggi = bibir melebar). */
	setLevel(level, tone = 0.5) {
		this.level.raw = clamp(level, 0, 1)
		this.level.tone = clamp(tone, 0, 1)
		this.mouthTarget = null
	}

	/** Jalur baru: parameter viseme dari lipsync.js ({jaw, wide, round, press, lowerLipIn, upperRaise, energy}) atau null. */
	setMouth(m) {
		this.mouthTarget = m
			? {
					jaw: clamp(m.jaw || 0, 0, 1.2),
					wide: clamp(m.wide || 0, 0, 1),
					round: clamp(m.round || 0, 0, 1),
					press: clamp(m.press || 0, 0, 1),
					lowerLipIn: clamp(m.lowerLipIn || 0, 0, 1),
					upperRaise: clamp(m.upperRaise || 0, 0, 1),
					energy: clamp(m.energy === undefined ? m.jaw || 0 : m.energy, 0, 1),
				}
			: null
	}

	start() {
		if (this.running) return
		this.running = true
		this.lastFrame = performance.now()
		const loop = () => {
			if (!this.running) return
			try {
				this.draw(performance.now())
			} catch (error) {
				console.error("[puppet] frame error:", error)
			}
			requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	}

	stop() {
		this.running = false
	}

	/* --------------------------- perilaku hidup -------------------------- */

	update(now) {
		const dt = clamp((now - this.lastFrame) / 1000, 0.001, 0.05)
		this.lastFrame = now
		const t = now / 1000
		const m = this.reduceMotion ? 0.3 : clamp(this.bodyMotion, 0, 2)
		const speaking = this.state === "speaking"

		// --- mulut: target dari viseme atau dari volume ---
		let target = this.mouthTarget
		if (!target) {
			const lv = this.level.raw
			const tone = this.level.tone
			target = {
				jaw: lv,
				wide: Math.max(0, (tone - 0.5) * 2) * 0.8 * lv,
				round: Math.max(0, (0.5 - tone) * 2) * 0.8 * Math.min(1, lv * 1.5),
				press: 0,
				lowerLipIn: 0,
				upperRaise: 0,
				energy: lv,
			}
		}
		for (const k of MOUTH_KEYS) {
			const tau = k === "jaw" ? (target[k] > this.mouth[k] ? 0.03 : 0.055) : 0.06
			this.mouth[k] = ease(this.mouth[k], target[k], dt, tau)
		}
		this.energy = ease(this.energy, target.energy, dt, 0.04)
		this.energySlow = ease(this.energySlow, this.energy, dt, 0.3)
		this.beat = ease(this.beat, Math.max(0, this.energy - this.energySlow), dt, 0.09)

		// --- kedip ---
		const b = this.blink
		if (!b.active && now >= b.next) {
			// saat bicara, tunda kedip sampai jeda (maks 0,6 s)
			if (speaking && this.energy > 0.45 && now < b.next + 600) {
				/* tunggu */
			} else {
				b.active = true
				b.start = now
				b.double = Math.random() < 0.15
			}
		}
		if (b.active) {
			const d = now - b.start
			if (d < 70) b.value = Math.sin((d / 70) * (Math.PI / 2))
			else if (d < 110) b.value = 1
			else if (d < 230) b.value = Math.cos(((d - 110) / 120) * (Math.PI / 2))
			else {
				b.value = 0
				b.active = false
				if (b.double) {
					b.double = false
					b.next = now + 120
				} else {
					const base = this.state === "listening" ? rand(1800, 4200) : rand(2400, 6500)
					b.next = now + base
				}
			}
		}

		// --- arah pandang (sakadik) ---
		const g = this.gaze
		if (now >= g.next) {
			if (this.state === "thinking") {
				g.tx = rand(-0.8, 0.8)
				g.ty = rand(-0.8, -0.2)
				g.next = now + rand(600, 1500)
			} else if (this.state === "listening") {
				g.tx = rand(-0.12, 0.12)
				g.ty = rand(-0.1, 0.1)
				g.next = now + rand(900, 2200)
			} else if (Math.random() < (speaking ? 0.25 : 0.35)) {
				g.tx = rand(-0.45, 0.45)
				g.ty = rand(-0.3, 0.25)
				g.next = now + rand(400, 1100)
			} else {
				g.tx = rand(-0.08, 0.08)
				g.ty = rand(-0.06, 0.06)
				g.next = now + rand(1200, 3200)
			}
		}
		g.x = ease(g.x, g.tx, dt, 0.045)
		g.y = ease(g.y, g.ty, dt, 0.045)

		// --- kepala: pose target berganti perlahan + derau mikro + angguk saat bicara ---
		const h = this.head
		if (now >= h.next) {
			let yaw = 0.05
			let pitch = 0.035
			let roll = 0.03
			let bias = { yaw: 0, pitch: 0, roll: 0 }
			let hold = rand(2500, 7000)
			if (speaking) {
				yaw = 0.075
				pitch = 0.045
				roll = 0.035
				hold = rand(1300, 3600)
			} else if (this.state === "listening") {
				bias = { yaw: 0, pitch: -0.01, roll: (Math.random() < 0.5 ? -1 : 1) * 0.035 }
				yaw = 0.03
				pitch = 0.02
				roll = 0.015
				hold = rand(2500, 5000)
			} else if (this.state === "thinking") {
				bias = { yaw: Math.sign(g.tx || 1) * 0.06, pitch: -0.035, roll: 0.045 * Math.sign(g.tx || 1) }
				yaw = 0.02
				pitch = 0.015
				roll = 0.01
				hold = rand(1200, 2500)
			}
			h.tYaw = bias.yaw + rand(-yaw, yaw)
			h.tPitch = bias.pitch + rand(-pitch, pitch)
			h.tRoll = bias.roll + rand(-roll, roll)
			h.next = now + hold
		}
		const tauHead = speaking ? 0.45 : 0.7
		h.yaw = ease(h.yaw, h.tYaw, dt, tauHead)
		h.pitch = ease(h.pitch, h.tPitch, dt, tauHead)
		h.roll = ease(h.roll, h.tRoll, dt, tauHead)

		// --- alis ---
		const br = this.brow
		let browBase = 0
		let asym = 0
		if (this.state === "listening") browBase = 0.28
		else if (this.state === "thinking") {
			browBase = 0.12
			asym = 0.3
		} else if (speaking) browBase = 0.06 + this.beat * 1.1
		if (now >= br.next) {
			br.extra = rand(0.25, 0.5)
			br.until = now + rand(350, 700)
			br.next = now + rand(3000, 9000)
		}
		const extra = now < br.until ? br.extra : 0
		br.l = ease(br.l, browBase + extra + asym, dt, 0.12)
		br.r = ease(br.r, browBase + extra - asym * 0.4, dt, 0.12)

		// --- senyum ---
		const s = this.smile
		let smileTarget = 0.15
		if (this.state === "listening") smileTarget = 0.25
		else if (this.state === "thinking") smileTarget = 0.06
		else if (speaking) smileTarget = 0.08 + this.mouth.wide * 0.15
		if (now < s.burstUntil) smileTarget = 0.5
		s.v = ease(s.v, smileTarget, dt, 0.5)

		// --- napas (tarik lebih cepat, hembus lebih lambat) ---
		const phase = (t % 4.8) / 4.8
		const breath = phase < 0.4 ? Math.sin((phase / 0.4) * Math.PI * 0.5) : Math.cos(((phase - 0.4) / 0.6) * Math.PI * 0.5)

		// --- susun parameter animasi ---
		const a = this.anim
		const mo = this.mouth
		const face = this.mesh ? this.mesh.face : { rx: 100, ry: 130 }
		a.jaw = mo.jaw
		a.wide = mo.wide
		a.round = mo.round
		a.press = mo.press
		a.lowerLipIn = mo.lowerLipIn
		a.upperRaise = mo.upperRaise
		a.smile = s.v
		a.squint = 0
		a.browL = br.l * m
		a.browR = br.r * m
		a.blinkL = b.value
		a.blinkR = b.value
		a.gazeX = g.x
		a.gazeY = g.y
		const nod = speaking ? this.beat * 0.07 + Math.sin(t * 4.3) * 0.004 * this.energy : 0
		a.yaw = (h.yaw + noise(t, 1.3) * 0.008) * m
		a.pitch = (h.pitch + nod + noise(t, 4.1) * 0.006) * m
		a.roll = (h.roll + noise(t, 7.9) * 0.004) * m
		a.tx = noise(t * 0.7, 2.2) * face.rx * 0.012 * m
		a.ty = (noise(t * 0.8, 5.5) * face.ry * 0.008 - breath * face.ry * 0.012 + (speaking ? this.beat * face.ry * 0.02 : 0)) * m
		a.breath = breath * m
		a.sway = (Math.sin(t * 0.35) * 0.0016 + Math.sin(t * 0.73) * 0.0007) * m
	}

	/* ------------------------------ render ------------------------------ */

	draw(now) {
		const { ctx, canvas, image } = this
		if (!image) return
		this.update(now)

		if (this.legacy) {
			const mo = this.mouth
			const tone = clamp(0.5 + mo.wide * 0.5 - mo.round * 0.5, 0, 1)
			this.legacy.setLevel(clamp(mo.jaw, 0, 1), tone)
			this.legacy.setState(this.state)
			this.legacy.draw(now)
			if (this.showGuides) this.legacy.drawGuides()
			return
		}

		const W = image.naturalWidth
		const H = image.naturalHeight
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.clearRect(0, 0, canvas.width, canvas.height)

		if (!this.mesh) {
			// belum ada wajah: tampilkan foto dengan napas halus
			const s = 1 + this.anim.breath * 0.003
			ctx.save()
			ctx.translate(canvas.width / 2, canvas.height)
			ctx.scale(OVERSCAN, OVERSCAN * s)
			ctx.drawImage(image, -canvas.width / 2, -canvas.height, canvas.width, canvas.height)
			ctx.restore()
			return
		}

		deformMesh(this.mesh, this.anim, this.positions, { jawScale: clamp(this.lipGain, 0.3, 2) })
		if (this.warper.render(this.positions, W, H, OVERSCAN)) {
			ctx.drawImage(this.warper.canvas, 0, 0, canvas.width, canvas.height)
		} else {
			ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
		}

		// overlay dalam koordinat foto (ikut overscan)
		const sx = (canvas.width / W) * OVERSCAN
		const sy = (canvas.height / H) * OVERSCAN
		ctx.setTransform(sx, 0, 0, sy, canvas.width / 2 - sx * (W / 2), canvas.height / 2 - sy * (H / 2))
		this.drawMouthInterior(ctx)
		this.drawEyelids(ctx)
		if (this.showGuides) this.drawGuides(ctx)
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		if (this.onFrame) this.onFrame(now)
	}

	/** Jalur halus melewati titik-titik (kurva kuadratik lewat titik tengah). */
	smoothPath(ctx, pts, close = true) {
		const n = pts.length
		if (n < 3) return
		const mid = (i) => {
			const a = pts[i % n]
			const b = pts[(i + 1) % n]
			return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
		}
		let m0 = mid(n - 1)
		ctx.moveTo(m0[0], m0[1])
		for (let i = 0; i < n; i++) {
			const p = pts[i]
			const mm = mid(i)
			ctx.quadraticCurveTo(p[0], p[1], mm[0], mm[1])
		}
		if (close) ctx.closePath()
	}

	drawMouthInterior(ctx) {
		const { mesh, positions: pos, colors } = this
		const inner = mesh.lips.inner
		const pts = inner.map((i) => [pos[i * 2], pos[i * 2 + 1]])
		// celah per kolom: bawah k (1..9) berpasangan dengan atas 20-k
		let maxGap = 0
		for (let k = 1; k <= 9; k++) {
			const gap = pts[k][1] - pts[20 - k][1]
			if (gap > maxGap) maxGap = gap
		}
		const hw = mesh.lips.hw
		if (maxGap < Math.max(0.7, hw * 0.02)) return
		const mx = (pts[0][0] + pts[10][0]) / 2
		let topY = Infinity
		let botY = -Infinity
		for (const [, y] of pts) {
			topY = Math.min(topY, y)
			botY = Math.max(botY, y)
		}

		ctx.save()
		ctx.beginPath()
		this.smoothPath(ctx, pts, true)
		ctx.clip()

		// 1. rongga mulut
		const cav = ctx.createLinearGradient(0, topY, 0, botY)
		cav.addColorStop(0, colors.cavityTop)
		cav.addColorStop(1, colors.cavityBottom)
		ctx.fillStyle = cav
		ctx.fillRect(mx - hw * 1.5, topY - 2, hw * 3, botY - topY + 4)

		// 2. lidah (muncul saat mulut cukup terbuka)
		const open = maxGap / hw
		const tongueA = clamp((open - 0.32) / 0.3, 0, 0.85)
		if (tongueA > 0.01) {
			const lowY = pts[5][1]
			ctx.globalAlpha = tongueA
			ctx.fillStyle = colors.tongue
			ctx.beginPath()
			ctx.ellipse(mx, lowY - hw * 0.12, hw * 0.55, hw * 0.16, 0, 0, Math.PI * 2)
			ctx.fill()
			ctx.globalAlpha = 1
		}

		// 3. gigi bawah (menempel di bibir bawah dalam, lebih gelap karena terbayang)
		const lower = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => pts[k])
		if (open > 0.28) {
			const th = hw * 0.16
			ctx.globalAlpha = clamp((open - 0.28) / 0.2, 0, 1)
			ctx.beginPath()
			ctx.moveTo(lower[0][0], lower[0][1])
			for (const p of lower) ctx.lineTo(p[0], p[1])
			for (let k = lower.length - 1; k >= 0; k--) ctx.lineTo(lower[k][0], lower[k][1] - th)
			ctx.closePath()
			const [tr, tg, tb] = colors.teeth
			ctx.fillStyle = `rgb(${Math.round(tr * 0.72)},${Math.round(tg * 0.7)},${Math.round(tb * 0.68)})`
			ctx.fill()
			ctx.globalAlpha = 1
		}

		// 4. gigi atas (menempel di bibir atas dalam)
		const upper = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0].map((k) => pts[k])
		const toothH = hw * 0.3
		ctx.save()
		ctx.beginPath()
		ctx.moveTo(upper[0][0], upper[0][1] - 1)
		for (const p of upper) ctx.lineTo(p[0], p[1] - 1)
		for (let k = upper.length - 1; k >= 0; k--) ctx.lineTo(upper[k][0], upper[k][1] + toothH)
		ctx.closePath()
		ctx.clip()
		const [tr, tg, tb] = colors.teeth
		const upTop = Math.min(...upper.map((p) => p[1]))
		const tg1 = ctx.createLinearGradient(0, upTop, 0, upTop + toothH)
		tg1.addColorStop(0, `rgb(${Math.round(tr * 0.86)},${Math.round(tg * 0.84)},${Math.round(tb * 0.8)})`)
		tg1.addColorStop(0.35, `rgb(${Math.round(tr)},${Math.round(tg)},${Math.round(tb)})`)
		tg1.addColorStop(0.85, `rgb(${Math.round(tr * 0.96)},${Math.round(tg * 0.95)},${Math.round(tb * 0.92)})`)
		tg1.addColorStop(1, `rgb(${Math.round(tr * 0.7)},${Math.round(tg * 0.66)},${Math.round(tb * 0.62)})`)
		ctx.fillStyle = tg1
		ctx.fillRect(mx - hw * 1.5, upTop - 2, hw * 3, toothH + 4)
		// gelap ke arah sudut mulut
		const side = ctx.createLinearGradient(mx - hw, 0, mx + hw, 0)
		side.addColorStop(0, "rgba(40,15,15,0.55)")
		side.addColorStop(0.28, "rgba(40,15,15,0)")
		side.addColorStop(0.72, "rgba(40,15,15,0)")
		side.addColorStop(1, "rgba(40,15,15,0.55)")
		ctx.fillStyle = side
		ctx.fillRect(mx - hw * 1.5, upTop - 2, hw * 3, toothH + 4)
		// sela gigi
		ctx.strokeStyle = "rgba(95,60,55,0.38)"
		ctx.lineWidth = Math.max(0.5, hw * 0.014)
		const toothW = hw * 0.19
		for (let k = -3; k <= 3; k++) {
			const x = mx + k * toothW
			ctx.beginPath()
			ctx.moveTo(x, upTop - 1)
			ctx.lineTo(x, upTop + toothH * 0.92)
			ctx.stroke()
		}
		ctx.restore()

		// 5. bayangan bibir atas ke dalam rongga + tepi gelap
		const sh = ctx.createLinearGradient(0, upTop, 0, upTop + hw * 0.22)
		sh.addColorStop(0, "rgba(20,5,6,0.7)")
		sh.addColorStop(1, "rgba(20,5,6,0)")
		ctx.fillStyle = sh
		ctx.fillRect(mx - hw * 1.5, upTop - 2, hw * 3, hw * 0.24)
		ctx.beginPath()
		this.smoothPath(ctx, pts, true)
		ctx.lineWidth = hw * 0.16
		ctx.strokeStyle = "rgba(25,6,8,0.5)"
		ctx.stroke()
		ctx.restore()
	}

	/** Garis bulu mata lembut saat kelopak hampir menutup. */
	drawEyelids(ctx) {
		const b = this.anim.blinkL
		if (b < 0.55) return
		const alpha = 0.32 * ((b - 0.55) / 0.45)
		const { mesh, positions: pos } = this
		for (const e of [mesh.eyes.L, mesh.eyes.R]) {
			const pts = e.upper.map((i) => [pos[i * 2], pos[i * 2 + 1]])
			ctx.beginPath()
			ctx.moveTo(pts[0][0], pts[0][1])
			for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1])
			ctx.strokeStyle = `rgba(35,22,20,${alpha.toFixed(3)})`
			ctx.lineWidth = Math.max(0.6, e.w * 0.03)
			ctx.lineCap = "round"
			ctx.stroke()
		}
	}

	/* -------------------------- panduan kalibrasi ---------------------- */

	drawGuides(ctx = null) {
		if (!this.rig) return
		if (!ctx) {
			// dipanggil dari luar loop: cukup nyalakan flag, digambar di frame berikutnya
			this.showGuides = true
			return
		}
		const idx = rigFeatureIndices(this.rig)
		const pos = this.positions
		const dot = (i, color, r) => {
			ctx.fillStyle = color
			ctx.beginPath()
			ctx.arc(pos[i * 2], pos[i * 2 + 1], r, 0, Math.PI * 2)
			ctx.fill()
		}
		const r = Math.max(1, this.rig.mouth.hw * 0.045)
		for (const i of idx.oval) dot(i, "rgba(39,131,222,0.7)", r)
		for (const i of idx.brows) dot(i, "rgba(70,161,113,0.9)", r)
		for (const i of idx.eyes) dot(i, "rgba(229,100,88,0.9)", r * 0.9)
		for (const i of idx.lips) dot(i, "rgba(255,200,40,0.95)", r)
	}

	/** Koordinat klik di elemen canvas -> piksel foto (memperhitungkan overscan). */
	clientToImage(clientX, clientY) {
		const rect = this.canvas.getBoundingClientRect()
		const W = this.image.naturalWidth
		const H = this.image.naturalHeight
		const rx = clamp((clientX - rect.left) / rect.width, 0, 1)
		const ry = clamp((clientY - rect.top) / rect.height, 0, 1)
		if (this.legacy || !this.mesh) return { x: rx * W, y: ry * H }
		return {
			x: clamp((rx - 0.5) / OVERSCAN + 0.5, 0, 1) * W,
			y: clamp((ry - 0.5) / OVERSCAN + 0.5, 0, 1) * H,
		}
	}
}
