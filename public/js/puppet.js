/**
 * PhotoPuppet - menganimasikan SATU foto diam menjadi avatar bicara.
 * Semua di browser, tanpa API, tanpa biaya.
 *
 * Yang dianimasikan:
 *  - mulut  : buka/tutup mengikuti amplitudo suara (lipsync) + bentuk vokal
 *  - kepala : angguk, miring, dan gerak halus saat bicara
 *  - badan  : napas + goyangan pelan
 *  - mata   : berkedip otomatis
 */

const DPR = Math.min(window.devicePixelRatio || 1, 2)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t

export class PhotoPuppet {
	constructor(canvas) {
		this.canvas = canvas
		this.ctx = canvas.getContext("2d")
		this.image = null
		this.rig = null
		this.state = "idle"
		this.level = 0
		this.rawLevel = 0
		this.tone = 0.5
		this.openSmooth = 0
		this.wideSmooth = 0
		this.nodSmooth = 0
		this.bodyMotion = 1
		this.lipGain = 1.5
		this.blink = { next: performance.now() + 2000, start: 0, active: false, dur: 160, doubleBlink: false }
		this.running = false
		this.patch = document.createElement("canvas")
		this.patchCtx = this.patch.getContext("2d")
		this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	}

	/* ----------------------------- setup ------------------------------ */

	async setImage(src) {
		const image = await loadImage(src)
		this.image = image
		this.resize()
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
	}

	/** Perkiraan awal posisi wajah untuk foto potret standar. */
	autoRig() {
		if (!this.image) return null
		const W = this.image.naturalWidth
		const H = this.image.naturalHeight
		const eyeY = H * 0.26
		this.rig = {
			eyeL: { x: W * 0.42, y: eyeY, w: W * 0.075, h: H * 0.028 },
			eyeR: { x: W * 0.58, y: eyeY, w: W * 0.075, h: H * 0.028 },
			mouth: { x: W * 0.5, y: H * 0.4, w: W * 0.13, h: H * 0.055 },
			head: { x: W * 0.5, y: H * 0.3, rx: W * 0.2, ry: H * 0.26 },
		}
		return this.rig
	}

	setRig(rig) {
		this.rig = rig
	}

	/** Hitung ulang elips kepala dari posisi mata + mulut. */
	deriveHead() {
		if (!this.rig) return
		const { eyeL, eyeR, mouth } = this.rig
		const eyeMidX = (eyeL.x + eyeR.x) / 2
		const eyeMidY = (eyeL.y + eyeR.y) / 2
		const eyeDist = Math.max(20, Math.abs(eyeR.x - eyeL.x))
		this.rig.head = {
			x: (eyeMidX + mouth.x) / 2,
			y: eyeMidY - eyeDist * 0.25,
			rx: eyeDist * 1.5,
			ry: eyeDist * 2.1,
		}
	}

	setState(state) {
		this.state = state
		if (state !== "speaking") this.rawLevel = 0
	}

	/** level 0..1 (kekuatan suara), tone 0..1 (nada tinggi = mulut lebih lebar) */
	setLevel(level, tone = 0.5) {
		this.rawLevel = clamp(level, 0, 1)
		this.tone = clamp(tone, 0, 1)
	}

