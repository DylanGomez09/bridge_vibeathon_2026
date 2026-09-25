import { UsersIcon } from "../icons.jsx"

const SESSIONS = [
  {
    id: 1,
    title: "Nerdearla 2026 — Auditorio principal",
    detail: "Stuart Russell · Charla plenaria",
    langs: "EN → ES",
    live: true,
    listeners: 142,
  },
  {
    id: 2,
    title: "Track IA — Sala Cóndor",
    detail: "Construyendo subtítulos en tiempo real",
    langs: "EN → ES",
    live: true,
    listeners: 87,
  },
  {
    id: 3,
    title: "Workshop: LLMs para todos",
    detail: "Hands-on con Gemini Live",
    langs: "EN → ES",
    live: true,
    listeners: 43,
  },
  {
    id: 4,
    title: "Keynote de cierre",
    detail: "Resumen del día",
    langs: "EN → ES",
    live: false,
    listeners: 0,
  },
]

function realStatus(phase, connState) {
  if (connState === "offline") {
    return {
      dot: "dot-idle",
      note: "Sesión temporalmente sin conexión",
    }
  }
  if (phase === "reconnecting" || phase === "connecting") {
    return {
      dot: "dot-reconnecting",
      note: "Reconectando la sesión…",
    }
  }
  if (phase === "failed" || phase === "error") {
    return {
      dot: "dot-idle",
      note: "No se pudo restablecer la sesión",
    }
  }
  return { dot: "dot-live", note: null }
}

export default function Sessions({ phase, connState }) {
  const status = realStatus(phase, connState)

  return (
    <div className="content">
      <div className="session-list" aria-label="Sesiones activas">
        {SESSIONS.map((session) => {
          const active = session.live && session.id === 1
          const row = active ? status : { dot: session.live ? "dot-live" : "dot-idle", note: null }
          return (
            <article
              className={`session${session.live ? "" : " past"}${active ? " session-real" : ""}`}
              key={session.id}
            >
              <span className={`sess-dot ${row.dot}`} aria-hidden="true" />
              <div className="session-meta">
                <h3 className="sess-title">{session.title}</h3>
                <p className="sess-sub">{session.detail}</p>
                {row.note ? <p className="sess-note">{row.note}</p> : null}
              </div>
              <div className="sess-right">
                <span className="lang-badge">{session.langs}</span>
                <span className="listeners">
                  <UsersIcon size={14} />
                  {session.listeners} {session.listeners === 1 ? "oyente" : "oyentes"}
                </span>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}