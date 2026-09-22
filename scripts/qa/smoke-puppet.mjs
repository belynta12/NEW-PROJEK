/**
 * Smoke test tanpa browser: jalankan PhotoPuppet & Speaker dengan DOM/WebGL/WebAudio palsu
 * untuk menangkap kesalahan runtime (typo, referensi undefined) di jalur utama.
 * Pakai: node scripts/qa/smoke-puppet.mjs <landmarks.json>
 */
import fs from "node:fs"

const lmPath = process.argv[2]
const landmarks = JSON.parse(fs.readFileSync(lmPath, "utf8")).map(([x, y, z]) => ({ x, y, z }))
const calls = { gl: 0, ctx2d: 0 }

function makeProxy(overrides, onCall) {
	return new Proxy(
		{},
		{
			get(target, prop) {
				if (prop in overrides) return overrides[prop]
				if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return 7
				if (prop in target) return target[prop]
				return (...args) => {
					onCall?.(prop, args)
					return {}
				}
			},
			set(target, prop, value) {
				target[prop] = value
				return true
			},
		},
	)
}

const gradient = { addColorStop() {} }
function fake2D() {
	return makeProxy(
		{
			createLinearGradient: () => gradient,
			createRadialGradient: () => gradient,
			getImageData: () => ({ data: new Uint8ClampedArray([180, 120, 110, 255]) }),
			canvas: {},
		},
		() => calls.ctx2d++,
	)
}
let webglAvailable = true
function fakeGL() {
	return makeProxy(
		{
			getShaderParameter: () => true,
			getProgramParameter: () => true,
			getAttribLocation: () => 0,
			getUniformLocation: () => ({}),
			getParameter: () => 4096,
			getExtension: () => null,
			getShaderInfoLog: () => "",
			getProgramInfoLog: () => "",
		},
		() => calls.gl++,
	)
}
class FakeCanvas {
	constructor() {
		this.width = 300
		this.height = 150
		this.style = {}
		this.hidden = false
	}
	getContext(type) {
		if (type === "2d") return fake2D()
		if (!webglAvailable) return null
		return fakeGL()
	}
	addEventListener() {}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: this.width, height: this.height }
	}
}
class FakeImage {
	constructor() {
		this.naturalWidth = 400
		this.naturalHeight = 533
	}
	set src(v) {
		this._src = v
		setTimeout(() => this.onload && this.onload(), 0)
	}
	get src() {
		return this._src
	}
}
globalThis.window = globalThis
globalThis.devicePixelRatio = 2
globalThis.matchMedia = () => ({ matches: false })
globalThis.WebGL2RenderingContext = class {}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 5)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { createElement: () => new FakeCanvas() }
globalThis.Image = FakeImage
globalThis.speechSynthesis = undefined

// --- WebAudio palsu ---
class FakeAudioContext {
	constructor() {
		this.state = "running"
		this.destination = {}
	}
	get currentTime() {
		return performance.now() / 1000
	}
	resume() {
		return Promise.resolve()
	}
	async decodeAudioData() {
		const sr = 16000
		const n = sr * 1.2
		const data = new Float32Array(n)
		for (let i = 0; i < n; i++) data[i] = Math.sin(i * 0.05) * (0.5 + 0.5 * Math.sin(i / 800)) * (i > 1000 && i < n - 1000 ? 1 : 0)
		return { sampleRate: sr, duration: n / sr, getChannelData: () => data }
	}
	createBufferSource() {
		const src = {
			connect() {},
			disconnect() {},
			start() {
				setTimeout(() => src.onended && src.onended(), 120)
			},
			stop() {},
		}
		return src
	}
	createGain() {
		return { connect() {}, disconnect() {}, gain: { setTargetAtTime() {} } }
	}
	createAnalyser() {
		return { connect() {}, fftSize: 1024, frequencyBinCount: 512, getByteTimeDomainData() {}, getByteFrequencyData() {} }
	}
	createMediaElementSource() {
		return { connect() {} }
	}
}
globalThis.AudioContext = FakeAudioContext

