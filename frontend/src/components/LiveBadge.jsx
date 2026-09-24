const LABELS = {
  idle: { text: "En espera", dot: "gray" },
  connecting: { text: "Conectando", dot: "blue" },
  live: { text: "En vivo", dot: "coral" },
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