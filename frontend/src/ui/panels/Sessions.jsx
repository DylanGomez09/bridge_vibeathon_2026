import { useState } from "react"
import ConfirmDialog from "../ConfirmDialog.jsx"
import { UsersIcon } from "../icons.jsx"
import { LANGS, langBadge, sessionStatus, shortId } from "../session-meta.js"

const LANG_OPTIONS = Object.keys(LANGS)

export default function Sessions({
  connState,
  sessions,
  currentSessionId,
  onTune,
  onRefresh,
  runtimes,
  maxSessions,
  onCreate,
  onFocusRuntime,
  onCloseRuntime,
}) {
  const [creating, setCreating] = useState(false)
  const [label, setLabel] = useState("")
  const [sourceLang, setSourceLang] = useState("en")
  const [targetLang, setTargetLang] = useState("es")
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)

  const list = sessions ?? []
  const offline = connState === "offline"
  const owned = (runtimes ?? []).filter((runtime) => runtime.runtimeId)
  const localCount = owned.length
  const atCapacity = list.length >= (maxSessions ?? 4)

  const runtimeBySession = new Map()
  for (const runtime of owned) {
    if (runtime.sessionId) runtimeBySession.set(runtime.sessionId, runtime)
  }

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFormError(null)
    try {
      const created = await onCreate?.({ label: label.trim(), sourceLang, targetLang })
      if (created) {
        setLabel("")
        setCreating(false)
      } else {
        setFormError("No se pudo crear la sesión. Revisá el detalle en Traducción.")
      }
    } finally {
      setBusy(false)
    }
  }

  const createButton = (
    <div className="session-create" data-tour="sessions-create">
      {creating ? (
        <form className="session-create-form" onSubmit={submit}>
          <input
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Nombre de la sesión"
            maxLength={60}
            autoFocus
          />
          <div className="session-create-langs">
            <label>
              <span>Desde</span>
              <select
                className="input"
                value={sourceLang}
                onChange={(event) => setSourceLang(event.target.value)}
              >
                {LANG_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {LANGS[code]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Hacia</span>
              <select
                className="input"
                value={targetLang}
                onChange={(event) => setTargetLang(event.target.value)}
              >
                {LANG_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {LANGS[code]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {formError ? <p className="sess-note sess-error">{formError}</p> : null}
          <div className="session-create-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Abriendo…" : "Abrir sesión"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setCreating(false)
                setFormError(null)
              }}
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreating(true)}
          disabled={offline || atCapacity}
        >
          {atCapacity ? `Máximo de ${maxSessions} sesiones` : "Nueva sesión"}
        </button>
      )}
      {atCapacity && !creating ? (
        <p className="sess-note">
          Cerrá una sesión para abrir otra: el backend admite {maxSessions} simultáneas.
        </p>
      ) : null}
    </div>
  )

  // Se declara antes de los returns tempranos porque el diálogo tiene que seguir
  // montado aunque la sesión que estoy por borrar desaparezca de la lista al confirmar.
  const confirmDialog = (
    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title={`Eliminar «${pendingDelete?.label ?? ""}»`}
      body={
        pendingDelete && pendingDelete.clients > 1
          ? `Se corta la sesión y las ${pendingDelete.clients - 1} personas que la están mirando pierden la transcripción.`
          : "Se corta la sesión y se libera su conexión con Gemini."
      }
      confirmLabel="Eliminar sesión"
      destructive
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => {
        if (pendingDelete) onCloseRuntime?.(pendingDelete.runtimeId)
        setPendingDelete(null)
      }}
    />
  )

  if (offline) {
    return (
      <div className="content">
        {createButton}
        <div className="session-list" aria-label="Sesiones activas">
          <article className="session past">
            <span className="sess-dot dot-idle" aria-hidden="true" />
            <div className="session-meta">
              <h3 className="sess-title">Sin conexión con el servidor</h3>
              <p className="sess-note">No se pueden listar las sesiones activas.</p>
            </div>
          </article>
        </div>
        {confirmDialog}
      </div>
    )
  }

  if (list.length === 0) {
    return (
      <div className="content">
        {createButton}
        <div className="session-list" aria-label="Sesiones activas">
          <article className="session past">
            <span className="sess-dot dot-idle" aria-hidden="true" />
            <div className="session-meta">
              <h3 className="sess-title">Todavía no hay sesiones</h3>
              <p className="sess-note">
                Abrí una desde acá, o desde el micrófono o un archivo de Traducción.
              </p>
            </div>
            <div className="sess-right">
              <button type="button" className="btn-ghost" onClick={() => onRefresh?.()}>
                Actualizar
              </button>
            </div>
          </article>
        </div>
        {confirmDialog}
      </div>
    )
  }

  return (
    <div className="content">
      {createButton}
      <div className="session-list" aria-label="Sesiones activas">
        {list.map((session) => {
          const tuned = session.id === currentSessionId
          const status = sessionStatus(session)
          const runtime = runtimeBySession.get(session.id)
          const mine = Boolean(runtime)
          const dot = status.dot
          const phaseNote = runtime?.error
            ? runtime.error
            : mine && runtime.processingFile
              ? `Procesando archivo… ${Math.round((runtime.progress ?? 0) * 100)}%`
              : status.note
          return (
            <article
              className={`session${tuned ? " session-real" : ""}`}
              key={session.id}
              onClick={() => !tuned && !mine && onTune?.(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  if (!tuned && !mine) onTune?.(session.id)
                }
              }}
              aria-pressed={tuned}
            >
              <span className={`sess-dot ${dot}`} aria-hidden="true" />
              <div className="session-meta">
                <h3 className="sess-title">{session.label}</h3>
                <p className="sess-sub">
                  {shortId(session.id)}
                  {mine
                    ? runtime.isMic
                      ? " · tuya · micrófono"
                      : runtime.hasSource
                        ? " · tuya · archivo"
                        : " · tuya"
                    : tuned
                      ? " · sintonizada"
                      : ""}
                </p>
                {phaseNote ? <p className="sess-note">{phaseNote}</p> : null}
              </div>
              <div className="sess-right">
                <span className="lang-badge">{langBadge(session)}</span>
                <span className="listeners">
                  <UsersIcon size={14} />
                  {session.clients} {session.clients === 1 ? "oyente" : "oyentes"}
                </span>
                {mine ? (
                  <button
                    type="button"
                    className="btn-ghost sess-danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      setPendingDelete({ ...session, runtimeId: runtime.runtimeId })
                    }}
                  >
                    Eliminar
                  </button>
                ) : null}
                {!mine && !tuned ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={(event) => {
                      event.stopPropagation()
                      onTune?.(session.id)
                    }}
                  >
                    Sintonizar
                  </button>
                ) : null}
                {mine && !tuned ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={(event) => {
                      event.stopPropagation()
                      onFocusRuntime?.(runtime.runtimeId)
                    }}
                  >
                    Traer
                  </button>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
      <p className="sess-note">
        Cada sesión abierta desde esta pestaña tiene su propia conexión a Gemini Live y su
        propio audio ({localCount} abierta{localCount === 1 ? "" : "s"} acá). El micrófono sólo
        puede estar en una a la vez; con archivos podés tener varias reproduciendo.
      </p>
      {confirmDialog}
    </div>
  )
}
