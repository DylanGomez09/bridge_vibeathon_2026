function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, "0")
  return `${minutes}:${seconds}`
}

export default function Segment({ segment, live, pending }) {
  return (
    <div className={`segment${live ? " segment-live" : ""}`}>
      <span className="segment-time">{live ? "ahora" : formatTime(segment.ts)}</span>
      <div className="segment-original">{segment.original || (live ? "…" : "")}</div>
      <div className="segment-translation">
        {segment.translation}
        {live && pending && !segment.translation ? (
          <em className="hint">Esperando traducción…</em>
        ) : null}
      </div>
    </div>
  )
}