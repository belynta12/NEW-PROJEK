/**
 * did.js — D-ID Streaming (WebRTC) client
 * Mengikuti spesifikasi resmi D-ID live-streaming demo
 */

const BASE = ""

let _pc = null        // RTCPeerConnection
let _dataChannel = null
let _streamId = null  // D-ID stream id
let _sessionId = null // D-ID session_id
let _videoEl = null   // elemen <video>
let _onError = null   // callback error
let _isConnecting = false
let _ready = false

export function isDidReady() {
  return _ready && Boolean(_streamId) && _pc && _pc.iceConnectionState !== "closed" && _pc.iceConnectionState !== "failed"
}

/** Mulai sesi D-ID Streaming. */
export async function startDid({ videoEl, onTrack, onError }) {
  if (videoEl) _videoEl = videoEl
  if (onError) _onError = onError
  if (_isConnecting) return
  _isConnecting = true

  try {
    if (_pc) {
      try { _pc.close() } catch {}
      _pc = null
    }

    // 1 — Minta server buat streaming session ke D-ID
    const sess = await api("POST", "/api/avatar/did/stream")
    _streamId  = sess.id
    _sessionId = sess.session_id

    // 2 — Buat RTCPeerConnection dengan ICE servers dari D-ID
    const iceServers = (sess.ice_servers || []).map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    }))
    _pc = new RTCPeerConnection({ iceServers })

    // D-ID mewajibkan Data Channel dengan nama 'JanusDataChannel' untuk signaling Janus Gateway
    _dataChannel = _pc.createDataChannel("JanusDataChannel")

    // Event video & audio track dari D-ID
    _pc.ontrack = (event) => {
      const stream = (event.streams && event.streams[0]) || (_pc.getRemoteStreams ? _pc.getRemoteStreams()[0] : null) || new MediaStream([event.track])
      if (stream && _videoEl) {
        if (_videoEl.srcObject !== stream) {
          _videoEl.srcObject = stream
          _videoEl.hidden = false
          const p = _videoEl.play()
          if (p !== undefined) {
            p.catch((err) => {
              console.warn("[did] Autoplay unmuted was prevented, muting for initial render:", err)
              _videoEl.muted = true
              _videoEl.play().catch(() => {})
            })
          }
          if (onTrack) onTrack(stream)
        }
      }
    }

    // Kirim ICE candidates lengkap (candidate, sdpMid, sdpMLineIndex) ke D-ID
    _pc.onicecandidate = (event) => {
      if (!event.candidate) return
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate
      api("POST", "/api/avatar/did/stream/ice", {
        streamId: _streamId,
        sessionId: _sessionId,
        candidate,
        sdpMid,
        sdpMLineIndex,
      }).catch((e) => console.warn("[did] ice send error:", e.message))
    }

    _pc.oniceconnectionstatechange = () => {
      console.log("[did] ICE state:", _pc.iceConnectionState)
      if (_pc.iceConnectionState === "connected" || _pc.iceConnectionState === "completed") {
        _ready = true
      } else if (_pc.iceConnectionState === "failed") {
        _ready = false
        if (_onError) _onError("Koneksi D-ID WebRTC gagal menghubungkan jalur media.")
      } else if (_pc.iceConnectionState === "disconnected") {
        _ready = false
      }
    }

    _pc.onconnectionstatechange = () => {
      console.log("[did] Connection state:", _pc.connectionState)
      if (_pc.connectionState === "connected") {
        _ready = true
      } else if (_pc.connectionState === "failed" || _pc.connectionState === "closed") {
        _ready = false
      }
    }

    // 3 — Pasang SDP offer dari D-ID
    await _pc.setRemoteDescription(new RTCSessionDescription(sess.offer))

    // 4 — Buat local SDP answer
    const answer = await _pc.createAnswer()
    await _pc.setLocalDescription(answer)

    // 5 — Kirim SDP answer ke D-ID
    await api("POST", "/api/avatar/did/stream/sdp", {
      streamId: _streamId,
      sessionId: _sessionId,
      answer,
    })

    _ready = true
    console.log("[did] Stream tersambung sukses, ID:", _streamId)
    return true
  } finally {
    _isConnecting = false
  }
}

/**
 * Ucapkan audio (Blob MP3) melalui D-ID — bibir bergerak real-time.
 * Menunggu hingga durasi bicara selesai agar alur percakapan sinkron.
 * @param {Blob} audioBlob — audio MP3 hasil Fish Audio TTS
 */
export async function speakDid(audioBlob) {
  // Jika stream belum aktif atau terputus, refresh koneksi
  if (!isDidReady()) {
    console.log("[did] Menghubungkan ulang stream sebelum bicara...")
    await startDid({ videoEl: _videoEl, onError: _onError })
  }

  // 1. Upload audio ke D-ID /audios → dapat S3 URL
  const uploaded = await apiRaw("POST", "/api/avatar/did/audio", audioBlob, "audio/mpeg")
  const audioUrl = uploaded.url

  // 2. Minta D-ID streaming gerakkan bibir dengan audio tersebut
  const talkRes = await api("POST", "/api/avatar/did/stream/talk", {
    streamId: _streamId,
    sessionId: _sessionId,
    audioUrl,
  })

  // Pastikan video berbunyi
  if (_videoEl) {
    _videoEl.muted = false
    _videoEl.play().catch(() => {})
  }

  const durationSec = Number(talkRes.duration) || 3
  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, durationSec * 1000)))
  return talkRes
}

/** Tutup sesi D-ID dan WebRTC. */
export async function stopDid() {
  _ready = false
  if (_streamId && _sessionId) {
    const payload = { streamId: _streamId, sessionId: _sessionId }
    _streamId = _sessionId = null
    try {
      await fetch(BASE + "/api/avatar/did/stream", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      })
    } catch {}
  }
  if (_pc) {
    try { _pc.close() } catch {}
    _pc = null
  }
  if (_videoEl) {
    _videoEl.srcObject = null
    _videoEl.hidden = true
  }
}

// Otomatis hapus stream di server D-ID ketika tab ditutup atau di-reload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => { stopDid() })
  window.addEventListener("pagehide", () => { stopDid() })
}

/* ---------- helpers ---------- */

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || "D-ID API error " + res.status)
  }
  return res.json()
}

async function apiRaw(method, path, blob, mimeType) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": mimeType },
    body: blob,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || "Upload audio error " + res.status)
  }
  return res.json()
}


