import { GridIcon, HomeIcon, MicIcon, SessionsIcon, SettingsIcon, TranslateIcon } from "./icons.jsx"

export const NAV_ICONS = {
  home: HomeIcon,
  sesiones: SessionsIcon,
  muro: GridIcon,
  microfono: MicIcon,
  traduccion: TranslateIcon,
  ajustes: SettingsIcon,
}

export const NAV = [
  { id: "inicio", label: "Inicio", icon: "home" },
  { id: "sesiones", label: "Sesiones", icon: "sesiones" },
  { id: "muro", label: "Muro", icon: "muro" },
  { id: "microfono", label: "Micrófono", icon: "microfono" },
  { id: "traduccion", label: "Traducción", icon: "traduccion" },
  { id: "ajustes", label: "Ajustes", icon: "ajustes" },
]
