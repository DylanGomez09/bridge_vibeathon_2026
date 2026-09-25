# Carpeta de marca — Bridge

Subí acá los assets oficiales de la marca Bridge. Reemplazan a los placeholders actuales.

| Archivo                          | Uso                                   | Estado     |
| -------------------------------- | ------------------------------------- | ---------- |
| `favicon.svg`                    | favicon del sitio (`index.html`)      | placeholder |
| `logo.svg`                       | navbar (landing + sidebar)            | placeholder |
| `hero.png`                       | imagen del hero de la landing page    | NO creado (mount point) |

Detalles:

- `favicon.svg` y `logo.svg`: SVG (con o sin palabras/marca). Si subís PNG/JPG,
  actualizá la referencia en `frontend/index.html` (favicon) y en `navbar`-label
  de `frontend/src/ui/` (solo cambia la extensión).
- `hero.png`: subí la imagen del hero acá y **aparece sola** en la landing
  (el placeholder se oculta automáticamente cuando el archivo existe).
  Proporción recomendada: 16:10 o 4:3.