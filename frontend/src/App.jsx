import LiveBadge from "./components/LiveBadge.jsx"
import Controls from "./components/Controls.jsx"
import TranscriptPanel from "./components/TranscriptPanel.jsx"
import { useBridgeSession } from "./hooks/useBridgeSession.js"
import { downloadSrt } from "./lib/subtitles.js"

function App() {
  const {
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
  } = useBridgeSession()

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>Bridge</h1>
          <span className="brand-tag">Transcripción y traducción en vivo EN → ES</span>
        </div>
        <LiveBadge phase={phase} />
      </header>

      <main className="main">
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

        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}

        <TranscriptPanel
          segments={segments}
          currentOriginal={currentOriginal}
          currentTranslation={currentTranslation}
        />
      </main>
    </div>
  )
}

export default App