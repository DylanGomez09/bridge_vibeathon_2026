import { ChevronsIcon } from "./icons.jsx"

export default function Sidebar({ items, active, onSelect, collapsed, onToggle, onLogout, theme }) {
  const iconFile = (name) => `/brand/icons/${theme}/${name}.svg`

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label="Navegación">
      <div className="sidebar-head">
        <img className="brand-logo brand-logo-light" src="/brand/logo_light.svg" alt="Bridge" />
        <img className="brand-logo brand-logo-dark" src="/brand/logo_dark.svg" alt="Bridge" />
        <img className="brand-mark-toggle" src="/brand/favicon.svg" alt="" />
      </div>

      <nav className="nav" aria-label="Paneles" data-tour="nav">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item${active === item.id ? " active" : ""}`}
            aria-current={active === item.id ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            <img className="nav-icon" src={iconFile(item.icon)} alt="" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="nav-item toggle-item"
          aria-label={collapsed ? "Expandir sidebar" : "Comprimir sidebar"}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronsIcon
            size={22}
            style={{ transform: collapsed ? "rotate(180deg)" : "none", transition: "transform 320ms ease" }}
          />
          <span>Comprimir</span>
        </button>
        <button type="button" className="nav-item logout-item" onClick={onLogout}>
          <img className="nav-icon" src={iconFile("salir")} alt="" />
          <span>Salir</span>
        </button>
      </div>
    </aside>
  )
}