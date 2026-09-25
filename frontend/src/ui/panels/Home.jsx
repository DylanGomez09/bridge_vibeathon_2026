import { ArrowRightIcon, MicIcon, SessionsIcon, TranslateIcon } from "../icons.jsx"

const PHASE = {
  idle: { text: "En espera", dot: "dot-idle" },
  connecting: { text: "Conectando…", dot: "dot-brand" },
  live: { text: "Sesión en vivo", dot: "dot-live" },
  reconnecting: { text: "Reconectando sesión…", dot: "dot-reconnecting" },
  failed: { text: "Sesión caída", dot: "dot-idle" },
  offline: { text: "Sin conexión", dot: "dot-idle" },
  ended: { text: "Sesión finalizada", dot: "dot-idle" },
  error: { text: "Error en la sesión", dot: "dot-idle" },
}

export default function Home({ phase, activeSessions, onNavigate }) {
  const state = PHASE[phase] ?? PHASE.idle

  return (
    <div className="content">
      <div className="card-grid cols-3">
        <article className="card">
          <h3>Estado del sistema</h3>
          <p className={`status-row ${state.dot}`}>
            <span className="dot" />
            {state.text}
          </p>
          <p className="stat-label">
            Motor de transcripción: Gemini Live (audio) · EN → ES
          </p>
        </article>

        <article className="card">
          <h3>
            <SessionsIcon size={18} /> Sesiones activas
          </h3>
          <p className="stat-value">{activeSessions}</p>
          <p className="stat-label">con transcripción y traducción en vivo</p>
        </article>

        <article className="card">
          <h3>
            <MicIcon size={18} /> Accesos rápidos
          </h3>
          <div className="hero-ctas">
            <button type="button" className="btn btn-brand btn-sm" onClick={() => onNavigate("traduccion")}>
              <TranslateIcon size={16} /> Ir a Traducción
            </button>
            <button type="button" className="btn btn-surface btn-sm" onClick={() => onNavigate("microfono")}>
              Probar micrófono <ArrowRightIcon size={14} />
            </button>
          </div>
        </article>
      </div>

      <article className="card">
        <h3>Resumen</h3>
        <p className="stat-label">
          Puente abre una sesión de Gemini por cada sesión en vivo, envía el audio
          por turnos de 10 segundos y muestra la transcripción original y su
          traducción al español mientras se completan los segmentos. Todo se controla
          desde el panel Traducción.
        </p>
      </article>
    </div>
  )
}