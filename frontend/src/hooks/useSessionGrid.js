import { useCallback, useEffect, useRef, useState } from "react"
import { BridgeSocket } from "../lib/ws/bridge-socket.js"
import { debug } from "../lib/debug.js"

// Tope de segmentos guardados por sesión: la tarjeta muestra los últimos y el muro
// no crece sin límite durante una charla larga.
const MAX_FEED_SEGMENTS = 40

const emptyFeed = () => ({ original: "", translation: "", segments: [], ended: false })

/**
 * Muro de sesiones: sigue TODAS las sesiones activas en paralelo, en sólo lectura.
 *
 * Diseño: un socket dedicado por sesión. El protocolo forbids que un WS esté
 * suscripto a dos sesiones a la vez, así que "ver varias a la vez" significa "un
 * socket por sesión". No hace falta tocar el backend ni el aislamiento.
 *
 * Las tarjetas nunca mandan audio: el backend ya rechaza el audio de quien no es
 * owner, así que aunque el muro tuviera un bug no podría corromper una sesión.
 *
 * `enabled` evita suscribirse mientras el muro no está a la vista: mantener N
 * sockets abiertos todo el tiempo inflaría el contador de oyentes de cada sesión.
 */
export function useSessionGrid(enabled) {
  const [sessions, setSessions] = useState([])
  const [feeds, setFeeds] = useState({})
  const [connState, setConnState] = useState("connecting")
  const dirRef = useRef(null)
  const socketsRef = useRef(new Map())
  const idsRef = useRef(new Set())

  const applySessions = useCallback((list) => {
    setSessions(list)
    idsRef.current = new Set((list ?? []).map((session) => session.id))
  }, [])

  // Socket directorio: siempre conectado, sólo trae el listado. Nunca sends audio.
  useEffect(() => {
    const dir = new BridgeSocket()
    dirRef.current = dir
    dir.on("hello", (message) => {
      setConnState("connected")
      applySessions(message.sessions ?? [])
    })
    dir.on("sessions", (message) => applySessions(message.sessions ?? []))
    dir.on("connected", () => {
      setConnState("connected")
      dir.requestSessions()
    })
    dir.on("reconnecting", () => setConnState("reconnecting"))
    dir.on("offline", () => setConnState("offline"))
    dir.on("close", () => setConnState("offline"))
    dir.connect().catch(() => setConnState("offline"))
    return () => {
      dir.close()
      dirRef.current = null
    }
  }, [applySessions])

  const openFeed = useCallback((sessionId) => {
    if (socketsRef.current.has(sessionId)) return
    const socket = new BridgeSocket()
    socketsRef.current.set(sessionId, socket)

    const patch = (update) =>
      setFeeds((prev) => ({
        ...prev,
        [sessionId]: update(prev[sessionId] ?? emptyFeed()),
      }))
    const belongs = (message) => !message.sessionId || message.sessionId === sessionId

    socket.on("original", (message) => {
      if (!belongs(message)) return
      patch((feed) => ({ ...feed, original: message.text ?? "" }))
    })
    socket.on("translation", (message) => {
      if (!belongs(message)) return
      patch((feed) => ({ ...feed, translation: message.text ?? "" }))
    })
    socket.on("segment", (message) => {
      if (!belongs(message)) return
      patch((feed) => ({
        ...feed,
        segments: [
          ...feed.segments,
          { original: feed.original, translation: feed.translation },
        ].slice(-MAX_FEED_SEGMENTS),
        original: "",
        translation: "",
      }))
    })
    socket.on("sessionEnded", (message) => {
      if (!belongs(message)) return
      patch((feed) => ({ ...feed, ended: true }))
    })
    socket.on("offline", () => setConnState("reconnecting"))
    socket.on("connected", () => {
      setConnState("connected")
      // Tras una reconexión hay que volver a suscribirse: el socket es nuevo.
      socket.subscribe(sessionId)
    })

    socket
      .connect()
      .then(() => socket.subscribe(sessionId))
      .catch(() => {
        debug(`[grid] no se pudo suscribir a ${sessionId}`)
      })
  }, [])

  // Reconciliación: abre sockets para las sesiones nuevas y los cierra para las que
  // desaparecieron. Sólo con el muro visible.
  useEffect(() => {
    if (!enabled) {
      for (const socket of socketsRef.current.values()) socket.close()
      socketsRef.current.clear()
      return
    }
    for (const id of idsRef.current) openFeed(id)
    for (const [id, socket] of socketsRef.current) {
      if (!idsRef.current.has(id)) {
        socket.close()
        socketsRef.current.delete(id)
        setFeeds((prev) => {
          if (!prev[id]) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    }
  }, [enabled, sessions, openFeed])

  return { sessions, feeds, connState }
}
