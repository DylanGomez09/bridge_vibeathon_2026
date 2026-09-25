import Segment from "./Segment.jsx"

export default function TranscriptPanel({ segments, currentOriginal, currentTranslation }) {
  const hasLive =
    (currentOriginal?.text ?? "").length > 0 || (currentTranslation ?? "").length > 0

  const pendingTranslation = hasLive && (currentTranslation ?? "").length === 0

  const live = {
    ts: null,
    original: currentOriginal?.text ?? "",
    translation: currentTranslation ?? "",
  }

  return (
    <section className="panel" data-testid="transcript-panel">
      <div className="panel-head">
        <div aria-hidden="true" />
        <div className="col-original">Original (EN)</div>
        <div className="col-translation">Traducción (ES)</div>
      </div>
      <div className="panel-body">
        {segments.length === 0 && !hasLive ? (
          <div className="empty-state">
            <span className="big">…</span>
            <p>
              Iniciá el micrófono o subí un archivo de audio o video para ver
              la transcripción y la traducción en vivo.
            </p>
          </div>
        ) : (
          <div className="segments">
            {segments.map((segment) => (
              <Segment key={segment.id} segment={segment} />
            ))}
            {hasLive ? <Segment segment={live} live pending={pendingTranslation} /> : null}
          </div>
        )}
      </div>
    </section>
  )
}