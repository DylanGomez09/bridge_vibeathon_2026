export function friendlyError(detail: string, fallback: string): string {
  if (!detail) return fallback;
  const d = String(detail);
  const lower = d.toLowerCase();

  if (/1007|response modalities|text is not supported|combination of response|modality"/.test(d)) {
    return "Gemini no soporta esta configuración de respuesta.";
  }
  if (/api[- ]?key|invalid credential|unauth|401|apikey not found|default credentials/.test(lower)) {
    return "No se pudo autenticar con Gemini: revisá la GEMINI_API_KEY en backend/.env.";
  }
  if (/quota|rate.?limit|resource.?exhausted|429|concurrent|overloaded/.test(lower)) {
    return "Gemini alcanzó su límite de uso; no se pudo restablecer la sesión.";
  }
  if (/permission|forbidden|403|access controls?|blocked|not allowed/.test(lower)) {
    return "Sin permisos para usar este modelo de Gemini.";
  }
  if (/model not found|404|does not exist|not found/.test(d)) {
    return "El modelo de Gemini solicitado no está disponible.";
  }
  if (
    /fetch failed|econnreset|socket|aborted|load failed|closed|network|timeouth?t|econnrefused|transient/i.test(
      lower,
    )
  ) {
    return "Se perdió la conexión con Gemini.";
  }
  return fallback;
}

export function friendlySessionError(
  detail: unknown,
  fallback = "No se pudo restablecer la sesión.",
): string {
  const raw =
    typeof detail === "string"
      ? detail
      : detail instanceof Error
        ? detail.message
        : JSON.stringify(detail);
  return friendlyError(raw ?? "", fallback);
}