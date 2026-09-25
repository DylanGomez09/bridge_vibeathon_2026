import { UsersIcon } from "../icons.jsx"
import { langBadge, sessionStatus, shortId } from "../session-meta.js"

export default function Sessions({
  connState,
  sessions,
  currentSessionId,
  isOwner,
  onTune,
  onRefresh,
}) {
  const list = sessions ?? []
  const offline = connState === "offline"

  if (offline) {
    return (
      <div className="content">
        <div className="session-list" aria-label="Sesiones activas">
          <article className="session past">
            <span className="sess-dot dot-idle" aria-hidden="true" />
            <div className="session-meta">
              <h3 className="sess-title">Sin conexión con el servidor</h3>
              <p className="sess-note">No se pueden listar las sesiones activas.</p>
            </div>
          </article>
        </div>
      </div>
    )
  }

  if (list.length === 0) {
    return (
      <div className="content">
        <div className="session-list" aria-label="Sesiones activas">
          <article className="session past">
            <span className="sess-dot dot-idle" aria-hidden="true" />
            <div className="session-meta">
              <h3 className="sess-title">Todavía no hay sesiones</h3>
              <p className="sess-note">
                Abrí una sesión desde el micrófono o un archivo. Acá vas a poder sintonizar las
                demás.
              </p>
            </div>
            <div className="sess-right">
              <button type="button" className="btn-ghost" onClick={() => onRefresh?.()}>
                Actualizar
              </button>
            </div>
          </article>
        </div>
      </div>
    )
  }

  return (
    <div className="content">
      <div className="session-list" aria-label="Sesiones activas">
        {list.map((session) => {
          const tuned = session.id === currentSessionId
          const status = sessionStatus(session)
          const dot = status.dot
          return (
            <article
              className={`session${tuned ? " session-real" : ""}`}
              key={session.id}
              onClick={() => !tuned && onTune?.(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  if (!tuned) onTune?.(session.id)
                }
              }}
              aria-pressed={tuned}
            >
              <span className={`sess-dot ${dot}`} aria-hidden="true" />
              <div className="session-meta">
                <h3 className="sess-title">{session.label}</h3>
                <p className="sess-sub">
                  {shortId(session.id)}
                  {tuned ? (isOwner ? " · tu sesión" : " · sintonizada") : ""}
                </p>
                {status.note ? <p className="sess-note">{status.note}</p> : null}
              </div>
              <div className="sess-right">
                <span className="lang-badge">{langBadge(session)}</span>
                <span className="listeners">
                  <UsersIcon size={14} />
                  {session.clients} {session.clients === 1 ? "oyente" : "oyentes"}
                </span>
              </div>
            </article>
          )
        })}
      </div>
      <p className="sess-note">
        Sintonizar muestra sólo los subtítulos de esa sesión: cada una tiene su propia conexión a
        Gemini Live y su propio audio. ID completo: {shortId(currentSessionId)}.
      </p>
    </div>
  )
}
