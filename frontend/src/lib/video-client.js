import { apiBase } from "./api.js"

export function formatSeconds(value) {
  const total = Math.max(0, Math.floor(value ?? 0))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

export function readVideoDurationMs(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement("video")
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(value)
    }
    video.preload = "metadata"
    video.onloadedmetadata = () => {
      const seconds = video.duration
      finish(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null)
    }
    video.onerror = () => finish(null)
    video.src = url
  })
}

function readError(payload, fallback) {
  const detail = payload?.error
  if (typeof detail === "string" && detail.trim()) return detail
  return fallback
}

export async function requestVideoSubtitles(file, lang, options = {}) {
  const { signal, onProgress } = options

  const upload = new XMLHttpRequest()
  const done = new Promise((resolve, reject) => {
    upload.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
    }
    upload.onload = () => {
      let payload = null
      try {
        payload = JSON.parse(upload.responseText)
      } catch {
        payload = null
      }
      if (upload.status >= 200 && upload.status < 300 && payload?.ok) {
        resolve(payload)
        return
      }
      reject(new Error(readError(payload, "No se pudieron generar los subtítulos del video.")))
    }
    upload.onerror = () => reject(new Error("No se pudo conectar con el servidor."))
    upload.onabort = () => reject(new Error("Se canceló la generación de subtítulos."))
    upload.ontimeout = () => reject(new Error("El servidor tardó demasiado en responder."))
  })

  const url = new URL(`${apiBase()}/api/video/subtitles`)
  url.searchParams.set("lang", lang)
  upload.open("POST", url.toString())
  upload.setRequestHeader("Content-Type", file.type || "application/octet-stream")
  upload.setRequestHeader("x-file-name", encodeURIComponent(file.name || "video.mp4"))
  upload.timeout = 0

  if (signal) {
    if (signal.aborted) {
      upload.abort()
      throw new Error("Se canceló la generación de subtítulos.")
    }
    signal.addEventListener("abort", () => upload.abort(), { once: true })
  }

  upload.send(file)
  if (onProgress) onProgress(0)
  return done
}

export function cuesToSegments(cues) {
  return (cues ?? [])
    .filter((cue) => cue && (cue.original || cue.translation))
    .map((cue) => ({
      id: `${cue.start}`,
      ts: Math.max(0, Math.round((cue.start ?? 0) * 1000)),
      original: cue.original ?? "",
      translation: cue.translation ?? "",
    }))
}
