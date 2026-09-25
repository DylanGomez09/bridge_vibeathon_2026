const DEFAULT_WS_URL = "ws://localhost:3001/ws"

let cachedBase = null

export function apiBase() {
  if (cachedBase) return cachedBase
  const explicit = import.meta.env.VITE_API_URL
  if (explicit) {
    cachedBase = explicit.replace(/\/+$/, "")
    return cachedBase
  }
  const ws = import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL
  const url = new URL(ws, window.location.href)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = ""
  url.search = ""
  url.hash = ""
  cachedBase = url.toString().replace(/\/+$/, "")
  return cachedBase
}

const FALLBACK_HEALTH = {
  maxSessions: 4,
  video: { model: "", maxSeconds: 600, maxBytes: 209715200 },
}

export async function getHealth() {
  try {
    const response = await fetch(`${apiBase()}/health`, { headers: { accept: "application/json" } })
    if (!response.ok) return FALLBACK_HEALTH
    const data = await response.json()
    return {
      maxSessions: Number(data?.bridge?.maxSessions) || FALLBACK_HEALTH.maxSessions,
      video: {
        model: data?.video?.model ?? "",
        maxSeconds: Number(data?.video?.maxSeconds) || FALLBACK_HEALTH.video.maxSeconds,
        maxBytes: Number(data?.video?.maxBytes) || FALLBACK_HEALTH.video.maxBytes,
      },
    }
  } catch {
    return FALLBACK_HEALTH
  }
}
