import { useRef, useState } from "react"
import { BridgeSocket } from "../lib/ws/bridge-socket.js"
import { startMicCapture, stopMicCapture } from "../lib/audio/capture-mic.js"
import { decodeFileToPcm16kMono } from "../lib/audio/decode-file.js"
import { float32ToPcmChunks, pcmChunkDurationMs } from "../lib/audio/pcm.js"
import { friendlyMessage } from "../lib/errors.js"
import { debug, elapsedSec } from "../lib/debug.js"

const START_ACK_TIMEOUT_MS = 5_000
// Tope de respaldo: el backend decide ready/failed/ended por su cuenta (~52s peor caso
// con la config por defecto); este valor solo evita colgarse ante silencio total.
const READY_BACKSTOP_MS = 120_000
const FILE_PLAYBACK_RATE = 2
const TURN_CHUNKS = 100
const TURN_WAIT_MS = 20_000
const RESYNC_SETTLE_MS = 400
// El ack se vence cuando el backend se reinicia (tsx watch) justo al empezar la
// sesión. En vez de mostrar un error, reintentamos una vez con un socket nuevo.
const ACK_TIMEOUT_MESSAGE = "El servidor no respondió al iniciar la sesión"
const START_RETRY_DELAY_MS = 2_000
const START_MAX_RETRIES = 1

