import { useCallback, useEffect, useRef, useState } from "react"
import { BridgeSocket } from "../lib/ws/bridge-socket.js"
import { startMicCapture, stopMicCapture } from "../lib/audio/capture-mic.js"
import { decodeFileToPcm16kMono } from "../lib/audio/decode-file.js"
import { float32ToPcmChunks, pcmChunkDurationMs } from "../lib/audio/pcm.js"
import { friendlyMessage } from "../lib/errors.js"
import { debug, elapsedSec } from "../lib/debug.js"
import { getHealth } from "../lib/api.js"

const START_ACK_TIMEOUT_MS = 5_000
const READY_BACKSTOP_MS = 120_000
const FILE_PLAYBACK_RATE = 1
const TURN_CHUNKS = 100
const TURN_WAIT_MS = 20_000
const RESYNC_SETTLE_MS = 400
const ACK_TIMEOUT_MESSAGE = "El servidor no respondió al iniciar la sesión"
const START_RETRY_DELAY_MS = 2_000
const START_MAX_RETRIES = 1
const LOCAL_SESSION_CAP = 8

const isRetryableStartError = (cause) => {
  const raw = typeof cause === "string" ? cause : (cause?.message ?? "")
  return raw === ACK_TIMEOUT_MESSAGE || /no respondió al iniciar|econnrefused|econnreset/i.test(raw)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const OWNERS_STORAGE_KEY = "bridge:owners"
const LEGACY_OWNER_STORAGE_KEY = "bridge:owner"

const readOwners = () => {
  try {
    const raw = window.sessionStorage.getItem(OWNERS_STORAGE_KEY)
    const map = raw ? JSON.parse(raw) : {}
    if (map && typeof map === "object") return map
    return {}
  } catch {
    return {}
  }
}

const readLegacyOwner = () => {
  try {
    const raw = window.sessionStorage.getItem(LEGACY_OWNER_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const writeOwners = (map) => {
  try {
    const next = { ...map }
    for (const value of Object.values(next)) {
      if (!value) delete next[Object.keys(next).find((key) => next[key] === value)]
    }
    if (Object.keys(next).length) window.sessionStorage.setItem(OWNERS_STORAGE_KEY, JSON.stringify(next))
    else window.sessionStorage.removeItem(OWNERS_STORAGE_KEY)
  } catch {
    return
  }
}

const emptyView = () => ({
  phase: "idle",
  connState: "connected",
  error: null,
  segments: [],
  currentOriginal: null,
  currentTranslation: "",
  sourceInfo: null,
  processingFile: false,
  progress: 0,
  isOwner: false,
  sessionId: null,
  hasSource: false,
  sourceKind: null,
  isMic: false,
})

function createRuntime(options) {
  const { emit, onFinished, releaseMicIfHeld, onSessions, storage, onLocalOwner } = options

  const rt = {
    id: `local-${Math.random().toString(36).slice(2, 10)}`,
    socket: null,
    worklet: null,
    stopped: false,
    wantSession: false,
    dropped: false,
    attachGate: Promise.resolve(),
    gateUnlock: null,
    original: "",
    translation: "",
    segmentId: 0,
    phase: "idle",
    readyResolve: null,
    readyReject: null,
    readyBackstop: null,
    ackResolve: null,
    streamStart: null,
    segmentResolve: null,
    sessionId: null,
    ownerToken: null,
    isOwner: false,
    sourceKind: null,
    finished: false,
  }

  const patch = (next) => emit(rt.id, next)

  const isCurrentSession = (message) => {
    const id = message?.sessionId
    return id ? id === rt.sessionId : true
  }

  const resetSubtitles = () => {
    rt.original = ""
    rt.translation = ""
    rt.segmentId = 0
    rt.streamStart = performance.now()
    patch({ segments: [], currentOriginal: null, currentTranslation: "" })
  }

  const applyPhase = (next) => {
    rt.phase = next
    patch({ phase: next })
  }

  const settleReady = (kind, value) => {
    if (kind === "resolve") rt.readyResolve?.()
    else rt.readyReject?.(value)
    rt.readyResolve = null
    rt.readyReject = null
  }

  const positionMs = () => {
    if (!rt.streamStart) return 0
    return Math.max(0, performance.now() - rt.streamStart)
  }

  const waitTurnSegment = () =>
    new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (rt.segmentResolve === finish) rt.segmentResolve = null
        resolve()
      }
      const timer = setTimeout(finish, TURN_WAIT_MS)
      rt.segmentResolve = finish
    })

  const storeOwner = (sessionId, token) => {
    rt.ownerToken = token
    storage.set(sessionId, token)
    onLocalOwner(sessionId)
  }

  const clearOwner = (sessionId) => {
    if (sessionId) storage.delete(sessionId)
    rt.ownerToken = null
  }

  const wireSocket = (socket) => {
    socket.on("hello", (message) => {
      rt.clientId = message.clientId ?? rt.clientId
      onSessions(message.sessions ?? [])
    })

    socket.on("sessions", (message) => {
      onSessions(message.sessions ?? [])
    })

    socket.on("status", (message) => {
      if (message.sessionId && rt.sessionId && message.sessionId !== rt.sessionId) return
      rt.ackResolve?.()
      if (message.phase === "error" || message.phase === "failed") {
        const detail = message.detail ?? "Se perdió la conexión con la sesión."
        rt.serverError = detail
        patch({ error: friendlyMessage(detail, detail) })
        applyPhase(message.phase)
        settleReady("reject", new Error(message.detail ?? "Error de sesión"))
        return
      }
      if (message.phase === "reconnecting") applyPhase("reconnecting")
      if (message.phase === "ready") {
        applyPhase("live")
        settleReady("resolve")
      }
      if (message.phase === "connecting") applyPhase("connecting")
      if (message.phase === "ended") {
        applyPhase("ended")
        settleReady("reject", new Error("La sesión se cerró antes de estar lista"))
      }
    })

    socket.on("started", (message) => {
      if (message.sessionId) {
        rt.sessionId = message.sessionId
        rt.isOwner = true
        if (message.ownerToken) storeOwner(message.sessionId, message.ownerToken)
        patch({ sessionId: message.sessionId, isOwner: true })
      }
      rt.ackResolve?.()
    })

    socket.on("subscribed", (message) => {
      if (!message.sessionId) return
      rt.sessionId = message.sessionId
      // La fuente de verdad del ownership es el servidor: meta.ownerId es el clientId
      // del dueño. Un tune-in puede re-apuntar este mismo socket a una sesión ajena, y
      // comparar contra ownerId evita depender de una bandera local que se desincroniza.
      const owner = message.meta?.ownerId ?? null
      const owns = Boolean(rt.clientId) && owner === rt.clientId
      rt.isOwner = owns
      patch({ sessionId: message.sessionId, isOwner: owns })
    })

    socket.on("unsubscribed", (message) => {
      if (message.sessionId === rt.sessionId) {
        rt.sessionId = null
        patch({ sessionId: null, isOwner: false })
      }
    })

    socket.on("sessionEnded", (message) => {
      if (rt.sessionId && message.sessionId === rt.sessionId) clearOwner(rt.sessionId)
      if (message.sessionId === rt.sessionId) {
        rt.sessionId = null
        rt.isOwner = false
        rt.stopped = true
        resetSubtitles()
        patch({
          sessionId: null,
          isOwner: false,
          hasSource: false,
          sourceKind: null,
          isMic: false,
          progress: 0,
          processingFile: false,
        })
        if (message.reason === "owner-timeout" || message.reason === "owner-disconnected") {
          patch({ error: "Se perdió la fuente de audio: la sesión se cerró." })
          applyPhase("ended")
        }
      }
      if (!rt.finished) {
        rt.finished = true
        onFinished(rt.id)
      }
    })

    socket.on("original", (message) => {
      if (!isCurrentSession(message)) return
      const text = message.text ?? ""
      if (message.interim) {
        patch({ currentOriginal: { text, interim: true } })
      } else {
        rt.original = text
        patch({ currentOriginal: { text, interim: false, ts: positionMs() } })
      }
    })

    socket.on("translation", (message) => {
      if (!isCurrentSession(message)) return
      rt.translation = message.text ?? ""
      patch({ currentTranslation: rt.translation })
    })

    socket.on("segment", (message) => {
      if (!isCurrentSession(message)) return
      const segment = {
        id: rt.segmentId++,
        ts: positionMs(),
        original: rt.original,
        translation: rt.translation,
      }
      patch((prev) => ({ segments: [...prev.segments, segment] }))
      rt.original = ""
      rt.translation = ""
      patch({ currentOriginal: null, currentTranslation: "" })
      rt.segmentResolve?.()
    })

    socket.on("close", () => {
      if (rt.phase !== "error" && rt.phase !== "failed") applyPhase("ended")
      settleReady("reject", new Error("La sesión se cerró"))
    })

    socket.on("reconnecting", () => {
      patch({ connState: "reconnecting" })
      rt.dropped = true
      rt.attachGate = new Promise((resolve) => {
        rt.gateUnlock = resolve
      })
    })

    socket.on("offline", () => {
      patch({ connState: "offline" })
      if (rt.gateUnlock) {
        rt.gateUnlock()
        rt.gateUnlock = null
      }
      rt.attachGate = Promise.resolve()
    })

    socket.on("connected", () => {
      patch({ connState: "connected" })
      if (rt.dropped && rt.wantSession && !rt.stopped) {
        rt.dropped = false
        rt.attachGate = resyncSession()
      } else if (rt.gateUnlock) {
        rt.gateUnlock()
        rt.gateUnlock = null
        rt.attachGate = Promise.resolve()
      }
    })
  }

  const resyncSession = () => {
    const task = (async () => {
      try {
        const socket = await getSocket()
        if (rt.isOwner && rt.sessionId && rt.ownerToken) {
          socket.start({ reclaimSessionId: rt.sessionId, ownerToken: rt.ownerToken })
        } else if (rt.sessionId) {
          socket.subscribe(rt.sessionId)
        } else {
          socket.start()
        }
        applyPhase("connecting")
        patch({ error: null })
        await new Promise((resolve) => setTimeout(resolve, RESYNC_SETTLE_MS))
      } catch (cause) {
        patch({ error: friendlyMessage(cause, "No se pudo restablecer la sesión") })
      }
      if (rt.gateUnlock) {
        rt.gateUnlock()
        rt.gateUnlock = null
      }
    })()
    return task
  }

  const sendChunk = async (chunk) => {
    await rt.attachGate
    const socket = rt.socket
    if (!socket) return false
    return socket.sendAudioChunk(chunk)
  }

  const connectSocket = async () => {
    const socket = new BridgeSocket()
    rt.socket = socket
    wireSocket(socket)
    await socket.connect()
    return socket
  }

  const getSocket = async () => {
    const existing = rt.socket
    if (existing && !existing.destroyed) {
      if (existing.ws?.readyState === WebSocket.OPEN) return existing
      await existing.waitOpen()
      return existing
    }
    return connectSocket()
  }

  const ensureSocket = async () => {
    const socket = rt.socket
    if (socket && !socket.destroyed) return socket
    return getSocket()
  }

  // El registro del backend guarda una sola sesión por WebSocket (#subscribed es
  // ws -> sessionId). Por eso un mismo socket no puede ser owner de una sesión y
  // estar sintonizado a otra: si se re-apunta con tuneTo, el audio se manda a la
  // sesión ajena y el backend responde "Sólo el owner puede enviar audio".
  // Para capturar audio se descarta el socket y se arranca con uno virgen, que el
  // backend todavía no tiene en #subscribed: el 'start' siguiente lo deja owner.
  //
  // Lo que NO se descarta es la sesión. Si ya somos owner de una viva, su id y su
  // ownerToken se conservan y el socket virgen la vuelve a reclamar (el mismo camino
  // que usa resyncSession). Borrar también la sesión obligaba a un alta nueva en cada
  // arranque, y con maxSessions en 4 eso llenaba el cupo del servidor y a partir de
  // ahí ninguna ruta de audio podía arrancar.
  const claimFreshSocket = () => {
    rt.socket?.close()
    rt.socket = null
    if (!rt.isOwner) {
      rt.sessionId = null
      rt.ownerToken = null
    }
    rt.serverError = null
  }

  const beginSession = async (createOptions = {}) => {
    patch({ error: null })
    applyPhase("connecting")
    rt.attachGate = Promise.resolve()

    // Si este runtime ya tiene una sesión propia y viva, se la reutiliza. Abrir una
    // sesión nueva en cada inicio llenaba el cupo del servidor (maxSessions) y a
    // partir de ahí ninguna ruta de audio podía arrancar.
    // El reuse sólo entra si además se está pidiendo la MISMA fuente: si el runtime ya
    // está transmitiendo un archivo, subir otro es una sesión nueva (y al revés), para
    // no mezclar fuentes ni acumular subtítulos de archivos distintos en una sesión.
    const sameSource = !createOptions.intent || rt.sourceKind === createOptions.intent
    const ownLiveSession =
      !createOptions.resume &&
      !createOptions.reclaimSessionId &&
      !createOptions.label &&
      sameSource &&
      Boolean(rt.sessionId) &&
      rt.isOwner === true
    const hasLiveSocket = Boolean(rt.socket) && !rt.socket.destroyed
    // Sesión propia viva pero socket descartado por claimFreshSocket: hay que
    // reclamarla en el socket virgen, no dar de alta otra. Sin ownerToken no se puede
    // reclamar, así que en ese caso sí se abre una sesión nueva.
    const reclaimingOwnSession =
      ownLiveSession && !hasLiveSocket && Boolean(rt.ownerToken)

    if (!createOptions.resume && !reclaimingOwnSession) {
      patch({
        segments: [],
        currentOriginal: null,
        currentTranslation: "",
        sourceInfo: null,
        processingFile: false,
        progress: 0,
      })
      rt.streamStart = null
    }
    rt.stopped = false
    rt.wantSession = true
    rt.ackResolve = null

    if (ownLiveSession && hasLiveSocket) {
      if (!rt.streamStart) rt.streamStart = performance.now()
      return
    }

    let reclaimSessionId = createOptions.reclaimSessionId
    let reclaimToken = reclaimSessionId
      ? (createOptions.ownerToken ?? storage.get(reclaimSessionId))
      : null
    if (!reclaimSessionId && reclaimingOwnSession) {
      reclaimSessionId = rt.sessionId
      reclaimToken = rt.ownerToken
    }
    if (reclaimSessionId && reclaimToken) {
      rt.sessionId = reclaimSessionId
      rt.ownerToken = reclaimToken
    }

    const attemptOnce = async () => {
      const socket = await getSocket()
      if (reclaimSessionId && reclaimToken) {
        socket.start({ reclaimSessionId, ownerToken: reclaimToken })
      } else {
        socket.start({
          label: createOptions.label,
          sourceLang: createOptions.sourceLang,
          targetLang: createOptions.targetLang,
        })
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rt.ackResolve = null
          reject(new Error(ACK_TIMEOUT_MESSAGE))
        }, START_ACK_TIMEOUT_MS)
        rt.ackResolve = () => {
          clearTimeout(timer)
          rt.ackResolve = null
          resolve()
        }
      })

      const ready = new Promise((resolve, reject) => {
        rt.readyResolve = resolve
        rt.readyReject = reject
      })
      const backstop = new Promise((_, reject) => {
        rt.readyBackstop = setTimeout(
          reject,
          READY_BACKSTOP_MS,
          new Error("La sesión tardó demasiado en estar lista. Reconectando…"),
        )
      })
      await Promise.race([ready, backstop])
      clearTimeout(rt.readyBackstop ?? undefined)
      rt.readyBackstop = null
      if (!rt.streamStart) rt.streamStart = performance.now()
    }

    try {
      let attempt = 0
      for (;;) {
        try {
          await attemptOnce()
          break
        } catch (cause) {
          if (rt.readyBackstop) {
            clearTimeout(rt.readyBackstop)
            rt.readyBackstop = null
          }
          settleReady("reject", cause)
          rt.ackResolve = null
          const canRetry = attempt < START_MAX_RETRIES && !rt.stopped && isRetryableStartError(cause)
          if (!canRetry) throw cause
          attempt += 1
          rt.socket?.close()
          rt.socket = null
          await delay(START_RETRY_DELAY_MS)
          applyPhase("connecting")
          patch({ error: null })
        }
      }
    } catch (cause) {
      if (rt.readyBackstop) {
        clearTimeout(rt.readyBackstop)
        rt.readyBackstop = null
      }
      settleReady("reject", cause)
      rt.ackResolve = null
      const serverError = rt.serverError
      rt.serverError = null
      if (!serverError) patch({ error: friendlyMessage(cause, "No se pudo iniciar la sesión") })
      const applied = rt.phase
      if (applied !== "failed" && applied !== "ended" && applied !== "error") applyPhase("error")
      throw cause
    }
  }

  rt.beginSession = beginSession
  rt.ensureSocket = ensureSocket

  rt.ensureOwner = async () => {
    rt.serverError = null
    patch({ error: null })
    if (rt.isOwner === true && rt.sessionId) return
    rt.sessionId = null
    rt.isOwner = false
    await rt.beginSession({})
  }

  rt.startMic = async () => {
    releaseMicIfHeld(rt.id)
    rt.serverError = null
    try {
      // intent: "mic" habilita el reuse de la sesión propia. Reclamarla en el socket
      // virgen en vez de dar de alta otra es lo que evita que cada arranque llene el
      // cupo del servidor.
      claimFreshSocket()
      await beginSession({ intent: "mic" })
      await rt.ensureOwner()
    } catch (cause) {
      const detail = rt.serverError
      rt.serverError = null
      if (!detail) {
        patch({ error: friendlyMessage(cause, "No se pudo iniciar la sesión del micrófono") })
        applyPhase("error")
      }
      rt.wantSession = false
      return
    }
    try {
      const worklet = await startMicCapture((chunk) => {
        // Mismo gate que la ruta de archivo: se espera al attach y, si el runtime
        // dejó de ser owner (tune-in, cierre, sesión ajena), el chunk se descarta en
        // vez de hacerlo rebotar contra el registro del backend.
        if (rt.stopped || !rt.isOwner) return
        void sendChunk(chunk).catch(() => {})
      })
      rt.worklet = worklet
      rt.sourceKind = "mic"
      patch({ hasSource: true, sourceKind: "mic", isMic: true })
      if (rt.stopped) stopMicCapture()
    } catch (cause) {
      patch({ error: friendlyMessage(cause, "No se pudo acceder al micrófono") })
      applyPhase("error")
    }
  }

  rt.playFile = async (file) => {
    try {
      claimFreshSocket()
      await beginSession()
      await rt.ensureOwner()
    } catch (cause) {
      patch({
        processingFile: false,
        error: friendlyMessage(cause, "No se pudo iniciar la sesión para procesar el archivo"),
      })
      applyPhase("error")
      rt.wantSession = false
      return
    }
    try {
      patch({ processingFile: true, progress: 0 })
      const samples = await decodeFileToPcm16kMono(file)
      const durationMs = (samples.length / 16000) * 1000
      patch({ sourceInfo: { name: file.name, durationMs }, hasSource: true, sourceKind: "file" })
      rt.sourceKind = "file"
      const chunks = float32ToPcmChunks(samples)
      const total = chunks.length
      debug(
        `[file] ${file.name} · dur ${Math.round(durationMs / 1000)}s · ${total} chunks × ${chunks[0]?.byteLength ?? 0} bytes`,
      )
      const step = pcmChunkDurationMs() / FILE_PLAYBACK_RATE
      rt.streamStart = performance.now()
      let turn = 0
      for (let index = 0; index < chunks.length; index += 1) {
        if (rt.stopped) break
        const start = performance.now()
        const sent = await sendChunk(chunks[index])
        if (!sent) {
          patch({ error: "No se pudo restablecer la sesión: quedó sin conexión con el servidor." })
          applyPhase("ended")
          break
        }
        patch({ progress: (index + 1) / total })
        const wait = Math.max(0, step - (performance.now() - start))
        if (index < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
        if ((index + 1) % TURN_CHUNKS === 0 && index < chunks.length - 1) {
          turn += 1
          rt.socket?.endTurn()
          debug(`[file] turno ${turn} — esperando segmento (${elapsedSec(rt.streamStart)})`)
          await waitTurnSegment()
        }
      }
      if (!rt.stopped) {
        rt.socket?.endTurn()
        debug(`[file] turno final — esperando segmento (${elapsedSec(rt.streamStart)})`)
        await waitTurnSegment()
        patch({ progress: 1 })
      }
      patch({ processingFile: false })
    } catch (cause) {
      patch({ processingFile: false, error: friendlyMessage(cause, "No se pudo procesar el archivo") })
      applyPhase("error")
    }
    rt.wantSession = false
  }

  // Sintonizar a otra sesión deja de ser owner en este mismo socket, así que el
  // micrófono tiene que soltarse antes: si siguiera capturando, cada chunk caería en
  // la sesión ajena y el registro lo rechazaría con "Sólo el owner de la sesión
  // puede enviar audio".
  const dropMicIfHeld = () => {
    if (rt.sourceKind === "mic") releaseMicIfHeld(rt.id, true)
    rt.sourceKind = null
    rt.worklet = null
  }

  rt.tuneTo = async (nextId) => {
    if (!nextId || nextId === rt.sessionId) return
    let socket
    try {
      socket = await ensureSocket()
    } catch {
      patch({ error: "No se pudo conectar al servidor para sintonizar la sesión." })
      return
    }
    dropMicIfHeld()
    const previous = rt.sessionId
    if (previous) socket.unsubscribe(previous)
    rt.sessionId = nextId
    rt.isOwner = false
    patch({ sessionId: nextId, isOwner: false, error: null })
    resetSubtitles()
    socket.subscribe(nextId)
  }

  rt.leaveSession = () => {
    const socket = rt.socket
    const previous = rt.sessionId
    if (socket && previous) socket.unsubscribe(previous)
    dropMicIfHeld()
    rt.sessionId = null
    rt.isOwner = false
    rt.hasSource = false
    patch({
      sessionId: null,
      isOwner: false,
      hasSource: false,
      sourceKind: null,
      isMic: false,
      progress: 0,
    })
    resetSubtitles()
  }

  rt.stop = () => {
    rt.stopped = true
    rt.wantSession = false
    rt.dropped = false
    if (rt.sourceKind === "mic") releaseMicIfHeld(rt.id, true)
    rt.sourceKind = null
    rt.segmentResolve?.()
    rt.segmentResolve = null
    rt.ackResolve = null
    if (rt.readyBackstop) {
      clearTimeout(rt.readyBackstop)
      rt.readyBackstop = null
    }
    settleReady("reject", new Error("Sesión detenida"))
    rt.socket?.endTurn()
    rt.socket?.stop(rt.sessionId ?? undefined)
    rt.socket?.close()
    rt.socket = null
    if (rt.sessionId) clearOwner(rt.sessionId)
    rt.sessionId = null
    rt.isOwner = false
    if (rt.gateUnlock) {
      rt.gateUnlock()
      rt.gateUnlock = null
    }
    rt.attachGate = Promise.resolve()
    rt.worklet = null
    patch({
      sessionId: null,
      isOwner: false,
      hasSource: false,
      sourceKind: null,
      isMic: false,
      processingFile: false,
      progress: 0,
      currentOriginal: null,
      currentTranslation: "",
    })
    applyPhase("ended")
  }

  rt.dispose = () => {
    rt.stopped = true
    rt.wantSession = false
    if (rt.sourceKind === "mic") stopMicCapture()
    if (rt.readyBackstop) clearTimeout(rt.readyBackstop)
    rt.readyBackstop = null
    rt.ackResolve = null
    rt.segmentResolve?.()
    rt.segmentResolve = null
    if (rt.gateUnlock) {
      rt.gateUnlock()
      rt.gateUnlock = null
    }
    rt.socket?.close()
    rt.socket = null
  }

  return rt
}

