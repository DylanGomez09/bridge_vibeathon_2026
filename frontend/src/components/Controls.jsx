import { useRef } from "react"

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

export default function Controls({ phase, sourceInfo, onStartMic, onPlayFile, onStop }) {
  const fileRef = useRef(null)
  const busy = phase === "live" || phase === "connecting"

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
        accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm"
        style={{ display: "none" }}
        onChange={handleFile}
      />
      <button className="btn btn-stop" onClick={onStop} disabled={!busy}>
        Detener
      </button>
      {sourceInfo ? (
        <span className="source-info">
          {sourceInfo.name} · {formatDuration(sourceInfo.durationMs)}
        </span>
      ) : null}
    </div>
  )
}