const { PhotoPuppet } = await import("../../public/js/puppet.js")
const { Speaker } = await import("../../public/js/audio.js")

async function runPuppet(label) {
	const canvas = new FakeCanvas()
	const p = new PhotoPuppet(canvas)
	await p.setImage("foto.jpg")
	let t = performance.now()
	const frames = (n, tag) => {
		for (let i = 0; i < n; i++) {
			t += 16.7
			p.draw(t)
		}
		console.log(`  [${label}] ${tag}: ok (jaw=${p.mouth.jaw.toFixed(2)} blink=${p.anim.blinkL.toFixed(2)} yaw=${p.anim.yaw.toFixed(3)})`)
	}
	frames(3, "tanpa wajah")
	p.setLandmarks(landmarks)
	console.log(`  [${label}] rig: ${p.rig.source}, mesh ${p.mesh ? p.mesh.n : "-"} titik, legacy=${Boolean(p.legacy)}`)
	p.setState("listening")
	frames(20, "listening")
	p.setState("thinking")
	frames(20, "thinking")
	p.setState("speaking")
	for (let i = 0; i < 40; i++) {
		p.setMouth({ jaw: 0.4 + 0.4 * Math.sin(i / 3), wide: 0.5, round: 0.2, press: 0, lowerLipIn: 0, upperRaise: 0.2, energy: 0.8 })
		t += 16.7
		p.draw(t)
	}
	console.log(`  [${label}] speaking viseme: ok (jaw=${p.mouth.jaw.toFixed(2)})`)
	p.setMouth(null)
	p.setLevel(0.6, 0.8)
	frames(10, "speaking level")
	p.setState("idle")
	frames(10, "idle")
	// kedip paksa
	p.blink.next = 0
	frames(20, "blink")
	p.showGuides = true
	frames(2, "guides")
	p.showGuides = false
	console.log("  clientToImage:", JSON.stringify(p.clientToImage(150, 75)))
	p.setTemplateRig({ eyeLeftScreen: { x: 176, y: 167 }, eyeRightScreen: { x: 238, y: 169 }, mouth: { x: 208, y: 229 } })
	frames(10, "template rig")
	p.lipGain = 1.4
	p.bodyMotion = 1.8
	frames(5, "slider ekstrem")
	await p.setImage("foto2.jpg")
	frames(3, "ganti foto")
}

console.log("== PhotoPuppet (WebGL) ==")
await runPuppet("webgl")
console.log(`   panggilan gl=${calls.gl} ctx2d=${calls.ctx2d}`)
console.log("== PhotoPuppet (fallback 2D) ==")
webglAvailable = false
await runPuppet("legacy")

console.log("== Speaker ==")
let mouthCalls = 0
let nullCalls = 0
const el = { pause() {}, play: () => Promise.resolve(), paused: true, ended: true }
const sp = new Speaker(el, {
	onMouth: (m) => {
		if (m) mouthCalls++
		else nullCalls++
	},
})
const blob = { arrayBuffer: async () => new ArrayBuffer(16) }
const item = await sp.prepare({ blob, text: "Halo, ini uji suara avatar." })
console.log(`  prepare: durasi=${item.duration?.toFixed(2)} segmen=${item.track ? item.track.segs.length : "-"}`)
const t0 = performance.now()
const p1 = sp.enqueue(item)
const p2 = sp.enqueue(await sp.prepare({ blob, text: "Kalimat kedua." }))
await p1
const t1 = performance.now() - t0
await p2
const t2 = performance.now() - t0
console.log(`  enqueue berurutan: item1 selesai ${t1.toFixed(0)}ms, item2 selesai ${t2.toFixed(0)}ms (harus ~120 & ~240), onMouth=${mouthCalls} null=${nullCalls}`)
if (t1 < 100 || t2 < 200) throw new Error("antrean Speaker tidak menunggu pemutaran")
const p3 = sp.enqueue(await sp.prepare({ blob, text: "Akan dihentikan." }))
setTimeout(() => sp.stop(), 30)
await p3
console.log("  stop(): antrean terselesaikan, playing=" + sp.playing)
console.log("SMOKE OK")