	start() {
		if (this.running) return
		this.running = true
		const loop = () => {
			if (!this.running) return
			this.draw(performance.now())
			requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	}

	stop() {
		this.running = false
	}

	/* ----------------------------- render ----------------------------- */

	draw(now) {
		const { ctx, canvas, image } = this
		if (!image) return
		const t = now / 1000

		// Envelope mulut: buka responsif, tutup tegas saat jeda suku kata & konsonan
		const raw = this.rawLevel < 0.01 ? 0 : this.rawLevel
		const target = clamp(raw * this.lipGain, 0, 1)
		this.openSmooth = lerp(this.openSmooth, target, target > this.openSmooth ? 0.70 : 0.45)
		this.wideSmooth = lerp(this.wideSmooth, this.tone, 0.32)

		const m = this.reduceMotion ? 0.25 : this.bodyMotion
		const speaking = this.state === "speaking"

		const scale = canvas.width / image.naturalWidth
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.clearRect(0, 0, canvas.width, canvas.height)
		ctx.save()
		ctx.scale(scale, scale)

		// --- napas & goyangan halus satu tubuh penuh (tanpa memotong leher/kepala) ---
		const W = image.naturalWidth
		const H = image.naturalHeight
		const breathCycle = Math.sin(t * 1.3)
		const breath = 1 + Math.sign(breathCycle) * Math.pow(Math.abs(breathCycle), 1.2) * 0.007 * m + this.openSmooth * 0.003 * m
		const sway = (Math.sin(t * 0.35) * 0.35 + Math.sin(t * 0.75) * 0.15) * m * (Math.PI / 180)
		const shiftX = Math.sin(t * 0.25) * W * 0.0035 * m

		// Anggukan dan gestur bicara halus proporsional (conversational nod & tilt)
		let nodY = 0
		let nodRot = 0
		if (speaking) {
			const nodMax = H * 0.007
			nodY = (Math.sin(t * 4.2) * 0.35 + this.openSmooth * 0.65) * nodMax * m
			nodRot = Math.sin(t * 3.1) * 0.007 * m
		}

		ctx.save()
		ctx.translate(W / 2 + shiftX, H)
		ctx.rotate(sway + nodRot)
		ctx.scale(1, breath)
		ctx.translate(-W / 2, -H + nodY)

		// 1. Gambar foto asli utuh (tidak dipotong-potong)
		ctx.drawImage(image, 0, 0)

		// 2. Animasi ekspresi alami pada foto (kedip mata & gerak bibir elastis)
		if (this.rig) {
			this.drawBlink(ctx, t)
			this.drawMouth(ctx)
		}

		ctx.restore()
		ctx.restore()
	}

	drawMouth(ctx) {
		const { image, rig } = this
		if (!rig || !rig.mouth) return
		const mouth = rig.mouth
		const open = this.openSmooth
		const wide = this.wideSmooth

		// Jika tidak sedang bicara, biarkan foto asli 100% utuh tanpa modifikasi
		if (open <= 0.015) return

		const mx = mouth.x
		const my = mouth.y // 229

		const pw = Math.round(mouth.w * 1.5) // ~84px
		const ph = Math.round(mouth.h * 4.2) // ~67px (ruang pergerakan dagu vertikal yang lebih leluasa)
		const px = Math.round(mx - pw / 2)
		const py = Math.round(my - mouth.h * 1.1)
		const seamY = Math.round(my - py)

		if (this.patch.width !== pw || this.patch.height !== ph) {
			this.patch.width = pw
			this.patch.height = ph
		}
		const pctx = this.patchCtx
		pctx.setTransform(1, 0, 0, 1, 0, 0)
		pctx.clearRect(0, 0, pw, ph)

		// Bukaan mulut lebih leluasa, jelas dan ekspresif layaknya manusia bicara
		const maxGap = Math.max(18, mouth.h * 1.25)
		const gap = open * maxGap
		const upperLift = gap * 0.16
		const lowerDrop = gap * 0.84
		const hw = (mouth.w / 2) * (0.80 + (wide - 0.5) * 0.35)
		const cx = pw / 2

		// 1. Rongga Mulut (Aperture antara bibir atas dan bibir bawah)
		pctx.save()
		pctx.beginPath()
		pctx.moveTo(cx - hw, seamY)
		pctx.quadraticCurveTo(cx, seamY - upperLift, cx + hw, seamY)
		pctx.quadraticCurveTo(cx, seamY + lowerDrop, cx - hw, seamY)
		pctx.closePath()
		pctx.clip()

		const cavGrad = pctx.createRadialGradient(cx, seamY + lowerDrop * 0.35, 1, cx, seamY + lowerDrop * 0.35, hw)
		cavGrad.addColorStop(0, "#100305")
		cavGrad.addColorStop(0.65, "#1d070b")
		cavGrad.addColorStop(1, "#290a0e")
		pctx.fillStyle = cavGrad
		pctx.fillRect(0, 0, pw, ph)

		// Baris gigi atas alami (enamel ivory lembut saat mulut terbuka)
		if (gap > 1.8) {
			pctx.save()
			const toothH = Math.min(gap * 0.44, 5.8)
			const toothW = hw * 0.74
			pctx.beginPath()
			pctx.moveTo(cx - toothW, seamY - upperLift * 0.5)
			pctx.quadraticCurveTo(cx, seamY - upperLift, cx + toothW, seamY - upperLift * 0.5)
			pctx.quadraticCurveTo(cx, seamY - upperLift + toothH, cx - toothW, seamY - upperLift * 0.5)
			pctx.closePath()
			const toothGrad = pctx.createLinearGradient(cx, seamY - upperLift, cx, seamY - upperLift + toothH)
			toothGrad.addColorStop(0, "#ded8cf")
			toothGrad.addColorStop(0.3, "#f6f2ea")
			toothGrad.addColorStop(0.85, "#eee8dc")
			toothGrad.addColorStop(1, "#c2b8aa")
			pctx.fillStyle = toothGrad
			pctx.fill()

			pctx.strokeStyle = "rgba(100, 70, 70, 0.25)"
			pctx.lineWidth = 0.7
			for (const offset of [-toothW * 0.45, -toothW * 0.15, toothW * 0.15, toothW * 0.45]) {
				pctx.beginPath()
				pctx.moveTo(cx + offset, seamY - upperLift)
				pctx.lineTo(cx + offset, seamY - upperLift + toothH * 0.9)
				pctx.stroke()
			}
			pctx.restore()
		}

		// Bayangan bibir atas ke dalam rongga mulut
		const shadowGrad = pctx.createLinearGradient(cx, seamY - upperLift, cx, seamY - upperLift + Math.max(2, gap * 0.4))
		shadowGrad.addColorStop(0, "rgba(15, 3, 5, 0.9)")
		shadowGrad.addColorStop(1, "rgba(15, 3, 5, 0)")
		pctx.fillStyle = shadowGrad
		pctx.fillRect(cx - hw, seamY - upperLift, hw * 2, gap * 0.5)
		pctx.restore()

		// 2. Bibir Bawah Alami: SATU bibir bawah asli bergerak turun bersama rahang
		// Dibatasi hanya di area mulut, meredup halus ke sudut bibir (tanpa menyentuh/menarik pipi)
		pctx.save()
		pctx.beginPath()
		pctx.moveTo(cx - hw, seamY)
		pctx.quadraticCurveTo(cx, seamY + lowerDrop, cx + hw, seamY)
		const lipH = Math.round(mouth.h * 1.05)
		pctx.quadraticCurveTo(cx, seamY + lowerDrop + lipH, cx - hw, seamY)
		pctx.closePath()
		pctx.clip()

		// Ambil bibir bawah asli dan geser turun sebesar lowerDrop (hanya 1 bibir, bebas bibir ganda)
		pctx.drawImage(image, px, py, pw, ph, 0, lowerDrop, pw, ph)
		pctx.restore()

		// 3. Feathering elips halus di kulit terluar patch
		pctx.save()
		pctx.globalCompositeOperation = "destination-in"
		pctx.translate(cx, seamY + lowerDrop * 0.3)
		pctx.scale(1, ph / pw)
		const feather = pctx.createRadialGradient(0, 0, pw * 0.32, 0, 0, pw * 0.50)
		feather.addColorStop(0, "rgba(0,0,0,1)")
		feather.addColorStop(0.80, "rgba(0,0,0,0.95)")
		feather.addColorStop(0.95, "rgba(0,0,0,0.3)")
		feather.addColorStop(1, "rgba(0,0,0,0)")
		pctx.fillStyle = feather
		pctx.beginPath()
		pctx.arc(0, 0, pw * 0.50, 0, Math.PI * 2)
		pctx.fill()
		pctx.restore()

		// 4. Tempelkan patch mulus langsung ke foto utama
		ctx.drawImage(this.patch, px, py)
	}

	drawBlink(ctx, t) {
		const now = t * 1000
		const b = this.blink
		if (!b.active && now >= b.next) {
			b.active = true
			b.start = now
			b.dur = 160
			b.doubleBlink = Math.random() < 0.18
		}
		let progress = 0
		if (b.active) {
			const d = now - b.start
			if (d < 60) {
				progress = Math.sin((d / 60) * (Math.PI / 2))
			} else if (d < 85) {
				progress = 1
			} else if (d < b.dur) {
				const p = (d - 85) / (b.dur - 85)
				progress = Math.cos(p * (Math.PI / 2))
			} else {
				b.active = false
				if (b.doubleBlink) {
					b.doubleBlink = false
					b.next = now + 140
				} else {
					b.next = now + 2400 + Math.random() * 3600
				}
			}
		}
		if (progress < 0.02) return

		for (const eye of [this.rig.eyeL, this.rig.eyeR]) {
			if (!eye) continue
			const w = eye.w
			const h = Math.max(4, eye.h)
			const cx = eye.x
			const cy = eye.y

			ctx.save()
			ctx.beginPath()
			ctx.ellipse(cx, cy, w * 0.54, h * 0.70, 0, 0, Math.PI * 2)
			ctx.clip()

			// Turunkan kelopak kulit dari atas mata
			const srcY = eye.y - h * 1.8
			const dh = h * 1.55 * progress
			ctx.drawImage(
				this.image,
				eye.x - w / 2,
				srcY,
				w,
				h * 1.2,
				cx - w / 2,
				cy - h * 0.75,
				w,
				dh,
			)

			// Garis bulu mata halus saat kelopak turun
			if (progress > 0.4) {
				ctx.strokeStyle = `rgba(28, 20, 18, ${0.55 * progress})`
				ctx.lineWidth = Math.max(1, h * 0.12)
				ctx.beginPath()
				ctx.ellipse(cx, cy - h * 0.75 + dh, w * 0.44, h * 0.12, 0, 0, Math.PI)
				ctx.stroke()
			}
			ctx.restore()
		}
	}

	/* -------------------------- panduan kalibrasi ---------------------- */

	drawGuides() {
		if (!this.image || !this.rig) return
		const { ctx, canvas } = this
		const scale = canvas.width / this.image.naturalWidth
		ctx.save()
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.scale(scale, scale)
		ctx.strokeStyle = "#2783de"
		ctx.lineWidth = Math.max(2, this.image.naturalWidth * 0.004)
		const { mouth, eyeL, eyeR, head } = this.rig
		ctx.beginPath()
		ctx.ellipse(head.x, head.y, head.rx, head.ry, 0, 0, Math.PI * 2)
		ctx.stroke()
		ctx.strokeRect(mouth.x - mouth.w / 2, mouth.y - mouth.h / 2, mouth.w, mouth.h)
		for (const eye of [eyeL, eyeR]) {
			ctx.beginPath()
			ctx.ellipse(eye.x, eye.y, eye.w / 2, eye.h, 0, 0, Math.PI * 2)
			ctx.stroke()
		}
		ctx.restore()
	}

	/** Ubah koordinat klik di elemen canvas menjadi koordinat piksel foto. */
	clientToImage(clientX, clientY) {
		const rect = this.canvas.getBoundingClientRect()
		const rx = (clientX - rect.left) / rect.width
		const ry = (clientY - rect.top) / rect.height
		return {
			x: clamp(rx, 0, 1) * this.image.naturalWidth,
			y: clamp(ry, 0, 1) * this.image.naturalHeight,
		}
	}
}

export function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.crossOrigin = "anonymous"
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error("Foto gagal dimuat"))
		img.src = src
	})
}
