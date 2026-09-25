import { useRef, useState } from "react"
import { BridgeSocket } from "../lib/ws/bridge-socket.js"
import { startMicCapture, stopMicCapture } from "../lib/audio/capture-mic.js"
import { decodeFileToPcm16kMono } from "../lib/audio/decode-file.js"
import { float32ToPcmChunks, pcmChunkDurationMs } from "../lib/audio/pcm.js"
import { debug, elapsedSec } from "../lib/debug.js"

const READY_TIMEOUT_MS = 15_000
const FILE_PLAYBACK_RATE = 2
const TURN_CHUNKS = 100
const TURN_WAIT_MS = 20_000

export function useBridgeSession() {
  const [phase, setPhase] = useState("idle") // idle | connecting | live | ended | error
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
  const originalRef = useRef("")
  const translationRef = useRef("")
  const segmentIdRef = useRef(0)
  const phaseRef = useRef("idle")
  const readyResolveRef = useRef(null)
  const readyRejectRef = useRef(null)
  const streamStartRef = useRef(null)
  const segmentResolveRef = useRef(null)

  const applyPhase = (next) => {
    phaseRef.current = next
    setPhase(next)
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
      if (message.phase === "error") {
        setError(message.detail)
        applyPhase("error")
        settleReady("reject", new Error(message.detail ?? "Error de sesión"))
        return
      }
      if (message.phase === "ready") {
        applyPhase("live")
        settleReady("resolve")
      }
      if (message.phase === "connecting") applyPhase("connecting")
      if (message.phase === "ended") applyPhase("ended")
    })
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
      if (phaseRef.current !== "error") applyPhase("ended")
      settleReady("reject", new Error("La sesiÃ³n se cerrÃ³"))
    })
  }

  const connectSocket = async () => {
    const socket = new BridgeSocket()
    socketRef.current = socket
    wireSocket(socket)
    await socket.connect()
    return socket
  }

  const getSocket = async () => {
    if (socketRef.current?.ws?.readyState === WebSocket.OPEN) {
      return socketRef.current
    }
    return connectSocket()
  }

  const beginSession = async () => {
    setError(null)
    applyPhase("connecting")
    setSegments([])
    setCurrentOriginal(null)
    setCurrentTranslation("")
    setSourceInfo(null)
    setProcessingFile(false)
    setProgress(0)
    streamStartRef.current = null
    stoppedRef.current = false

    const ready = new Promise((resolve, reject) => {
      readyResolveRef.current = resolve
      readyRejectRef.current = reject
    })
    const timeout = new Promise((_, reject) =>
      setTimeout(reject, READY_TIMEOUT_MS, new Error("La sesiÃ³n tardÃ³ demasiado en estar lista")),
    )

    try {
      const socket = await getSocket()
      socket.start()
      await Promise.race([ready, timeout])
      if (!streamStartRef.current) streamStartRef.current = performance.now()
    } catch (cause) {
      settleReady("reject")
      setError(cause instanceof Error ? cause.message : String(cause))
      applyPhase("error")
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
      const worklet = await startMicCapture((chunk) => socketRef.current?.sendAudioChunk(chunk))
      workletRef.current = worklet
      if (stoppedRef.current) {
        stopMicCapture()
      }
    } catch (cause) {
      setError(cause?.message ?? "No se pudo acceder al micrÃ³fono")
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
        socketRef.current?.sendAudioChunk(chunks[index])
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
      setError(cause?.message ?? "No se pudo decodificar el archivo")
      applyPhase("error")
    }
  }

  const stop = () => {
    stoppedRef.current = true
    stopMicCapture()
    const socket = socketRef.current
    segmentResolveRef.current?.()
    segmentResolveRef.current = null
    socket?.endTurn()
    socket?.stop()
    socket?.close()
    socketRef.current = null
    workletRef.current = null
    setProcessingFile(false)
    setProgress(0)
    streamStartRef.current = null
    setCurrentOriginal(null)
    setCurrentTranslation("")
    applyPhase("ended")
  }

  return {
    phase,
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
