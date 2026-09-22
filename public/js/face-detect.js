/**
 * face-detect.js - deteksi 478 titik wajah di browser dengan MediaPipe
 * FaceLandmarker (gratis, tanpa API key, model dimuat dari CDN dan di-cache
 * oleh browser). Hasil per foto disimpan di localStorage supaya kunjungan
 * berikutnya langsung siap tanpa memuat model lagi.
 */

const DEFAULT_CFG = {
	tasksUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14",
	modelUrl: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
	detectorUrl: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
}
let cfg = { ...DEFAULT_CFG }
let visionPromise = null
let landmarkerPromise = null
let detectorPromise = null

export function configureVision(partial) {
	if (!partial) return
	for (const k of Object.keys(DEFAULT_CFG)) {
		if (partial[k] && typeof partial[k] === "string") cfg[k] = partial[k]
	}
}

async function loadVision(onStatus) {
	if (!visionPromise) {
		visionPromise = (async () => {
			onStatus?.("Memuat mesin deteksi wajah...")
			const base = cfg.tasksUrl.replace(/\/$/, "")
			const mod = await import(/* @vite-ignore */ `${base}/vision_bundle.mjs`)
			const ns = mod.FaceLandmarker ? mod : mod.default && mod.default.FaceLandmarker ? mod.default : null
			if (!ns) throw new Error("Modul MediaPipe tidak dikenali")
			const fileset = await ns.FilesetResolver.forVisionTasks(`${base}/wasm`)
			return { ns, fileset }
		})().catch((error) => {
			visionPromise = null
			throw error
		})
	}
	return visionPromise
}

async function loadLandmarker(onStatus) {
	if (!landmarkerPromise) {
		landmarkerPromise = (async () => {
			const { ns, fileset } = await loadVision(onStatus)
			onStatus?.("Memuat model wajah (sekali saja, ~4 MB)...")
			const make = (delegate) =>
				ns.FaceLandmarker.createFromOptions(fileset, {
					baseOptions: { modelAssetPath: cfg.modelUrl, delegate },
					runningMode: "IMAGE",
					numFaces: 1,
					minFaceDetectionConfidence: 0.4,
					minFacePresenceConfidence: 0.4,
					outputFaceBlendshapes: false,
					outputFacialTransformationMatrixes: false,
				})
			try {
				return await make("GPU")
			} catch (error) {
				console.warn("[face] GPU delegate gagal, pakai CPU:", error?.message || error)
				return await make("CPU")
			}
		})().catch((error) => {
			landmarkerPromise = null
			throw error
		})
	}
	return landmarkerPromise
}

async function loadDetector(onStatus) {
	if (!detectorPromise) {
		detectorPromise = (async () => {
			const { ns, fileset } = await loadVision(onStatus)
			return ns.FaceDetector.createFromOptions(fileset, {
				baseOptions: { modelAssetPath: cfg.detectorUrl, delegate: "CPU" },
				runningMode: "IMAGE",
				minDetectionConfidence: 0.35,
			})
		})().catch((error) => {
			detectorPromise = null
			throw error
		})
	}
	return detectorPromise
}

/** Gambar potongan foto ke canvas dengan skala tertentu. */
function cropToCanvas(image, sx, sy, sw, sh, targetMax) {
	const scale = Math.min(4, Math.max(0.25, targetMax / Math.max(sw, sh)))
	const canvas = document.createElement("canvas")
	canvas.width = Math.max(32, Math.round(sw * scale))
	canvas.height = Math.max(32, Math.round(sh * scale))
	const ctx = canvas.getContext("2d")
	ctx.imageSmoothingQuality = "high"
	ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
	return { canvas, scale }
}

function runLandmarker(landmarker, source) {
	try {
		const result = landmarker.detect(source)
		const face = result && result.faceLandmarks && result.faceLandmarks[0]
		return face && face.length >= 468 ? face : null
	} catch (error) {
		console.warn("[face] detect error:", error?.message || error)
		return null
	}
}

/**
 * Deteksi wajah pada foto. Mengembalikan titik ternormalisasi (0..1) terhadap
 * foto penuh: [{x,y,z}] x478. Melempar Error bila tidak ada wajah.
 * @param {HTMLImageElement} image  (sudah termuat, same-origin / data URL)
 */
