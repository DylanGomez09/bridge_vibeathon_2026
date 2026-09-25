import Controls from "../../components/Controls.jsx"
import Segment from "../../components/Segment.jsx"
import LiveBadge from "../../components/LiveBadge.jsx"
import { downloadSrt } from "../../lib/subtitles.js"
import { langName } from "../session-meta.js"

export default function TranslationPanel({
  phase,
  error,
  sourceInfo,
  segments,
  currentOriginal,
  currentTranslation,
  processingFile,
  progress,
  startMic,
  playFile,
  stop,
  displayMode,
  sourceLang,
  targetLang,
  sessions,
  sessionId,
  isOwner,
  leaveSession,
}) {
  const hasLive =
    (currentOriginal?.text ?? "").length > 0 || (currentTranslation ?? "").length > 0
  const pendingTranslation = hasLive && (currentTranslation ?? "").length === 0

  // Los idiomas de la sesión manda sobre los prefs: al sintonizar otra sesión, las
  // columnas tienen que mostrar los idiomas reales de esa sesión, no los del cliente.
  const current = (sessions ?? []).find((item) => item.id === sessionId)
  const shownSource = current?.sourceLang ?? sourceLang
  const shownTarget = current?.targetLang ?? targetLang

  const live = {
    ts: null,
    original: currentOriginal?.text ?? "",
    translation: currentTranslation ?? "",
  }

  const modeClass =
    displayMode === "single" ? " is-single" : displayMode === "subtitles" ? " is-sub" : ""
  const reconnectingClass =
    phase === "reconnecting" || phase === "offline" ? " is-reconnecting" : ""

  return (
    <div className="content tight">
      <div className="controls">
        <Controls
          phase={phase}
          sourceInfo={sourceInfo}
          processingFile={processingFile}
          progress={progress}
          canDownload={segments.length > 0}
          onStartMic={() => startMic()}
          onPlayFile={(file) => playFile(file)}
          onStop={() => stop()}
          onDownloadSrt={() => downloadSrt(segments, sourceInfo, "bridge.srt")}
        />
        <LiveBadge phase={phase} />
      </div>

      <p className="sess-note">
        {sessionId ? (
          <>
            Sesión <code>{sessionId.slice(0, 8)}</code>
            {current ? ` · ${current.label}` : ""} · {isOwner ? "sos el owner (enviás el audio)" : "oyente (sólo recibís)"}
          </>
        ) : (
          "Sin sesión: iniciá el micrófono o subí un archivo, o sintonizá una sesión existente."
        )}
        {sessionId && !isOwner ? (
          <button type="button" className="btn-ghost" onClick={() => leaveSession()}>
            Salir de la sesión
          </button>
        ) : null}
      </p>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <section className={`card translation-panel${modeClass}${reconnectingClass}`} data-testid="transcript-panel">
        <div className="translation-head">
          <span aria-hidden="true" />
          <span className="col-original">Original ({langName(shownSource)})</span>
          <span className="col-translation">Traducción ({langName(shownTarget)})</span>
        </div>
        <div className="translation-scroll">
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
              {hasLive ? (
                <Segment segment={live} live pending={pendingTranslation} />
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}