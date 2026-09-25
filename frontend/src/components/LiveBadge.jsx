const LABELS = {
  idle: { text: "En espera", dot: "gray" },
  connecting: { text: "Conectando", dot: "blue" },
  live: { text: "En vivo", dot: "coral" },
  reconnecting: { text: "Reconectando…", dot: "reconnecting" },
  failed: { text: "Sesión caída", dot: "gray" },
  error: { text: "Error en la sesión", dot: "gray" },
  offline: { text: "Desconectado", dot: "gray" },
  ended: { text: "Finalizado", dot: "gray" },
}

export default function LiveBadge({ phase }) {
  const label = LABELS[phase] ?? LABELS.idle
  return (
    <span className="live-badge" data-testid="live-badge">
      <span className={`dot ${label.dot}`} />
      {label.text}
    </span>
  )
}