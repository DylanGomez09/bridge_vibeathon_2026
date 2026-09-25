import Controls from "../../components/Controls.jsx"
import Segment from "../../components/Segment.jsx"
import LiveBadge from "../../components/LiveBadge.jsx"
import { downloadSrt } from "../../lib/subtitles.js"

const LANG_LABEL = { en: "EN", es: "ES", pt: "PT", fr: "FR", de: "DE" }

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
}) {
  const hasLive =
    (currentOriginal?.text ?? "").length > 0 || (currentTranslation ?? "").length > 0
  const pendingTranslation = hasLive && (currentTranslation ?? "").length === 0

  const live = {
    ts: null,
    original: currentOriginal?.text ?? "",
    translation: currentTranslation ?? "",
  }

  const modeClass =
    displayMode === "single" ? " is-single" : displayMode === "subtitles" ? " is-sub" : ""

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

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <section className={`card translation-panel${modeClass}`} data-testid="transcript-panel">
        <div className="translation-head">
          <span aria-hidden="true" />
          <span className="col-original">Original ({LANG_LABEL[sourceLang] ?? "EN"})</span>
          <span className="col-translation">Traducción ({LANG_LABEL[targetLang] ?? "ES"})</span>
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