export async function detectFace(image, { onStatus } = {}) {
	const W = image.naturalWidth
	const H = image.naturalHeight
	if (!W || !H) throw new Error("Foto belum termuat")
	const landmarker = await loadLandmarker(onStatus)
	onStatus?.("Mendeteksi wajah...")

	const attempt = (sx, sy, sw, sh, targetMax) => {
		const { canvas, scale } = cropToCanvas(image, sx, sy, sw, sh, targetMax)
		const face = runLandmarker(landmarker, canvas)
		if (!face) return null
		return face.map((p) => ({
			x: (sx + p.x * canvas.width / scale) / W,
			y: (sy + p.y * canvas.height / scale) / H,
			z: ((p.z || 0) * canvas.width / scale) / W,
		}))
	}

	// 1. foto penuh (dibatasi 1600 px supaya cepat)
	let pts = attempt(0, 0, W, H, Math.min(1600, Math.max(W, H)))
	if (pts) return pts

	// 2. detektor wajah (BlazeFace) -> potong rapat di sekitar wajah -> landmark
	try {
		const detector = await loadDetector(onStatus)
		const regions = [
			[0, 0, W, H],
			[W * 0.15, 0, W * 0.7, H * 0.7],
			[W * 0.25, H * 0.05, W * 0.5, H * 0.55],
		]
		for (const [rx, ry, rw, rh] of regions) {
			const { canvas, scale } = cropToCanvas(image, rx, ry, rw, rh, 900)
			let det = null
			try {
				det = detector.detect(canvas)
			} catch {
				det = null
			}
			const box = det && det.detections && det.detections[0] && det.detections[0].boundingBox
			if (!box) continue
			const bx = rx + box.originX / scale
			const by = ry + box.originY / scale
			const bw = box.width / scale
			const bh = box.height / scale
			for (const [margin, target] of [[2.2, 640], [3.0, 900]]) {
				const side = Math.max(bw, bh) * margin
				const cx = bx + bw / 2
				const cy = by + bh / 2
				const sx = Math.max(0, cx - side / 2)
				const sy = Math.max(0, cy - side / 2)
				const sw = Math.min(W - sx, side)
				const sh = Math.min(H - sy, side)
				pts = attempt(sx, sy, sw, sh, target)
				if (pts) return pts
			}
		}
	} catch (error) {
		console.warn("[face] detektor cadangan gagal:", error?.message || error)
	}

	// 3. potongan tengah-atas (wajah biasanya di sana)
	for (const [fx, fy, fw, fh] of [[0.15, 0, 0.7, 0.7], [0.25, 0.05, 0.5, 0.55]]) {
		pts = attempt(W * fx, H * fy, W * fw, H * fh, 1000)
		if (pts) return pts
	}
	throw new Error("Wajah tidak terdeteksi. Pakai foto setengah badan yang menghadap kamera, atau lakukan kalibrasi manual.")
}

/* ------------------------------ cache ---------------------------------- */
const CACHE_PREFIX = "aal.face.v2."
const CACHE_INDEX = "aal.face.index"

function hashString(str) {
	let h = 5381
	for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
	return (h >>> 0).toString(36) + "-" + str.length.toString(36)
}

export function cacheKeyFor(src) {
	return CACHE_PREFIX + hashString(String(src || ""))
}

export function readFaceCache(src) {
	try {
		const raw = localStorage.getItem(cacheKeyFor(src))
		if (!raw) return null
		const data = JSON.parse(raw)
		if (!data || !Array.isArray(data.points) || data.points.length < 468) return null
		return data
	} catch {
		return null
	}
}

export function writeFaceCache(src, data) {
	try {
		const key = cacheKeyFor(src)
		const compact = {
			source: data.source || "mediapipe",
			W: data.W,
			H: data.H,
			points: data.points.map((p) => [Math.round(p.x * 1e5) / 1e5, Math.round(p.y * 1e5) / 1e5, Math.round((p.z || 0) * 1e5) / 1e5]),
		}
		localStorage.setItem(key, JSON.stringify(compact))
		// batasi jumlah entri
		let index = []
		try {
			index = JSON.parse(localStorage.getItem(CACHE_INDEX) || "[]")
		} catch {
			index = []
		}
		index = index.filter((k) => k !== key)
		index.push(key)
		while (index.length > 8) {
			const old = index.shift()
			localStorage.removeItem(old)
		}
		localStorage.setItem(CACHE_INDEX, JSON.stringify(index))
	} catch {
		/* penuh / privat - abaikan */
	}
}

export function clearFaceCache(src) {
	try {
		localStorage.removeItem(cacheKeyFor(src))
	} catch {
		/* abaikan */
	}
}

/** Ubah array [x,y,z] menjadi objek {x,y,z}. */
export function pointsFromArrays(list) {
	return list.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] || 0 } : p))
}
