import { useEffect, useState } from "react"
import Landing from "./ui/Landing.jsx"
import AppShell from "./ui/AppShell.jsx"

const THEME_STORAGE = "bridge-theme"

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, "")
  const [view, ...rest] = hash.split("/")
  return { view, panel: rest[0] }
}

function navigateTo(path) {
  window.location.hash = `/${path}`
}

function resolveTheme(pref) {
  if (pref && pref !== "system") return pref
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

export default function App() {
  const [route, setRoute] = useState(() => parseHash())
  const [theme, setTheme] = useState(
    () => localStorage.getItem(THEME_STORAGE) || "system",
  )
  const [activeTheme, setActiveTheme] = useState(() =>
    resolveTheme(localStorage.getItem(THEME_STORAGE) || "system"),
  )

  useEffect(() => {
    const apply = () => {
      if (route.view !== "app") {
        document.documentElement.setAttribute("data-theme", "light")
        setActiveTheme("light")
        return
      }
      const resolved = resolveTheme(theme)
      document.documentElement.setAttribute("data-theme", resolved)
      setActiveTheme(resolved)
    }
    apply()
    if (theme !== "system" || route.view !== "app") return
    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    media?.addEventListener?.("change", apply)
    return () => media?.removeEventListener?.("change", apply)
  }, [theme, route.view])

  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const handleThemeChange = (next) => {
    setTheme(next)
    localStorage.setItem(THEME_STORAGE, next)
  }

  if (route.view === "app") {
    return (
      <AppShell
        key={route.panel ?? "default"}
        initialPanel={route.panel}
        theme={theme}
        activeTheme={activeTheme}
        onThemeChange={handleThemeChange}
      />
    )
  }

  return (
    <Landing onEnterApp={(panel) => navigateTo(panel ? `app/${panel}` : "app")} />
  )
}