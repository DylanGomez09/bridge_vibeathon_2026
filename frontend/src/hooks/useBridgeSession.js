import { useRef, useState } from "react"
import { BridgeSocket } from "../lib/ws/bridge-socket.js"
import { startMicCapture, stopMicCapture } from "../lib/audio/capture-mic.js"
import { decodeFileToPcm16kMono } from "../lib/audio/decode-file.js"
import { float32ToPcmChunks, pcmChunkDurationMs } from "../lib/audio/pcm.js"

export function useBridgeSession() {
  const [phase, setPhase] = useState("idle") // idle | connecting | live | ended | error
  const [error, setError] = useState(null)
  const [source, setSource] = useState(null) // mic | file | null
  const [segments, setSegments] = useState([])
  const [currentOriginal, setCurrentOriginal] = useState(null)
  const [currentTranslation, setCurrentTranslation] = useState("")
  const [sourceInfo, setSourceInfo] = useState(null)

  const socketRef = useRef(null)
  const workletRef = useRef(null)
  const hookedRef = useRef(false)
  const stoppedRef = useRef(false)
  const originalRef = useRef("")
  const translationRef = useRef("")
  const segmentIdRef = useRef(0)
  const phaseRef = useRef("idle")

  const applyPhase = (next) => {
    phaseRef.current = next
    setPhase(next)
  }

  const ensureSocket = async () => {
    if (socketRef.current) return socketRef.current
    const socket = new BridgeSocket()
    socketRef.current = socket

    if (!hookedRef.current) {
      hookedRef.current = true
      socket.on("status", (message) => {
        if (message.phase === "error") {
          setError(message.detail)
          applyPhase("error")
          return
        }
        if (message.phase === "ready") applyPhase("live")
        if (message.phase === "connecting") applyPhase("connecting")
        if (message.phase === "ended") applyPhase("ended")
      })
      socket.on("original", (message) => {
        const text = message.text ?? ""
        if (message.interim) {
          setCurrentOriginal({ text, interim: true })
        } else {
          originalRef.current = text
          setCurrentOriginal({ text, interim: false })
        }
      })
      socket.on("translation", (message) => {
        translationRef.current = message.text ?? ""
        setCurrentTranslation(translationRef.current)
      })
      socket.on("segment", () => {
        const segment = {
          id: segmentIdRef.current++,
          ts: Date.now(),
          original: originalRef.current,
          translation: translationRef.current,
        }
        setSegments((prev) => [...prev, segment])
        originalRef.current = ""
        translationRef.current = ""
        setCurrentOriginal(null)
        setCurrentTranslation("")
      })
      socket.on("close", () => {
        if (phaseRef.current !== "error") applyPhase("ended")
      })
    }

    if (socket.ws?.readyState === WebSocket.OPEN) {
      return socket
    }
    await socket.connect()
    return socket
  }

  const beginSession = async (nextSource) => {
    setError(null)
    applyPhase("connecting")
    setSource(nextSource)
    setSegments([])
    setSourceInfo(null)
    stoppedRef.current = false
    try {
      const socket = await ensureSocket()
      socket.start()
    } catch (cause) {
      setError(cause.message)
      applyPhase("error")
    }
  }

  const startMic = async () => {
    await beginSession("mic")
    if (phaseRef.current !== "connecting") return
    try {
      const worklet = await startMicCapture((chunk) => socketRef.current?.sendAudioChunk(chunk))
      workletRef.current = worklet
    } catch (cause) {
      setError(cause.message ?? "No se pudo acceder al micrófono")
      applyPhase("error")
    }
  }

  const playFile = async (file) => {
    await beginSession("file")
    if (phaseRef.current !== "connecting") return
    try {
      const samples = await decodeFileToPcm16kMono(file)
      const durationSamples = samples.length
      setSourceInfo({ name: file.name, durationMs: (durationSamples / 16000) * 1000 })
      const chunks = float32ToPcmChunks(samples)
      const step = pcmChunkDurationMs()
      for (const chunk of chunks) {
        if (stoppedRef.current) break
        socketRef.current?.sendAudioChunk(chunk)
        const start = performance.now()
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, step - (performance.now() - start))),
        )
      }
      if (!stoppedRef.current) {
        socketRef.current?.endTurn()
      }
    } catch (cause) {
      setError(cause.message ?? "No se pudo decodificar el archivo")
      applyPhase("error")
    }
  }

  const stop = () => {
    stoppedRef.current = true
    stopMicCapture()
    const socket = socketRef.current
    socket?.endTurn()
    socket?.stop()
    socket?.close()
    socketRef.current = null
    workletRef.current = null
    setCurrentOriginal(null)
    setCurrentTranslation("")
    applyPhase("ended")
  }

  return {
    phase,
    error,
    source,
    sourceInfo,
    segments,
    currentOriginal,
    currentTranslation,
    startMic,
    playFile,
    stop,
  }
}