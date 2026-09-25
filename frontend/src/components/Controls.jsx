import { useRef } from "react"

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

export default function Controls({
  phase,
  sourceInfo,
  processingFile,
  progress,
  canDownload,
  onStartMic,
  onPlayFile,
  onStop,
  onDownloadSrt,
}) {
  const fileRef = useRef(null)
  const busy = phase === "connecting" || processingFile
  const percent = Math.round((progress ?? 0) * 100)
  const durationMs = sourceInfo?.durationMs ?? 0
  const elapsedMs = (progress ?? 0) * durationMs

  const handleFile = (event) => {
    const file = event.target.files?.[0]
    if (file) onPlayFile(file)
    event.target.value = ""
  }

  return (
    <div className="controls">
      <button className="btn btn-primary" onClick={onStartMic} disabled={busy}>
        Iniciar micrófono
      </button>
      <button className="btn btn-file" onClick={() => fileRef.current?.click()} disabled={busy}>
        Subir archivo
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm, video/*,.mp4,.m4v,.mov"
        style={{ display: "none" }}
        onChange={handleFile}
      />
      <button className="btn btn-stop" onClick={onStop} disabled={!busy && phase !== "live"}>
        Detener
      </button>
      {canDownload && !busy ? (
        <button className="btn btn-srt" onClick={onDownloadSrt}>
          Descargar .srt
        </button>
      ) : null}

      {processingFile ? (
        <div className="progress" data-testid="file-progress">
          <div
            className="progress-fill"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin="0"
            aria-valuemax="100"
          />
          <span className="progress-label">
            {percent >= 100
              ? "Finalizando…"
              : durationMs > 0
                ? `Transcribiendo… ${percent}% (${formatDuration(elapsedMs)} / ${formatDuration(durationMs)})`
                : `Transcribiendo… ${percent}%`}
          </span>
        </div>
      ) : null}

      {sourceInfo ? (
        <span className="source-info">
          {sourceInfo.name} · {formatDuration(sourceInfo.durationMs)}
        </span>
      ) : null}
    </div>
  )
}