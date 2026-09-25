import { useRef, useState } from "react"
import Segment from "../../components/Segment.jsx"
import { downloadSrt } from "../../lib/subtitles.js"
import { cuesToSegments, formatSeconds, readVideoDurationMs, requestVideoSubtitles } from "../../lib/video-client.js"
import { langName } from "../session-meta.js"

const TARGET_LANGS = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
]

const PHASES = {
  idle: "Elegí un video y el idioma de los subtítulos.",
  probing: "Leyendo la duración del video…",
  uploading: "Subiendo el video a Gemini…",
  analyzing: "Gemini está viendo y escuchando el video. Puede tardar varios minutos…",
  done: "Listo.",
}

const formatBytes = (bytes) => {
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export default function VideoSubtitles({ maxSeconds, maxBytes }) {
  const fileRef = useRef(null)
  const abortRef = useRef(null)
  const [targetLang, setTargetLang] = useState("es")
  const [file, setFile] = useState(null)
  const [phase, setPhase] = useState("idle")
  const [uploadProgress, setUploadProgress] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const busy = phase === "probing" || phase === "uploading" || phase === "analyzing"
  const segments = result ? cuesToSegments(result.cues) : []
  const tooBig = file ? file.size > maxBytes : false

  const pick = (event) => {
    const next = event.target.files?.[0]
    event.target.value = ""
    if (!next) return
    setFile(next)
    setResult(null)
    setError(null)
    setPhase("idle")
    setUploadProgress(0)
  }

  const generate = async () => {
    if (!file || busy) return
    setError(null)
    setResult(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      setPhase("probing")
      const durationMs = await readVideoDurationMs(file)
      if (controller.signal.aborted) return
      if (durationMs && durationMs / 1000 > maxSeconds) {
        setError(
          `El video dura ${formatSeconds(durationMs / 1000)} y el límite es ${formatSeconds(maxSeconds)}. Recortalo o dividilo en partes.`,
        )
        setPhase("idle")
        return
      }

      setPhase("uploading")
      setUploadProgress(0)
      const payload = await requestVideoSubtitles(file, targetLang, {
        signal: controller.signal,
        onProgress: (value) => {
          setPhase("analyzing")
          setUploadProgress(value)
        },
      })
      if (controller.signal.aborted) return
      if (!payload.cues?.length) {
        setError(
          "Gemini no devolvió subtítulos para este video. Probá con un clip que tenga voz clara.",
        )
      }
      setResult(payload)
      setPhase("done")
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : "No se pudieron generar los subtítulos.")
      setPhase("idle")
    } finally {
      abortRef.current = null
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase("idle")
    setUploadProgress(0)
  }

  return (
    <div className="content tight">
      <div className="controls" data-tour="video-controls">
        <button
          className="btn btn-file"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          Elegir video
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.m4v,.mov,.webm,.mkv"
          style={{ display: "none" }}
          onChange={pick}
        />
        <select
          className="input"
          value={targetLang}
          onChange={(event) => setTargetLang(event.target.value)}
          disabled={busy}
          aria-label="Idioma de los subtítulos"
        >
          {TARGET_LANGS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
        {busy ? (
          <button className="btn btn-stop" onClick={cancel}>
            Cancelar
          </button>
        ) : (
          <button className="btn btn-primary" onClick={generate} disabled={!file || tooBig}>
            Generar subtítulos
          </button>
        )}
        {!busy && segments.length > 0 ? (
          <button
            className="btn btn-srt"
            onClick={() =>
              downloadSrt(
                segments,
                { durationMs: result?.durationSeconds ? result.durationSeconds * 1000 : null },
                `subtitulos-${file?.name?.replace(/\.[^.]+$/, "") ?? "video"}.srt`,
              )
            }
          >
            Descargar .srt
          </button>
        ) : null}
      </div>

      {busy ? (
        <div className="progress" data-testid="video-progress">
          <div
            className="progress-fill"
            style={{ width: phase === "analyzing" ? "100%" : `${Math.round(uploadProgress * 100)}%` }}
            role="progressbar"
            aria-valuenow={phase === "analyzing" ? 100 : Math.round(uploadProgress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
          <span className="progress-label">
            {phase === "probing"
              ? PHASES.probing
              : phase === "uploading"
                ? `${PHASES.uploading} ${Math.round(uploadProgress * 100)}%`
                : PHASES.analyzing}
          </span>
        </div>
      ) : (
        <p className="sess-note">{PHASES[phase]}</p>
      )}

      {tooBig ? (
        <div className="error-banner" role="alert">
          El video pesa {formatBytes(file.size)} y el límite es {formatBytes(maxBytes)}.
        </div>
      ) : null}
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {file ? (
        <p className="sess-note">
          {file.name} · {formatBytes(file.size)} · hasta{" "}
          {formatSeconds(maxSeconds)} · subtítulos en {langName(targetLang)}
        </p>
      ) : null}

      <section className="card translation-panel" data-testid="video-transcript-panel">
        <div className="translation-head">
          <span aria-hidden="true" />
          <span className="col-original">Original</span>
          <span className="col-translation">Traducción ({langName(targetLang)})</span>
        </div>
        <div className="translation-scroll">
          {segments.length === 0 ? (
            <div className="empty-state">
              <span className="big">…</span>
              <p>
                Los subtítulos del video aparecen acá, en dos columnas: lo que se dice y la
                traducción al idioma que elegiste.
              </p>
            </div>
          ) : (
            <div className="segments">
              {segments.map((segment) => (
                <Segment key={segment.id} segment={segment} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
