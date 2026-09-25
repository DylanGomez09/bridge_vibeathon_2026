export default function Settings({ prefs, setPref, theme, onThemeChange }) {
  return (
    <div className="content">
      <div className="settings-form">
        <article className="card">
          <h3>Idiomas</h3>
          <div className="settings-form">
            <div className="field">
              <label htmlFor="source-lang">Idioma fuente</label>
              <select
                id="source-lang"
                value={prefs.sourceLang}
                onChange={(event) => setPref("sourceLang", event.target.value)}
              >
                <option value="en">Inglés (EN)</option>
                <option value="es">Español (ES)</option>
                <option value="pt">Portugués (PT)</option>
                <option value="fr">Francés (FR)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="target-lang">Idioma de traducción</label>
              <select
                id="target-lang"
                value={prefs.targetLang}
                onChange={(event) => setPref("targetLang", event.target.value)}
              >
                <option value="es">Español (ES)</option>
                <option value="en">Inglés (EN)</option>
                <option value="pt">Portugués (PT)</option>
                <option value="fr">Francés (FR)</option>
              </select>
              <span className="field-hint">
                El backend de esta demo traduce EN → ES; los demás valores quedan
                listos para producción.
              </span>
            </div>
          </div>
        </article>

        <article className="card">
          <h3>Visualización</h3>
          <div className="field">
            <label>Modo de visualización del panel Traducción</label>
            <span className="field-hint">¿Cómo se muestran original y traducción?</span>
            <div className="segmented">
              {[
                { id: "cols", label: "Dos columnas" },
                { id: "single", label: "Una columna" },
                { id: "subtitles", label: "Subtítulos" },
              ].map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={prefs.displayMode === mode.id ? "active" : ""}
                  onClick={() => setPref("displayMode", mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </article>

        <article className="card">
          <h3>Apariencia</h3>
          <div className="field">
            <label>Tema</label>
            <span className="field-hint">
              Claro, oscuro o seguí la preferencia del sistema.
            </span>
            <div className="segmented">
              {[
                { id: "light", label: "Claro" },
                { id: "dark", label: "Oscuro" },
                { id: "system", label: "Sistema" },
              ].map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={theme === mode.id ? "active" : ""}
                  onClick={() => onThemeChange(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </article>

        <article className="card">
          <h3>Notificaciones</h3>
          <div className="switch-row">
            <div>
              <p className="switch-title">
                Sesiones que terminan
              </p>
              <p className="switch-hint field-hint">
                Aviso cuando una sesión en vivo finaliza.
              </p>
            </div>
            <span className="switch">
              <input
                id="notif"
                type="checkbox"
                checked={prefs.notifications}
                onChange={(event) => setPref("notifications", event.target.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </span>
          </div>
        </article>
      </div>
    </div>
  )
}