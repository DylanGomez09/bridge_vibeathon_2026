export function friendlyMessage(cause, fallback = "Ocurrió un error inesperado.") {
  const raw = typeof cause === "string" ? cause : (cause?.message ?? "")
  if (!raw) return fallback
  const lower = String(raw).toLowerCase()

  if (
    /no se pudo conectar a ws/.test(lower) ||
    /econnrefused|econnreset|fetch failed|failed to fetch|networkerror|network error|unexpected server response/.test(
      lower,
    )
  ) {
    return "No se pudo conectar con el servidor de Puente. Reconectando…"
  }
  if (
    /gemini.*(no está configurado|no se pudo autenticar|api.?key|revisá|no se pudo configurar|key)/.test(lower) ||
    /invalid.?api.?key|unauthorized|401|forbidden|403|apikey|econnrefused|invalid.*key/.test(lower)
  ) {
    return "No se pudo autenticar con Gemini. Revisá la GEMINI_API_KEY en backend/.env."
  }
  if (/quota|rate.?limit|resource.?exhausted|429|overloaded|límite de uso/.test(lower)) {
    return "Gemini alcanzó su límite de uso. Esperá unos segundos y reintentá."
  }
  // Micrófono: va antes que la regla de Gemini porque el navegador usa exactamente
  // las cadenas "Permission denied" / "NotAllowedError", y antes caían en la de API key.
  if (/mic-insecure-context/.test(lower)) {
    return "El micrófono necesita una conexión segura. Abrí la app en https:// o en localhost."
  }
  if (/notallowederror|permission denied|permission_disallowed|mic-unsupported/.test(lower)) {
    return "El navegador no permitió el micrófono. Habilitalo desde el candado de la barra de direcciones y recargá la página."
  }
  if (/notfounderror|devicesnotfounderror|requested device not found/.test(lower)) {
    return "No se encontró ningún micrófono. Conectá uno y volvé a intentar."
  }
  if (/notreadableerror|could not start audio source|track start/.test(lower)) {
    return "El micrófono está siendo usado por otra aplicación. Cerrala e intentá de nuevo."
  }
  if (/owner de la sesión puede enviar audio|owner puede enviar audio/.test(lower)) {
    return "Esta sesión dejó de ser la dueña del micrófono. Volvé a iniciar el micrófono para reconectarla."
  }
  if (/model.*no.*disponible|model not found|model.*not.*available|no.*modelo/.test(lower)) {
    return "El modelo de Gemini solicitado no está disponible en este momento."
  }
  if (/su límite de uso|concurrency|demasiado.?(activa|concurren)|ya está activa|sesión.*ya.*activ/.test(lower)) {
    return "La sesión ya está activa. Esperá a que termine o detenela antes de subir otro archivo."
  }
  if (/no se pudo autenticar|autentic.*gemini|auth.*fail|econnreset.*gemini/.test(lower)) {
    return "No se pudo autenticar con Gemini. Revisá la GEMINI_API_KEY en backend/.env."
  }
  if (/no respondió al iniciar|no se pudo iniciar la sesión|responder.*iniciar|ack|started.*esperado/.test(lower)) {
    return "El servidor no respondió al iniciar la sesión. Si el backend se reinicia (pnpm dev), esperá unos segundos y reintentá."
  }
  if (/timeout|tardó demasiado en estar lista|demasiado.?(lista|tard)/.test(lower)) {
    return "La sesión tardó demasiado en estar lista. Reconectando…"
  }
  if (/close 1006|abnormal|cerrado antes/.test(lower)) {
    return "La sesión se cerró antes de estar lista. Reconectando…"
  }
  return fallback
}
