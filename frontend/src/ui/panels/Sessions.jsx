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

export default function Sessions() {
  return (
    <div className="content">
      <div className="session-list" aria-label="Sesiones activas">
        {SESSIONS.map((session) => (
          <article className={`session${session.live ? "" : " past"}`} key={session.id}>
            <span className="sess-dot" aria-hidden="true" />
            <div className="session-meta">
              <h3 className="sess-title">{session.title}</h3>
              <p className="sess-sub">{session.detail}</p>
            </div>
            <div className="sess-right">
              <span className="lang-badge">{session.langs}</span>
              <span className="listeners">
                <UsersIcon size={14} />
                {session.listeners} {session.listeners === 1 ? "oyente" : "oyentes"}
              </span>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}