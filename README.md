# BRIDGE

Transcripción y traducción en tiempo real **(EN → ES)** de conferencias usando la **Gemini Live API** (modelo de audio, WebSocket bidireccional). Navegador → backend (relay WebSocket) → sesión `live` de Gemini; el backend devuelve la transcripción original y la traducción al español, y la UI las renderiza en un panel estilo "suptítulos".

## Cómo correr

```bash
pnpm install
pnpm dev          # backend (tsx watch) :3001 + frontend (vite) :5173
```

- **Backend**: `backend/.env` con `GEMINI_API_KEY=...` (ver "Configuración").
- **Frontend**: `http://localhost:5173`. Debug por consola habilitado con `?debug=1`.

## Audios de prueba

Todos los clips de prueba viven en **`backend/assets/`**:

| Archivo | Duración | Formato | Peso | Para qué sirve |
|---|---|---|---|---|
| `short-demo.wav` | 40,0 s | 16 kHz · mono · 16-bit | 1,22 MB | **Demo del jurado**: clip balanceado, da ~4 segmentos completos |
| `short-talk.wav` | 10,0 s | 16 kHz · mono · 16-bit | 0,31 MB | Iteración rápida al debuggear (un solo turno) |
| `talk.wav` | 355,0 s (5:55) | 16 kHz · mono · 16-bit | 10,83 MB | Charla completa; es el audio original del que salen los clips |
| `sample.pcm` | ~3,0 s | PCM crudo 16 kHz · mono · 16-bit | 96,9 KB | **Default de los tests de consola** (`test:connection` y `test:pipeline`) |
| `talk.webm` | — | WebM | 5,67 MB | Grabación original; ningún script la usa (sirve para probarla en la UI) |

### Probar un clip en la UI

Usá **"Subir archivo"** y elegí el clip. Para una prueba rápida, `short-talk.wav`; para el demo del jurado, `short-demo.wav`.

### Probar un clip en los tests de consola

Los tests aceptan un path como argumento. Si no lo pasás, usan `assets/sample.pcm`:

```bash
pnpm test:connection                                # usa backend/assets/sample.pcm
pnpm test:connection backend/assets/short-talk.wav  # clip de 10 s
pnpm test:pipeline backend/assets/short-demo.wav    # clip de 40 s
```

**Ojo**: los scripts de consola (`backend/src/audio/load-pcm.ts`) aceptan **solo `.pcm` y `.wav`**. El navegador acepta mucho más (`.mp3`, `.m4a`, `.ogg`, `.webm` y video `.mp4`, `.m4v`, `.mov`).

## Demo del jurado (protocolo)

1. Levantar backend con logs de diagnóstico: `BRIDGE_DEBUG=1 pnpm dev` (filtra `[tscriber-verbose]`/`[ws-relay]` en la terminal del backend).
2. Abrir `http://localhost:5173/?debug=1`.
3. Subir `backend/assets/short-demo.wav` (**40s**, 16 kHz / mono / 16-bit).
4. Esperar y narrar: primer texto ~6-8s, un segmento completo cada ~18s, 4 segmentos en ~70s de reloj.

Lo que el jurado ve en pantalla: el panel muestra primero la transcripción original en inglés que baja mientras el audio se "transmite", y debajo la traducción en español que se completa por segmentos.

## Rendimiento medido (run real, clip de 40s)

| Eslabón | Momento |
|---|---|
| Conexión WS + `start` | 0.0s |
| Gemini listo (`status/ready`, T3) | 1.4s |
| Primer chunk de audio (T1) | 1.9s |
| Subida turno 1 completa (100 chunks @ 2×) | 6.9s |
| Primer `original` (EN) en panel | 9.5s (T5−T1 = 7.6s) |
| Primera `translation` (ES) en panel | 10.0s (T5−T1 = 8.1s) |
| Segmento 1 | 16.9s (latencia de turno 10.0s) |
| Segmento 2 | 35.1s (13.2s) |
| Segmento 3 | 51.8s (11.7s) |
| Segmento 4 (final) | 69.9s (13.2s) |

Rangos observados en varios runs (`short-demo.wav` 40s y `short-talk.wav` 10s):

- **Primer texto en pantalla**: 5.4–8.1s después del primer chunk (varía por sesión).
- **Cadencia de segmentos**: ~16–22s (un turno de 10s de audio).
- **Latencia de finalización de turno**: ~11–13s (modelo "habla" la traducción; `turnComplete` llega al terminar).
- **Wall-clock vs duración del audio**: ~1.75–1.9× (40s → ~70s; 60s → ~114s).

Límite honesto: la latencia por turno está dominada por la finalización de turno de **Gemini con modality `audio`**, no por la subida de audio. Bien para 1 sesión de demo en vivo; tiempo real sostenido (o 2+ sesiones compitiendo por el mismo rate-limit) queda al límite.

## Arquitectura y decisiones

- **Modality `audio` obligatorio**: el modelo rechaza la modalidad `TEXT` (`1007 The requested combination of response modalities (TEXT) is not supported`). La traducción se recibe como `outputTranscription` de la respuesta hablada; `turnComplete` llega solo cuando el modelo termina de hablar.
- **Sin interims**: la API **no emite** `interimInputTranscription` durante el streaming — el texto (original y traducción) solo baja tras `audioStreamEnd` de cada turno. Por eso el diseño es **turn-splitting**: se envían turnos de 10s de audio a **2×** (100 chunks de 100ms, 50ms/chunk), se hace `endTurn` y se espera el `segment` antes de seguir (`TURN_CHUNKS = 100`, `TURN_WAIT_MS = 20000`). Intentar "overlap" (seguir subiendo sin esperar) es inestable con modality `audio`.
- **`accumulatedOutput` se resetea en cada `turnComplete`**: cada segmento es autocontenido; sin esto el texto del turno anterior contamina la traducción siguiente (`backend/src/gemini/transcriber.ts`).

## Configuración (backend/.env)

| Variable | Default | Descripción |
|---|---|---|
| `GEMINI_API_KEY` | — | Clave de Gemini |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Modelo Live |
| `GEMINI_LIVE_VOICE` | `Aoede` | Voz de la respuesta |
| `PORT` | `3001` | Puerto del backend |
| `BRIDGE_RESPONSE_MODALITY` | `audio` | `audio` o `text` (solo `audio` funciona) |
| `BRIDGE_SOURCE_LANG` | `en` | Idioma fuente |
| `BRIDGE_TARGET_LANG` | `es` | Idioma de traducción |

## Repo

```
backend/
  src/gemini/transcriber.ts   # sesión Live de Gemini, merge + reset de traducción
  src/ws/handler.ts           # relay WS (navegador ↔ backend) con log [ws-relay]
  src/config.ts               # env → BridgeConfig
  src/errors.ts               # errores crudos → mensajes en español para la UI
  src/audio/load-pcm.ts       # carga .pcm/.wav → PCM 16 kHz mono
  assets/                     # clips de prueba (ver "Audios de prueba")
  test-connection.ts          # smoke test contra la Gemini Live API
  test-pipeline.ts            # prueba del pipeline de audio
frontend/
  src/hooks/useBridgeSession.js     # playFile: pacing 2× + turn-splitting + retry
  src/lib/ws/bridge-socket.js       # protocolo WS (chunks binarios, endTurn, segment)
  src/lib/audio/decode-file.js      # decodifica el archivo del navegador a PCM 16 kHz
  src/lib/subtitles.js              # buildSrt + descarga del .srt
  src/lib/errors.js                 # errores → mensajes en español
  src/lib/debug.js                  # logs gated por ?debug=1
```