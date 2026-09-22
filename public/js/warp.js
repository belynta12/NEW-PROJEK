/**
 * warp.js - perender mesh WebGL untuk PhotoPuppet.
 * Foto dipasang sebagai tekstur, lalu digambar sebagai ratusan segitiga
 * yang posisinya diubah tiap frame (UV tetap = foto asli).
 */

const VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uSize;
uniform float uOver;
varying vec2 vUV;
void main() {
	vUV = aUV;
	vec2 c = (aPos / uSize * 2.0 - 1.0) * uOver;
	gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() {
	gl_FragColor = texture2D(uTex, vUV);
}`

export class MeshWarper {
	constructor() {
		this.canvas = document.createElement("canvas")
		const opts = {
			alpha: true,
			antialias: true,
			premultipliedAlpha: true,
			preserveDrawingBuffer: false,
			depth: false,
			stencil: false,
			powerPreference: "high-performance",
		}
		this.gl =
			this.canvas.getContext("webgl2", opts) ||
			this.canvas.getContext("webgl", opts) ||
			this.canvas.getContext("experimental-webgl", opts)
		if (!this.gl) throw new Error("WebGL tidak tersedia di browser ini")
		this.lost = false
		this.canvas.addEventListener("webglcontextlost", (event) => {
			event.preventDefault()
			this.lost = true
		})
		this.canvas.addEventListener("webglcontextrestored", () => {
			this.lost = false
			this.init()
			if (this.texSource) this.setTexture(this.texSource)
			if (this.mesh) this.setMesh(this.mesh)
		})
		this.init()
	}

	init() {
		const gl = this.gl
		const compile = (type, src) => {
			const shader = gl.createShader(type)
			gl.shaderSource(shader, src)
			gl.compileShader(shader)
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				throw new Error("Shader gagal: " + gl.getShaderInfoLog(shader))
			}
			return shader
		}
		const program = gl.createProgram()
		gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
		gl.linkProgram(program)
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error("Program WebGL gagal: " + gl.getProgramInfoLog(program))
		}
		gl.useProgram(program)
		this.program = program
		this.aPos = gl.getAttribLocation(program, "aPos")
		this.aUV = gl.getAttribLocation(program, "aUV")
		this.uSize = gl.getUniformLocation(program, "uSize")
		this.uOver = gl.getUniformLocation(program, "uOver")
		this.uTex = gl.getUniformLocation(program, "uTex")
		this.posBuf = gl.createBuffer()
		this.uvBuf = gl.createBuffer()
		this.idxBuf = gl.createBuffer()
		this.texture = gl.createTexture()
		gl.bindTexture(gl.TEXTURE_2D, this.texture)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
		gl.disable(gl.CULL_FACE)
		gl.disable(gl.DEPTH_TEST)
		gl.disable(gl.BLEND)
		gl.clearColor(0, 0, 0, 0)
		this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096
		this.count = 0
	}

	setSize(width, height) {
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width
			this.canvas.height = height
		}
		this.gl.viewport(0, 0, width, height)
	}

	/** source: HTMLImageElement / HTMLCanvasElement (sudah disesuaikan ukurannya). */
	setTexture(source) {
		const gl = this.gl
		this.texSource = source
		gl.bindTexture(gl.TEXTURE_2D, this.texture)
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
	}

	setMesh(mesh) {
		const gl = this.gl
		this.mesh = mesh
		gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf)
		gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf)
		gl.bufferData(gl.ARRAY_BUFFER, mesh.rest, gl.DYNAMIC_DRAW)
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf)
		this.use32 = mesh.tris instanceof Uint32Array
		if (this.use32) {
			const ext = gl.getExtension("OES_element_index_uint")
			if (!ext && !(gl instanceof (window.WebGL2RenderingContext || function () {}))) {
				throw new Error("Mesh terlalu besar untuk WebGL1")
			}
		}
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.tris, gl.STATIC_DRAW)
		this.count = mesh.tris.length
	}

	/** positions: Float32Array(2n) dalam piksel foto. */
	render(positions, imageW, imageH, overscan = 1) {
		const gl = this.gl
		if (this.lost || !this.mesh) return false
		gl.useProgram(this.program)
		gl.clear(gl.COLOR_BUFFER_BIT)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf)
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions)
		gl.enableVertexAttribArray(this.aPos)
		gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf)
		gl.enableVertexAttribArray(this.aUV)
		gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 0, 0)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.texture)
		gl.uniform1i(this.uTex, 0)
		gl.uniform2f(this.uSize, imageW, imageH)
		gl.uniform1f(this.uOver, overscan)
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf)
		gl.drawElements(gl.TRIANGLES, this.count, this.use32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0)
		return true
	}

	dispose() {
		const ext = this.gl.getExtension("WEBGL_lose_context")
		if (ext) ext.loseContext()
	}
}
