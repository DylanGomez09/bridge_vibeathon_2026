import { debug, elapsedSec } from "../debug.js"

const DEFAULT_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/ws"

const BACKOFF_DELAYS = [800, 1600, 3200]
const LONG_RETRY_MS = 5000
const CONNECT_TIMEOUT_MS = 20000

export class BridgeSocket {
  ws = null
  handlers = new Map()
  t0 = 0
  sentChunks = 0
  sentBytes = 0
  lastTickAt = 0
  manuallyClosed = false
  destroyed = false
  connectResolve = null
  connectReject = null
  connectTimer = null
  retryTimer = null
  reconnectAttempts = 0
  openWaiters = []

  connect() {
    return new Promise((resolve, reject) => {
      this.t0 = performance.now()
      this.connectResolve = resolve
      this.connectReject = reject
      this.connectTimer = setTimeout(() => {
        if (this.connectReject) {
          const rejectConnect = this.connectReject
          this.connectReject = null
          this.connectResolve = null
          rejectConnect(new Error(`No se pudo conectar a ${DEFAULT_URL}`))
        }
      }, CONNECT_TIMEOUT_MS)
      this.openSocket()
    })
  }

  on(type, handler) {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  emit(type, payload = {}) {
    const list = this.handlers.get(type) ?? []
    list.forEach((handler) => handler(payload))
  }

  openSocket() {
    if (this.destroyed) return
    this.closeCurrentSocket()

    const ws = new WebSocket(DEFAULT_URL)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.reconnectAttempts = 0
      debug(`[ws] conectado a ${DEFAULT_URL} (T1+: ${elapsedSec(this.t0)})`)
      if (this.connectTimer) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      if (this.connectResolve) {
        const resolve = this.connectResolve
        this.connectResolve = null
        this.connectReject = null
        resolve()
      }
      this.settleOpenWaiters()
      this.emit("connected")
    }

    ws.onerror = () => {
      debug(`[ws] error de conexión a ${DEFAULT_URL}`)
      // El cierre (onclose) siguiente dispara el reintento.
    }

    ws.onclose = (event) => {
      debug(`[ws] close (code ${event.code}${event.reason ? ` ${event.reason}` : ""})`)
      if (this.ws !== ws) return
      this.ws = null
      if (this.manuallyClosed || this.destroyed) {
        this.settleOpenWaiters()
        this.emit("close", event)
        return
      }
      if (this.connectReject) {
        const reject = this.connectReject
        this.connectReject = null
        this.connectResolve = null
        reject(new Error(`No se pudo conectar a ${DEFAULT_URL}`))
      }
      this.emit("reconnecting")
      this.scheduleReconnect()
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      if (typeof event.data !== "string") return
      try {
        const message = JSON.parse(event.data)
        debug(
          `[ws] <- ${message.type}${message.phase ? `/${message.phase}` : ""}${message.text ? ` ${message.text.slice(0, 120)}` : ""} (T5: ${elapsedSec(this.t0)})`,
        )
        this.emit(message.type, message)
      } catch {
        // mensaje no JSON: se ignora
      }
    }
  }

  scheduleReconnect() {
    if (this.destroyed || this.retryTimer) return
    let delay
    if (this.reconnectAttempts < BACKOFF_DELAYS.length) {
      delay = BACKOFF_DELAYS[this.reconnectAttempts]
    } else {
      delay = LONG_RETRY_MS
      this.emit("offline", {})
    }
    this.reconnectAttempts += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.destroyed) this.openSocket()
    }, delay)
  }

  waitOpen() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.destroyed || this.manuallyClosed) return Promise.resolve()
    return new Promise((resolve) => this.openWaiters.push(resolve))
  }

  settleOpenWaiters() {
    const list = this.openWaiters
    this.openWaiters = []
    list.forEach((resolve) => resolve())
  }

  closeCurrentSocket() {
    const ws = this.ws
    this.ws = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close()
      } catch {
        // socket ya cerrado
      }
    }
  }

  sendCommand(payload) {
    if (this.destroyed || this.manuallyClosed) return false
    const send = () => {
      if (this.ws?.readyState !== WebSocket.OPEN) return false
      this.ws.send(JSON.stringify(payload))
      return true
    }
    if (send()) return true
    // Si el socket se está reconectando, el comando se pierde. Lo reenviamos apenas
    // vuelva a estar abierto en vez de descartarlo.
    return this.waitOpen().then(() => {
      if (this.destroyed || this.manuallyClosed) return false
      return send()
    })
  }

  start(options = {}) {
    debug(`[ws] -> start (${elapsedSec(this.t0)})`)
    return this.sendCommand({ type: "start", ...options })
  }

  subscribe(sessionId) {
    debug(`[ws] -> subscribe ${sessionId}`)
    return this.sendCommand({ type: "subscribe", sessionId })
  }

  unsubscribe(sessionId) {
    if (!sessionId) return false
    debug(`[ws] -> unsubscribe ${sessionId}`)
    return this.sendCommand({ type: "unsubscribe", sessionId })
  }

  requestSessions() {
    return this.sendCommand({ type: "sessions" })
  }

  async sendAudioChunk(chunk) {
    if (this.destroyed || this.manuallyClosed) return false
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.trackChunk(chunk)
      this.ws.send(chunk)
      return true
    }
    await this.waitOpen()
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.trackChunk(chunk)
      this.ws.send(chunk)
      return true
    }
    return false
  }

  trackChunk(chunk) {
    this.sentChunks += 1
    this.sentBytes += chunk.byteLength
    if (this.sentChunks === 1) {
      debug(
        `[ws] -> primer chunk binario (chunk 1, ${chunk.byteLength} bytes) (T1: ${elapsedSec(this.t0)})`,
      )
    }
    const now = performance.now()
    if (now - this.lastTickAt >= 10_000) {
      this.lastTickAt = now
      debug(
        `[ws] bin subidos: ${this.sentChunks} chunks / ${this.sentBytes} bytes (${elapsedSec(this.t0)})`,
      )
    }
  }

  endTurn() {
    debug(`[ws] -> end (${elapsedSec(this.t0)})`)
    return this.sendCommand({ type: "end" })
  }

  stop(sessionId) {
    debug(`[ws] -> stop${sessionId ? ` ${sessionId}` : ""} (${elapsedSec(this.t0)})`)
    return this.sendCommand(sessionId ? { type: "stop", sessionId } : { type: "stop" })
  }

  close() {
    this.manuallyClosed = true
    this.destroyed = true
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.settleOpenWaiters()
    this.closeCurrentSocket()
  }
}