const makeStorage = () => {
  const map = readOwners()
  const legacy = readLegacyOwner()
  if (legacy?.sessionId && legacy?.ownerToken && !map[legacy.sessionId]) {
    map[legacy.sessionId] = legacy.ownerToken
    writeOwners(map)
  }
  if (legacy) {
    try {
      window.sessionStorage.removeItem(LEGACY_OWNER_STORAGE_KEY)
    } catch {}
  }
  return {
    get: (sessionId) => map[sessionId],
    set: (sessionId, token) => {
      map[sessionId] = token
      writeOwners(map)
    },
    delete: (sessionId) => {
      delete map[sessionId]
      writeOwners(map)
    },
    all: () => ({ ...map }),
  }
}

export function useBridgeSessions() {
  const [sessions, setSessions] = useState([])
  const [views, setViews] = useState({})
  const [runtimeIds, setRuntimeIds] = useState([])
  const [focusId, setFocusId] = useState(null)
  const [maxSessions, setMaxSessions] = useState(4)

  const runtimesRef = useRef(new Map())
  const focusRef = useRef(null)
  const storageRef = useRef(null)
  const micHolderRef = useRef(null)
  const mountedRef = useRef(true)
  // Sesiones queroscope creadas por ESTA carga de página. El reclaim existe para
  // sobrevivir a un F5 (sessionStorage persiste en la pestaña), así que sólo debe
  // operar sobre sesiones heredadas: reclamar una que esta carga acaba de crear le
  // transfiere el ownership a otro socket y el audio del micro empieza a rebotar con
  // "Sólo el owner de la sesión puede enviar audio".
  const localOwnerRef = useRef(new Set())

  if (storageRef.current === null) storageRef.current = makeStorage()

  useEffect(() => {
    mountedRef.current = true
    const runtimes = runtimesRef.current
    const focus = focusRef
    return () => {
      mountedRef.current = false
      for (const rt of runtimes.values()) rt.dispose()
      runtimes.clear()
      focus.current = null
    }
  }, [])

  useEffect(() => {
    let active = true
    getHealth().then((health) => {
      if (active) setMaxSessions(health.maxSessions)
    })
    return () => {
      active = false
    }
  }, [])

  const emit = useCallback((runtimeId, next) => {
    if (!mountedRef.current) return
    setViews((prev) => {
      const current = prev[runtimeId] ?? emptyView()
      const merged = typeof next === "function" ? next(current) : { ...current, ...next }
      if (merged === current) return prev
      return { ...prev, [runtimeId]: merged }
    })
  }, [])

  const onFinished = useCallback((runtimeId) => {
    setViews((prev) => {
      const view = prev[runtimeId]
      if (!view || view.phase === "ended" || view.phase === "error" || view.phase === "failed") {
        return prev
      }
      return { ...prev, [runtimeId]: { ...view, phase: "ended" } }
    })
  }, [])

  const focus = useCallback((runtimeId) => {
    focusRef.current = runtimeId
    setFocusId(runtimeId)
  }, [])

  const releaseMicIfHeld = useCallback((keepId, force = false) => {
    const holder = micHolderRef.current
    if (!holder) return
    if (holder === keepId && !force) return
    const rt = runtimesRef.current.get(holder)
    micHolderRef.current = null
    stopMicCapture()
    if (rt) {
      rt.sourceKind = null
      rt.worklet = null
      emit(rt.id, { hasSource: false, sourceKind: null, isMic: false })
    }
  }, [emit])

  const onSessions = useCallback((list) => {
    if (!mountedRef.current) return
    setSessions(list)
  }, [])

  const markLocalOwner = useCallback((sessionId) => {
    localOwnerRef.current.add(sessionId)
  }, [])

  const addRuntime = useCallback((sessionId = null) => {
    const rt = createRuntime({
      emit,
      onFinished,
      releaseMicIfHeld,
      onSessions,
      storage: storageRef.current,
      onLocalOwner: markLocalOwner,
    })
    rt.sessionId = sessionId
    runtimesRef.current.set(rt.id, rt)
    setRuntimeIds((prev) => (prev.includes(rt.id) ? prev : [...prev, rt.id]))
    emit(rt.id, emptyView())
    if (sessionId) emit(rt.id, { sessionId })
    if (!focusRef.current) focus(rt.id)
    return rt
  }, [emit, onFinished, focus, releaseMicIfHeld, onSessions, markLocalOwner])

  const ensureRuntime = useCallback(
    (runtimeId) => {
      const found = runtimesRef.current.get(runtimeId ?? focusRef.current)
      // Una runtime oyente (tune-in a sesión ajena) no puede enviar audio: el registro
      // rechaza el push con "Sólo el owner puede enviar audio". Para capturar audio
      // hace falta una runtime que sea dueña, así que se crea una nueva.
      if (found && found.isOwner !== false) return found
      const created = addRuntime()
      focus(created.id)
      return created
    },
    [addRuntime, focus],
  )

  const createSession = useCallback(async (createOptions = {}) => {
    const rt = addRuntime()
    try {
      await rt.beginSession(createOptions)
      return rt.id
    } catch {
      return null
    }
  }, [addRuntime])

  const closeSession = useCallback((runtimeId) => {
    const rt = runtimesRef.current.get(runtimeId)
    if (!rt) return
    // Hay que soltar el micro antes de cerrar el socket: si el worklet siguiera vivo
    // mandaría chunks contra un socket que ya no existe.
    if (micHolderRef.current === runtimeId) {
      micHolderRef.current = null
      stopMicCapture()
    }
    // rt.stop() manda el "stop" por el WS para que el backend cierre la sesión y avise
    // a los oyentes. Con sólo dispose() el socket se cerraba localmente y el backend
    // veía irse al owner, así que dejaba la sesión 15s huérfana con una cuenta
    // regresiva antes de limpiarla sola.
    rt.stop()
    rt.dispose()
    runtimesRef.current.delete(runtimeId)
    setRuntimeIds((prev) => prev.filter((id) => id !== runtimeId))
    setViews((prev) => {
      if (!(runtimeId in prev)) return prev
      const next = { ...prev }
      delete next[runtimeId]
      return next
    })
    if (focusRef.current === runtimeId) {
      const nextFocus = runtimeIds.find((id) => id !== runtimeId) ?? null
      focusRef.current = nextFocus
      setFocusId(nextFocus)
    }
  }, [runtimeIds])

  const startMic = useCallback(async (runtimeId) => {
    const rt = ensureRuntime(runtimeId)
    if (!rt) return
    focus(rt.id)
    micHolderRef.current = rt.id
    await rt.startMic()
  }, [ensureRuntime, focus])

  const playFile = useCallback(async (runtimeId, file) => {
    const rt = ensureRuntime(runtimeId)
    if (!rt) return
    focus(rt.id)
    await rt.playFile(file)
  }, [ensureRuntime, focus])

  const stop = useCallback((runtimeId) => {
    const rt = runtimesRef.current.get(runtimeId ?? focusRef.current)
    if (rt) rt.stop()
  }, [])

  const leaveSession = useCallback((runtimeId) => {
    const rt = runtimesRef.current.get(runtimeId ?? focusRef.current)
    if (rt) rt.leaveSession()
  }, [])

  const refreshSessions = useCallback(async () => {
    const rt = runtimesRef.current.values().next().value
    if (!rt) return
    try {
      const socket = await rt.ensureSocket()
      socket.requestSessions()
    } catch {}
  }, [])

  const tuneToSession = useCallback((sessionId) => {
    if (focusId) {
      runtimesRef.current.get(focusId)?.tuneTo(sessionId)
      return
    }
    const rt = addRuntime()
    void rt.tuneTo(sessionId)
  }, [addRuntime, focusId])

  const claimedRef = useRef(new Set())
  useEffect(() => {
    if (!sessions.length) return
    const storage = storageRef.current
    if (!storage) return
    const live = new Set(sessions.map((session) => session.id))
    const stored = Object.entries(storage.all())

    for (const [sessionId, token] of stored) {
      if (!token || !live.has(sessionId)) storage.delete(sessionId)
    }

    // Una pestaña recupera una sola sesión: la más reciente que sigue viva. Reclamar
    // todas las guardadas las resucitaba en cada reconexión, les cambiaba el owner y
    // por eso nunca cumplían el grace period: se acumulaban hasta llenar maxSessions
    // y ahí ninguna ruta de audio podía arrancar.
    //
    // Se excluyen las sesiones que esta misma carga ya creó: attachOwner les transfiere
    // el ownership a un socket nuevo y el runtime que está capturando audio deja de
    // ser owner de la suya, que es justo lo que rompe el micrófono y el archivo.
    const reclaimable = stored
      .filter(
        ([sessionId, token]) =>
          token &&
          live.has(sessionId) &&
          !claimedRef.current.has(sessionId) &&
          !localOwnerRef.current.has(sessionId),
      )
      .slice(-1)

    for (const [sessionId, ownerToken] of reclaimable) {
      claimedRef.current.add(sessionId)
      const rt = addRuntime()
      void rt.beginSession({ resume: true, reclaimSessionId: sessionId, ownerToken })
    }
  }, [sessions, addRuntime])

  const listRuntimes = useCallback(() => {
    const known = new Set()
    const out = []
    for (const runtimeId of runtimeIds) {
      const view = views[runtimeId] ?? emptyView()
      if (view.sessionId) known.add(view.sessionId)
      out.push({
        runtimeId,
        sessionId: view.sessionId,
        isOwner: view.isOwner,
        phase: view.phase,
        hasSource: view.hasSource,
        sourceKind: view.sourceKind,
        isMic: view.isMic,
        processingFile: view.processingFile,
        progress: view.progress,
        error: view.error,
      })
    }
    for (const session of sessions) {
      if (known.has(session.id)) continue
      out.push({
        runtimeId: null,
        sessionId: session.id,
        isOwner: false,
        phase: session.phase,
        hasSource: false,
        sourceKind: null,
        isMic: false,
        processingFile: false,
        progress: 0,
        error: null,
      })
    }
    return out
  }, [sessions, views, runtimeIds])

  const focusedView = focusId ? (views[focusId] ?? emptyView()) : emptyView()
  const focusedPhase =
    focusedView.connState === "offline"
      ? "offline"
      : focusedView.connState === "reconnecting" || focusedView.phase === "reconnecting"
        ? "reconnecting"
        : focusedView.phase

  return {
    sessions,
    maxSessions,
    localCap: Math.min(LOCAL_SESSION_CAP, maxSessions),
    runtimes: listRuntimes(),
    focusId,
    focus,
    createSession,
    closeSession,
    startMic,
    playFile,
    stop,
    leaveSession,
    refreshSessions,
    tuneTo: tuneToSession,
    focused: {
      phase: focusedPhase,
      connState: focusedView.connState,
      error: focusedView.error,
      segments: focusedView.segments,
      currentOriginal: focusedView.currentOriginal,
      currentTranslation: focusedView.currentTranslation,
      sourceInfo: focusedView.sourceInfo,
      processingFile: focusedView.processingFile,
      progress: focusedView.progress,
      isOwner: focusedView.isOwner,
      sessionId: focusedView.sessionId,
      hasSource: focusedView.hasSource,
      startMic: () => startMic(focusId),
      playFile: (file) => playFile(focusId, file),
      stop: () => stop(focusId),
      tuneTo: (sessionId) => tuneToSession(sessionId),
      leaveSession: () => leaveSession(focusId),
    },
  }
}
