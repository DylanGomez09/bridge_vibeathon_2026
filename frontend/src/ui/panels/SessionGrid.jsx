import { ArrowRightIcon, UsersIcon } from "../icons.jsx"
import { langBadge, sessionStatus, shortId } from "../session-meta.js"

const VISIBLE_SEGMENTS = 4

function Feed({ feed }) {
  if (feed.segments.length === 0 && !feed.original && !feed.translation) {
    return <p className="session-grid-empty">Esperando la primera frase…</p>
  }
  const recent = feed.segments.slice(-VISIBLE_SEGMENTS)
  return (
    <>
      <div className="session-grid-feed">
        {recent.map((segment, index) => (
          <div className="session-grid-seg" key={`${index}-${segment.translation}`}>
            {segment.original ? <span className="original">{segment.original}</span> : null}
            {segment.translation ? <span className="translation">{segment.translation}</span> : null}
          </div>
        ))}
      </div>
      {feed.original || feed.translation ? (
        <div className="session-grid-live">
          <span className="original">{feed.original || "…"}</span>
          <span className="translation">{feed.translation || "Esperando traducción…"}</span>
        </div>
      ) : null}
    </>
  )
}

export default function SessionGrid({ sessions, feeds, connState, onOpen }) {
  if (connState === "offline") {
    return (
      <div className="content">
        <div className="session-grid-empty card">Sin conexión con el servidor.</div>
      </div>
    )
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="content">
        <div className="session-grid-empty card">
          No hay sesiones activas. Abrí el micrófono o subí un archivo en otra pestaña y el muro
          la mostraría acá, en sólo lectura.
        </div>
      </div>
    )
  }

  return (
    <div className="content">
      <div className="session-grid">
        {sessions.map((session) => {
          const feed = feeds[session.id]
          const status = sessionStatus(session)
          return (
            <article className="session-grid-card" key={session.id}>
              <header className="session-grid-head">
                <span className={`sess-dot ${status.dot}`} aria-hidden="true" />
                <div className="session-grid-titles">
                  <h3>{session.label}</h3>
                  <span className="sess-sub">{shortId(session.id)}</span>
                </div>
                <span className="lang-badge">{langBadge(session)}</span>
              </header>

              {status.note ? <p className="sess-note">{status.note}</p> : null}
              {feed?.ended ? <p className="sess-note">Sesión terminada</p> : null}

              <Feed feed={feed ?? { original: "", translation: "", segments: [] }} />

              <footer className="session-grid-foot">
                <span className="listeners">
                  <UsersIcon size={14} />
                  {session.clients} {session.clients === 1 ? "oyente" : "oyentes"}
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onOpen?.(session.id)}
                >
                  Ver en grande <ArrowRightIcon size={14} />
                </button>
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}
