# BRIDGE

[![Node](https://img.shields.io/badge/Node-%3E%3D20-5FA04E?style=flat-square)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.15.1-F69220?style=flat-square)](https://pnpm.io)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square)](https://vite.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](#licencia)

Transcripción y traducción en tiempo real **(EN → ES)** de conferencias usando la **Gemini Live API** (modelo de audio, WebSocket bidireccional). El navegador captura el audio, el backend lo reenvía a una sesión `live` de Gemini y devuelve la transcripción original y la traducción al español, que la UI renderiza en un panel estilo "subtítulos".

---

## Índice

- [Arquitectura](#arquitectura)
- [Multi-sesión](#multi-sesión)
- [Cómo correr](#cómo-correr)
- [Audios de prueba](#audios-de-prueba)
- [Demo del jurado](#demo-del-jurado-protocolo)
- [Rendimiento medido](#rendimiento-medido-run-real-clip-de-40-s)
- [Decisiones de diseño](#decisiones-de-diseño)
- [Configuración](#configuración-backendenv)
- [Estructura del repo](#repo)
- [Licencia](#licencia)

---

## Arquitectura

```mermaid
flowchart LR
  NAV["Navegador<br/>Vite · React<br/>:5173"]
  REL["Backend relay<br/>Express + ws<br/>:3001"]
  REG["Registro de sesiones<br/>session_id → Gemini + oyentes"]
  GEM["Gemini Live API<br/>flash-live"]
  SRT["Subtítulos .srt"]

  NAV -->|"1 · audio PCM 16 kHz"| REL
  REL --> REG
  REG -->|"2 · realtime input (1 socket por sesión)"| GEM
  GEM -->|"3 · original + traducción"| REG
  REG -->|"4 · original + traducción (sólo suscriptos)"| NAV
  NAV -->|"5 · descargar"| SRT
```

El backend es un **relay**: no transcribe ni traduce, solo reenvía audio a Gemini y devuelve el texto. Por eso la `GEMINI_API_KEY` nunca llega al navegador.

### Flujo de un archivo (turn-splitting)

```mermaid
sequenceDiagram
  participant U as Navegador
  participant R as Relay
  participant G as Gemini Live
  U->>R: start
  R->>G: connect + systemInstruction
  G-->>R: setupComplete
  R-->>U: started + ready
  loop cada turno de 10 s (100 chunks a 2x)
    U->>R: 100 chunks binarios PCM
    R->>G: sendRealtimeInput
    U->>R: endTurn (audioStreamEnd)
    G-->>R: outputTranscription
    R-->>U: original + translation
    R-->>U: segment
  end
```

> [!IMPORTANT]
> El `segment` es la unidad de sincronización: el navegador **espera** a recibirlo antes de enviar el turno siguiente. Saltarse esa espera ("overlap") es inestable con modality `audio`.

---

## Multi-sesión

Varias sesiones conviven en el mismo backend sin mezclarse. Cada sesión tiene **su propio `session_id`**, **su propia conexión a Gemini Live** y **su propio juego de clientes suscriptos**.

### Estructura del registro

```text
session_id (uuid) → {
  id, label, sourceLang, targetLang, createdAt,
  ownerToken,          // secreto del owner: permite recuperar la sesión tras un refresh
  ownerId,             // clientId del dueño de la fuente de audio (null = huérfana)
  transcriber,         // UNA conexión a Gemini Live, exclusiva de esta sesión
  clients: Set<WS>,    // oyentes suscriptos (el owner también está)
  phase, closing, graceUntil,
}
```

Vive en `backend/src/sessions/registry.ts`. El mapa es privado y todas las mutaciones pasan por métodos, así que cada operación es atómica (JS es single-threaded).

### Garantías

- **Aislamiento de audio**: el audio binario se rutea **solo** a la sesión que ese WS tiene asignada, y **solo si es el owner**. El audio de A jamás alcanza el pipeline de B.
- **Aislamiento de subtítulos**: **todos** los mensajes salientes llevan `sessionId`; el frontend descarta los que no son de la sesión que está mirando.
- **Tune-in de sólo escucha**: un suscriptor recibe subtítulos pero no puede subir audio (si lo intenta, el backend lo rechaza).
- **Baja quirúrgica**: cuando un cliente se va se lo saca de su sesión; si era el owner, se cierra **esa** sesión y solo esa. Las demás no se tocan.
- **Sin condiciones de carrera**: el flag `closing` hace que un doble cierre sea un no-op, y la entrada sale del mapa **antes** de cerrar el transcriber, de modo que cualquier callback tardío de Gemini no encuentra la sesión y no escribe sobre nadie.
- **Tope de sesiones**: `BRIDGE_MAX_SESSIONS` (default 4) para no comerse el rate-limit; al excederlo el cliente recibe un error explícito.

### Ciclo de vida

```mermaid
stateDiagram-v2
  [*] --> connecting: start (crea sesión + socket Gemini)
  connecting --> ready: setupComplete
  ready --> ready: streaming por turnos
  ready --> reconnecting: se perdió Gemini
  reconnecting --> ready: reconectó
  ready --> grace: se fue el owner
  grace --> ready: volvió con ownerToken (refresh)
  grace --> ended: venció BRIDGE_SESSION_GRACE_MS
  ready --> ended: stop del owner / ended / failed
  ended --> [*]
```

> [!NOTE]
> El **grace period** existe para que un refresh de pestaña no corte la sesión. Al crear una sesión el servidor emite un `ownerToken`; el cliente lo guarda en `sessionStorage` y lo reenvía al reconectar. Si nadie lo reclama dentro de `BRIDGE_SESSION_GRACE_MS` (15 s), la sesión se cierra aunque queden oyentes (sin owner no hay audio posible). Con `0` el cierre es inmediato.

### Protocolo WebSocket

**Cliente → servidor**

| Mensaje | Payload | Efecto |
|---|---|---|
| `start` | `{label?, sourceLang?, targetLang?}` o `{reclaimSessionId, ownerToken}` | Crea una sesión (el cliente queda como owner) o recupera la suya |
| `subscribe` | `{sessionId}` | Sintoniza una sesión existente (sólo escucha) |
| `unsubscribe` | `{sessionId}` | Sale de la sesión |
| `sessions` | — | Pide el listado de sesiones activas |
| `end` | — | `endTurn` en la sesión suscripta |
| `stop` | `{sessionId?}` | El owner cierra su sesión |
| *binario* | PCM 16 kHz | Audio, sólo aceptado del owner |

**Servidor → cliente**

| Mensaje | Payload |
|---|---|
| `hello` | `{clientId, sessions}` al conectar |
| `sessions` | `{sessions: SessionMeta[]}` (broadcast ante cada alta/baja) |
| `started` | `{sessionId, ownerToken, meta}` (ACK) |
| `subscribed` | `{sessionId, meta, replayed: false}` |
| `sessionEnded` | `{sessionId, reason}` |
| `status` / `original` / `translation` / `segment` | `{sessionId, ...}` |

> [!WARNING]
> `replayed: false` es a propósito: Gemini no permite recuperar historial, así que un oyente que entra a mitad de una charla sólo ve lo que se diga de ahí en más. La UI lo dice explícito en vez de prometer un replay.

### El muro: varias transcripciones en una sola pantalla

El panel **Muro** muestra **todas** las sesiones activas en paralelo, en una grilla y **en sólo lectura**: una tarjeta por sesión con su texto en vivo.

- **Un socket WebSocket por sesión.** El protocolo impide que un WS esté suscripto a dos sesiones a la vez, así que ver varias a la vez significa abrir un socket por sesión. Por eso **no hizo falta tocar el backend** ni el aislamiento ya verificado.
- **Nunca manda audio.** El backend rechaza el audio de quien no es owner, así que el muro no puede corromper una sesión aunque tuviera un bug.
- **Sockets sólo mientras el muro está a la vista.** Mantener N conexiones abiertas todo el tiempo inflaría el contador de oyentes de cada sesión, así que al salir del panel se cierran.
- **"Ver en grande"** sintoniza esa sesión en el panel de Traducción.

> [!TIP]
> El backend cuenta las suscripciones reales, así que al abrir el Muro el número de oyentes de cada sesión sube. Es honesto (son clientes conectados de verdad), pero para el demo conviene no deixar el Muro abierto mientras se mira el contador.

### Probar la multi-sesión

```bash
pnpm test:sessions        # offline: ciclo de vida, carreras y aislamiento (no usa la red)
pnpm test:multisession    # e2e real: 2 sesiones simultáneas con idiomas distintos
```

`test:sessions` corre **94 checks sin tocar Gemini** (inyecta un transcriber falso), entre ellos: el audio de A no llega a B, un oyente no puede subir audio, cierres concurrentes y dobles, callback tardío tras el cierre, grace period (incluido el token inválido), el tope de sesiones y el fan-out de varios suscriptores de una misma sesión (lo que usa el Muro).

`test:multisession` levanta un backend real en un puerto efímero y corre **27 checks** contra la Gemini Live API: dos sesiones con idiomas distintos en paralelo, dos clientes suscriptos a una de ellas, y el cierre de A mientras B **sigue transcribiendo**.

### Probarlo en la UI

1. Abrí dos o tres pestañas de `http://localhost:5173`.
2. En la primera, iniciá el micrófono o subí un clip → se crea la sesión A.
3. En la segunda, hacé lo mismo con otro clip → se crea la sesión B.
4. En la primera, entrá a **Muro**: las dos sesiones en paralelo, sólo lectura.
5. En **Sesiones** hacés click en una fila para sintonizarla en Traducción.
6. `BRIDGE_DEBUG=1` en el backend para ver `[sessions][<id corto>]` en cada alta/baja, y `curl http://localhost:3001/health` para listarlas.

---

## Cómo correr

**Requisitos**: Node ≥ 20 y pnpm 10.15.1 (probado en Node 22.19.0).

```bash
pnpm install
cp backend/.env.example backend/.env    # luego pegá tu GEMINI_API_KEY
pnpm dev                                # backend :3001 + frontend :5173
```

- **Backend**: `backend/.env` con `GEMINI_API_KEY=...` (ver [Configuración](#configuración-backendenv)).
- **Frontend**: `http://localhost:5173`.

> [!TIP]
> Para debuggear: `BRIDGE_DEBUG=1 pnpm dev` en la terminal del backend (logs `[tscriber-verbose]` / `[ws-relay]`) y `http://localhost:5173/?debug=1` en el navegador.

---

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

> [!NOTE]
> Los scripts de consola (`backend/src/audio/load-pcm.ts`) aceptan **solo `.pcm` y `.wav`**. El navegador acepta mucho más (`.mp3`, `.m4a`, `.ogg`, `.webm` y video `.mp4`, `.m4v`, `.mov`).

### Scripts disponibles

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Backend (`tsx watch`) + frontend (`vite`) en paralelo |
| `pnpm build` | Compila backend (`tsc`) y frontend (`vite build`) |
| `pnpm --filter @bridge/frontend lint` | Lint del frontend (`oxlint`) |
| `pnpm test:connection [archivo]` | Smoke test contra la Gemini Live API |
| `pnpm test:pipeline [archivo]` | Prueba del pipeline de audio |
| `pnpm test:sessions` | Ciclo de vida multi-sesión, **offline** (94 checks, sin red) |
| `pnpm test:multisession` | E2E multi-sesión **real**: 2 sesiones simultáneas (27 checks) |
| `pnpm --filter @bridge/frontend preview` | Sirve el build de producción |

---

## Demo del jurado (protocolo)

1. Levantar el backend con logs de diagnóstico: `BRIDGE_DEBUG=1 pnpm dev`.
2. Abrir `http://localhost:5173/?debug=1`.
3. Subir `backend/assets/short-demo.wav` (**40 s**, 16 kHz / mono / 16-bit).
4. Esperar y narrar: primer texto ~6-8 s, un segmento completo cada ~18 s, 4 segmentos en ~70 s de reloj.

Lo que el jurado ve en pantalla: el panel muestra primero la transcripción original en inglés que baja mientras el audio se "transmite", y debajo la traducción en español que se completa por segmentos.

---

## Rendimiento medido (run real, clip de 40 s)

| Eslabón | Momento |
|---|---|
| Conexión WS + `start` | 0.0 s |
| Gemini listo (`status/ready`, T3) | 1.4 s |
| Primer chunk de audio (T1) | 1.9 s |
| Subida turno 1 completa (100 chunks @ 2×) | 6.9 s |
| Primer `original` (EN) en panel | 9.5 s (T5−T1 = 7.6 s) |
| Primera `translation` (ES) en panel | 10.0 s (T5−T1 = 8.1 s) |
| Segmento 1 | 16.9 s (latencia de turno 10.0 s) |
| Segmento 2 | 35.1 s (13.2 s) |
| Segmento 3 | 51.8 s (11.7 s) |
| Segmento 4 (final) | 69.9 s (13.2 s) |

Rangos observados en varios runs (`short-demo.wav` 40 s y `short-talk.wav` 10 s):

- **Primer texto en pantalla**: 5.4–8.1 s después del primer chunk (varía por sesión).
- **Cadencia de segmentos**: ~16–22 s (un turno de 10 s de audio).
- **Latencia de finalización de turno**: ~11–13 s (el modelo "habla" la traducción; `turnComplete` llega al terminar).
- **Wall-clock vs duración del audio**: ~1.75–1.9× (40 s → ~70 s; 60 s → ~114 s).

> [!WARNING]
> **Límite honesto**: la latencia por turno está dominada por la finalización de turno de Gemini con modality `audio`, no por la subida de audio. La multi-sesión está implementada y verificada (ver [Multi-sesión](#multi-sesión)), pero varias sesiones simultáneas compiten por el mismo rate-limit de Gemini: con 2 en paralelo anda bien para la demo; sostener más o más tiempo está al límite. Por eso existe `BRIDGE_MAX_SESSIONS`.

---

## Decisiones de diseño

- **Modality `audio` obligatorio**: el modelo rechaza la modalidad `TEXT` (`1007 The requested combination of response modalities (TEXT) is not supported`). La traducción se recibe como `outputTranscription` de la respuesta hablada; `turnComplete` llega solo cuando el modelo termina de hablar.
- **Sin interims**: la API **no emite** `interimInputTranscription` durante el streaming — el texto (original y traducción) solo baja tras `audioStreamEnd` de cada turno. Por eso el diseño es **turn-splitting** (ver el diagrama de secuencia): se envían turnos de 10 s de audio a **2×** (100 chunks de 100 ms, 50 ms/chunk), se hace `endTurn` y se espera el `segment` antes de seguir (`TURN_CHUNKS = 100`, `TURN_WAIT_MS = 20000`).
- **`accumulatedOutput` se resetea en cada `turnComplete`**: cada segmento es autocontenido; sin esto el texto del turno anterior contamina la traducción siguiente (`backend/src/gemini/transcriber.ts`).
- **Reconexión resiliente**: el backend reintenta el bind del puerto con backoff si el proceso anterior todavía lo ocupa (típico de `tsx watch`), y libera el puerto en `SIGINT`/`SIGTERM`. El frontend, si el ack de arranque se vence, descarta el socket y reintenta una vez.
- **Un registro explícito, no un closure por conexión**: antes el aislamiento entre sesiones salía de que cada conexión WS fabricaba su `Transcriber` en un closure. Eso aislaba, pero no había `session_id` ni forma de listar ni de sintonizar. Ahora el aislamiento es un objeto verificable (`SessionRegistry`) con la fábrica de `Transcriber` inyectada, lo que permite testear el ciclo de vida completo **sin red** (`test:sessions`).
- **Idiomas por sesión sin tocar el transcriber**: `Transcriber` ya recibía un `BridgeConfig` por constructor, así que el registro clona la config base y overridea `bridgeSourceLang`/`bridgeTargetLang` por sesión. Cero cambios en el pipeline de audio.
- **Tope de sesiones en el registro, no en Gemini**: preferimos un error propio y explícito ("se alcanzó el máximo de N sesiones") a un 429 opaco de la API.

---

## Configuración (backend/.env)

| Variable | Default | Descripción |
|---|---|---|
| `GEMINI_API_KEY` | — | Clave de [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Modelo Live |
| `GEMINI_LIVE_VOICE` | `Aoede` | Voz de la respuesta |
| `PORT` | `3001` | Puerto del backend |
| `BRIDGE_RESPONSE_MODALITY` | `audio` | `audio` o `text` (solo `audio` funciona) |
| `BRIDGE_SOURCE_LANG` | `en` | Idioma fuente |
| `BRIDGE_TARGET_LANG` | `es` | Idioma de traducción |
| `BRIDGE_RECONNECT_MAX_ATTEMPTS` | `3` | Reintentos de reconexión con Gemini |
| `BRIDGE_RECONNECT_BASE_DELAY_MS` | `1000` | Delay base del backoff exponencial |
| `BRIDGE_READY_TIMEOUT_MS` | `15000` | Timeout esperando `setupComplete` |
| `BRIDGE_STALE_SESSION_MS` | `60000` | Watchdog de sesión colgada (`0` desactiva) |
| `BRIDGE_MAX_SESSIONS` | `4` | Tope de sesiones simultáneas (una conexión a Gemini cada una) |
| `BRIDGE_SESSION_GRACE_MS` | `15000` | Grace tras irse el owner antes de cerrar la sesión (`0` = inmediato) |

---

## Repo

```text
backend/
  src/sessions/registry.ts      # registro de sesiones: alta/baja, grace, cap, aislamiento
  src/gemini/transcriber.ts     # sesión Live de Gemini, merge + reset de traducción
  src/ws/handler.ts             # protocolo WS multi-sesión + log [ws-relay]
  src/config.ts                 # env → BridgeConfig
  src/errors.ts                 # errores crudos → mensajes en español para la UI
  src/audio/load-pcm.ts         # carga .pcm/.wav → PCM 16 kHz mono
  assets/                       # clips de prueba (ver "Audios de prueba")
  test-connection.ts            # smoke test contra la Gemini Live API
  test-pipeline.ts              # prueba del pipeline de audio
  test-sessions-registry.ts     # multi-sesión offline: carreras y aislamiento (71 checks)
  test-multisession.ts          # e2e real de 2 sesiones simultáneas (21 checks)
frontend/
  src/hooks/useBridgeSession.js # sesión + tune-in, pacing 2×, turn-splitting, retry
  src/lib/ws/bridge-socket.js   # protocolo WS (chunks binarios, subscribe, endTurn)
  src/lib/audio/decode-file.js  # decodifica el archivo del navegador a PCM 16 kHz
  src/lib/subtitles.js          # buildSrt + descarga del .srt
  src/lib/errors.js             # errores → mensajes en español
  src/lib/debug.js              # logs gated por ?debug=1
  src/ui/panels/Sessions.jsx    # lista real de sesiones activas (click = sintonizar)
  src/ui/panels/SessionGrid.jsx  # muro: una tarjeta por sesión, sólo lectura
  src/hooks/useSessionGrid.js    # un socket por sesión para el muro (sólo lectura)
  src/ui/session-meta.js         # fase/idiomas compartidos entre listado y muro
```

---

## Licencia

[MIT](./LICENSE) © 2026 Bridge (Nerdearla Vibeathon 2026)
