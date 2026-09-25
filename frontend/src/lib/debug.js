const DEBUG =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug")

export function debug(...args) {
  if (DEBUG) console.log("[debug]", ...args)
}

export function isDebugEnabled() {
  return DEBUG
}

export function elapsedSec(start) {
  if (!start) return "?"
  return `${(Math.max(0, performance.now() - start) / 1000).toFixed(1)}s`
}