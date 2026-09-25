import { useCallback, useEffect, useState } from "react"
import { useBridgeSession } from "../hooks/useBridgeSession.js"
import { useSessionGrid } from "../hooks/useSessionGrid.js"
import { getHealth } from "../lib/api.js"
import Sidebar from "./Sidebar.jsx"
import Home from "./panels/Home.jsx"
import Sessions from "./panels/Sessions.jsx"
import SessionGrid from "./panels/SessionGrid.jsx"
import Microphone from "./panels/Microphone.jsx"
import TranslationPanel from "./panels/TranslationPanel.jsx"
import Settings from "./panels/Settings.jsx"
import RoomTour from "./RoomTour.jsx"
import { TOUR_KEY } from "./tour-steps.js"
import { NAV } from "./nav.js"

const DEFAULT_PREFS = {
  sourceLang: "en",
  targetLang: "es",
  notifications: true,
  displayMode: "cols",
}

const PANEL_TITLE = Object.fromEntries(NAV.map((item) => [item.id, item.label]))

export default function AppShell({ initialPanel, theme, activeTheme, onThemeChange }) {
  const [active, setActive] = useState(initialPanel ?? "inicio")
  const [collapsed, setCollapsed] = useState(false)
  const [prefs, setPrefs] = useState(DEFAULT_PREFS)
  const [videoLimits, setVideoLimits] = useState(null)
  const [mode, setMode] = useState("audio")
  const [tourOpen, setTourOpen] = useState(() => {
    try {
      return window.localStorage.getItem(TOUR_KEY) !== "1"
    } catch {
      return false
    }
  })
  const session = useBridgeSession()
  const grid = useSessionGrid(active === "muro")

  useEffect(() => {
    let alive = true
    getHealth().then((health) => {
      if (alive) setVideoLimits(health.video)
    })
    return () => {
      alive = false
    }
  }, [])

  const setPref = (key, value) => setPrefs((prev) => ({ ...prev, [key]: value }))

  const handleSelect = (id) => {
    setActive(id)
    // Al entrar a Sesiones pedimos la lista real al backend (conecta el socket si hacía falta).
    if (id === "sesiones") session.refreshSessions()
  }

  const closeTour = useCallback(() => {
    setTourOpen(false)
    try {
      window.localStorage.setItem(TOUR_KEY, "1")
    } catch {
      setTourOpen(false)
    }
  }, [])

  const panels = {
    inicio: (
      <Home
        phase={session.phase}
        activeSessions={session.sessions.length}
        onNavigate={handleSelect}
        onStartTour={() => setTourOpen(true)}
      />
    ),
    sesiones: (
      <Sessions
        connState={session.connState}
        sessions={session.sessions}
        currentSessionId={session.sessionId}
        isOwner={session.isOwner}
        onTune={session.tuneTo}
        onRefresh={session.refreshSessions}
        runtimes={session.runtimes}
        maxSessions={session.maxSessions}
        onCreate={session.createSession}
        onFocusRuntime={session.focus}
        onCloseRuntime={session.closeSession}
      />
    ),
    muro: (
      <SessionGrid
        sessions={grid.sessions}
        feeds={grid.feeds}
        connState={grid.connState}
        onOpen={(id) => {
          session.tuneTo(id)
          setActive("traduccion")
        }}
      />
    ),
    microfono: <Microphone />,
    traduccion: (
      <TranslationPanel {...session} {...prefs} videoLimits={videoLimits} mode={mode} setMode={setMode} />
    ),
    ajustes: <Settings prefs={prefs} setPref={setPref} theme={theme} onThemeChange={onThemeChange} />,
  }

  return (
    <div className="shell">
      <Sidebar
        items={NAV}
        active={active}
        onSelect={handleSelect}
        collapsed={collapsed}
        onToggle={() => setCollapsed((prev) => !prev)}
        onLogout={() => {
          window.location.hash = ""
        }}
        theme={activeTheme}
      />
      <div className="main-col">
        <header className="topbar">
          <span className="panel-title">{PANEL_TITLE[active]}</span>
        </header>
        {panels[active]}
      </div>

      <RoomTour
        open={tourOpen}
        onClose={closeTour}
        onNavigate={handleSelect}
        onMode={setMode}
        activePanel={active}
      />
    </div>
  )
}