const isRetryableStartError = (cause) => {
  const raw = typeof cause === "string" ? cause : (cause?.message ?? "")
  return raw === ACK_TIMEOUT_MESSAGE || /no respondió al iniciar|econnrefused|econnreset/i.test(raw)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function useBridgeSession() {
  const [rawPhase, setRawPhase] = useState("idle") // idle | connecting | live | reconnecting | ended | error | failed
  const [connState, setConnState] = useState("connected") // connected | reconnecting | offline
  const [error, setError] = useState(null)
  const [segments, setSegments] = useState([])
  const [currentOriginal, setCurrentOriginal] = useState(null)
  const [currentTranslation, setCurrentTranslation] = useState("")
  const [sourceInfo, setSourceInfo] = useState(null)
  const [processingFile, setProcessingFile] = useState(false)
  const [progress, setProgress] = useState(0)

  const socketRef = useRef(null)
  const workletRef = useRef(null)
  const stoppedRef = useRef(false)
  const wantSessionRef = useRef(false)
  const droppedRef = useRef(false)
  const attachGateRef = useRef(Promise.resolve())
  const gateUnlockRef = useRef(null)
  const originalRef = useRef("")
  const translationRef = useRef("")
  const segmentIdRef = useRef(0)
  const phaseRef = useRef("idle")
  const readyResolveRef = useRef(null)
  const readyRejectRef = useRef(null)
  const readyBackstopRef = useRef(null)
  const ackResolveRef = useRef(null)
  const streamStartRef = useRef(null)
  const segmentResolveRef = useRef(null)

  const applyPhase = (next) => {
    phaseRef.current = next
    setRawPhase(next)
  }

  const settleReady = (kind, value) => {
    if (kind === "resolve") readyResolveRef.current?.()
    else readyRejectRef.current?.(value)
    readyResolveRef.current = null
    readyRejectRef.current = null
  }

  const positionMs = () => {
    if (!streamStartRef.current) return 0
    return Math.max(0, performance.now() - streamStartRef.current)
  }

  const waitTurnSegment = () =>
    new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (segmentResolveRef.current === finish) segmentResolveRef.current = null
        resolve()
      }
      const timer = setTimeout(finish, TURN_WAIT_MS)
      segmentResolveRef.current = finish
    })

  const wireSocket = (socket) => {
    socket.on("status", (message) => {
      ackResolveRef.current?.()
      if (message.phase === "error" || message.phase === "failed") {
        setError(
          message.detail
            ? friendlyMessage(message.detail, message.detail)
            : "Se perdió la conexión con la sesión.",
        )
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

    socket.on("started", () => ackResolveRef.current?.())

    socket.on("original", (message) => {
      const text = message.text ?? ""
      if (message.interim) {
        setCurrentOriginal({ text, interim: true })
      } else {
        originalRef.current = text
        setCurrentOriginal({ text, interim: false, ts: positionMs() })
      }
    })

    socket.on("translation", (message) => {
      translationRef.current = message.text ?? ""
      setCurrentTranslation(translationRef.current)
    })

    socket.on("segment", () => {
      const segment = {
        id: segmentIdRef.current++,
        ts: positionMs(),
        original: originalRef.current,
        translation: translationRef.current,
      }
      setSegments((prev) => [...prev, segment])
      originalRef.current = ""
      translationRef.current = ""
      setCurrentOriginal(null)
      setCurrentTranslation("")
      segmentResolveRef.current?.()
    })

    socket.on("close", () => {
      if (phaseRef.current !== "error" && phaseRef.current !== "failed") applyPhase("ended")
      settleReady("reject", new Error("La sesión se cerró"))
    })

    socket.on("reconnecting", () => {
      setConnState("reconnecting")
      droppedRef.current = true
      attachGateRef.current = new Promise((resolve) => {
        gateUnlockRef.current = resolve
      })
    })

    socket.on("offline", () => {
      setConnState("offline")
      if (gateUnlockRef.current) {
        gateUnlockRef.current()
        gateUnlockRef.current = null
      }
      attachGateRef.current = Promise.resolve()
    })

    socket.on("connected", () => {
      setConnState("connected")
      if (droppedRef.current && wantSessionRef.current && !stoppedRef.current) {
        droppedRef.current = false
        attachGateRef.current = resyncSession()
      } else if (gateUnlockRef.current) {
        gateUnlockRef.current()
        gateUnlockRef.current = null
        attachGateRef.current = Promise.resolve()
      }
    })
  }

  const resyncSession = () => {
    const task = (async () => {
      try {
        const socket = await getSocket()
        socket.start()
        applyPhase("connecting")
        setError(null)
        await new Promise((resolve) => setTimeout(resolve, RESYNC_SETTLE_MS))
      } catch (cause) {
        setError(friendlyMessage(cause, "No se pudo restablecer la sesión"))
      }
      if (gateUnlockRef.current) {
        gateUnlockRef.current()
        gateUnlockRef.current = null
      }
    })()
    return task
  }

  const sendChunk = async (chunk) => {
    await attachGateRef.current
    const socket = socketRef.current
    if (!socket) return false
    return socket.sendAudioChunk(chunk)
  }

  const connectSocket = async () => {
    const socket = new BridgeSocket()
    socketRef.current = socket
    wireSocket(socket)
    await socket.connect()
    return socket
  }

  const getSocket = async () => {
    const existing = socketRef.current
    if (existing && !existing.destroyed) {
      if (existing.ws?.readyState === WebSocket.OPEN) return existing
      await existing.waitOpen()
      return existing
    }
    return connectSocket()
  }

  const beginSession = async (resume = false) => {
    setError(null)
    applyPhase("connecting")
    attachGateRef.current = Promise.resolve()
    if (!resume) {
      setSegments([])
      setCurrentOriginal(null)
      setCurrentTranslation("")
      setSourceInfo(null)
      setProcessingFile(false)
      setProgress(0)
      streamStartRef.current = null
    }
    stoppedRef.current = false
    wantSessionRef.current = true
    ackResolveRef.current = null

    const attemptOnce = async () => {
      const socket = await getSocket()
      socket.start()

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ackResolveRef.current = null
          reject(new Error(ACK_TIMEOUT_MESSAGE))
        }, START_ACK_TIMEOUT_MS)
        ackResolveRef.current = () => {
          clearTimeout(timer)
          ackResolveRef.current = null
          resolve()
        }
      })

      const ready = new Promise((resolve, reject) => {
        readyResolveRef.current = resolve
        readyRejectRef.current = reject
      })
      const backstop = new Promise((_, reject) => {
        readyBackstopRef.current = setTimeout(
          reject,
          READY_BACKSTOP_MS,
          new Error("La sesión tardó demasiado en estar lista. Reconectando…"),
        )
      })
      await Promise.race([ready, backstop])
      clearTimeout(readyBackstopRef.current ?? undefined)
      readyBackstopRef.current = null
      if (!streamStartRef.current) streamStartRef.current = performance.now()
    }

    try {
      let attempt = 0
      for (;;) {
        try {
          await attemptOnce()
          break
        } catch (cause) {
          if (readyBackstopRef.current) {
            clearTimeout(readyBackstopRef.current)
            readyBackstopRef.current = null
          }
          settleReady("reject")
          ackResolveRef.current = null
          const canRetry =
            attempt < START_MAX_RETRIES && !stoppedRef.current && isRetryableStartError(cause)
          if (!canRetry) throw cause
          attempt += 1
          // El backend se reinició justo al empezar: el socket viejo quedó a medias.
          // Lo descartamos para que el reintento pegue a una conexión sana.
          socketRef.current?.close()
          socketRef.current = null
          await delay(START_RETRY_DELAY_MS)
          applyPhase("connecting")
          setError(null)
        }
      }
    } catch (cause) {
      if (readyBackstopRef.current) {
        clearTimeout(readyBackstopRef.current)
        readyBackstopRef.current = null
      }
      settleReady("reject")
      ackResolveRef.current = null
      setError(friendlyMessage(cause, "No se pudo iniciar la sesión"))
      const applied = phaseRef.current
      if (applied !== "failed" && applied !== "ended" && applied !== "error") applyPhase("error")
      throw cause
    }
  }

  const startMic = async () => {
    try {
      await beginSession()
    } catch {
      return
    }
    try {
      const worklet = await startMicCapture((chunk) => {
        socketRef.current?.sendAudioChunk(chunk).catch(() => {})
      })
      workletRef.current = worklet
      if (stoppedRef.current) {
        stopMicCapture()
      }
    } catch (cause) {
      setError(friendlyMessage(cause, "No se pudo acceder al micrófono"))
      applyPhase("error")
    }
  }

  const playFile = async (file) => {
    try {
      await beginSession()
    } catch {
      return
    }
    try {
      setProcessingFile(true)
      setProgress(0)
      const samples = await decodeFileToPcm16kMono(file)
      const durationMs = (samples.length / 16000) * 1000
      setSourceInfo({
        name: file.name,
        durationMs,
      })
      const chunks = float32ToPcmChunks(samples)
      const total = chunks.length
      debug(
        `[file] ${file.name} · dur ${Math.round(durationMs / 1000)}s · ${total} chunks × ${chunks[0]?.byteLength ?? 0} bytes`,
      )
      const step = pcmChunkDurationMs() / FILE_PLAYBACK_RATE
      streamStartRef.current = performance.now()
      let turn = 0
      for (let index = 0; index < chunks.length; index++) {
        if (stoppedRef.current) break
        const start = performance.now()
        const sent = await sendChunk(chunks[index])
        if (!sent) {
          setError("No se pudo restablecer la sesión: quedó sin conexión con el servidor.")
          applyPhase("ended")
          break
        }
        setProgress((index + 1) / total)
        const wait = Math.max(0, step - (performance.now() - start))
        if (index < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
        if ((index + 1) % TURN_CHUNKS === 0 && index < chunks.length - 1) {
          turn += 1
          socketRef.current?.endTurn()
          debug(`[file] turno ${turn} — esperando segmento (${elapsedSec(streamStartRef.current)})`)
          await waitTurnSegment()
          debug(
            `[file] segmento del turno ${turn} recibido (${elapsedSec(streamStartRef.current)})`,
          )
        }
      }
      if (!stoppedRef.current) {
        socketRef.current?.endTurn()
        debug(`[file] turno final — esperando segmento (${elapsedSec(streamStartRef.current)})`)
        await waitTurnSegment()
        debug(`[file] segmento final recibido (${elapsedSec(streamStartRef.current)})`)
        setProgress(1)
      }
      setProcessingFile(false)
    } catch (cause) {
      setProcessingFile(false)
      setError(friendlyMessage(cause, "No se pudo procesar el archivo"))
      applyPhase("error")
    }
    wantSessionRef.current = false
  }

  const stop = () => {
    stoppedRef.current = true
    wantSessionRef.current = false
    droppedRef.current = false
    stopMicCapture()
    const socket = socketRef.current
    segmentResolveRef.current?.()
    segmentResolveRef.current = null
    ackResolveRef.current = null
    if (readyBackstopRef.current) {
      clearTimeout(readyBackstopRef.current)
      readyBackstopRef.current = null
    }
    settleReady("reject", new Error("Sesión detenida"))
    socket?.endTurn()
    socket?.stop()
    socket?.close()
    socketRef.current = null
    if (gateUnlockRef.current) {
      gateUnlockRef.current()
      gateUnlockRef.current = null
    }
    attachGateRef.current = Promise.resolve()
    workletRef.current = null
    setProcessingFile(false)
    setProgress(0)
    streamStartRef.current = null
    setCurrentOriginal(null)
    setCurrentTranslation("")
    applyPhase("ended")
  }

  const phase =
    connState === "offline"
      ? "offline"
      : connState === "reconnecting" || rawPhase === "reconnecting"
        ? "reconnecting"
        : rawPhase

  return {
    phase,
    connState,
    error,
    segments,
    currentOriginal,
    currentTranslation,
    sourceInfo,
    processingFile,
    progress,
    startMic,
    playFile,
    stop,
  }
}