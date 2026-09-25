const LANGS = { en: "EN", es: "ES", pt: "PT", fr: "FR", de: "DE" }

export function langName(code) {
  return LANGS[code] ?? String(code).toUpperCase()
}

export function langBadge(session) {
  return `${langName(session.sourceLang)} → ${langName(session.targetLang)}`
}

export function shortId(id) {
  return id ? id.slice(0, 8) : "—"
}

/** Estado visual de una sesión, compartido entre el listado y el muro. */
export function sessionStatus(session) {
  if (session.orphaned) {
    const left = session.graceUntil
      ? Math.max(0, Math.ceil((session.graceUntil - Date.now()) / 1000))
      : 0
    return {
      dot: "dot-reconnecting",
      note: left > 0 ? `Owner desconectado — se cierra en ${left}s` : "Owner desconectado",
    }
  }
  if (session.phase === "connecting") return { dot: "dot-idle", note: "Conectando con Gemini…" }
  if (session.phase === "reconnecting") return { dot: "dot-reconnecting", note: "Reconectando…" }
  if (session.phase === "failed") return { dot: "dot-idle", note: "Falló" }
  if (session.phase === "ended") return { dot: "dot-idle", note: "Terminada" }
  return { dot: "dot-live", note: null }
}
