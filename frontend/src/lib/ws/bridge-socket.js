import { debug, elapsedSec } from "../debug.js"

const DEFAULT_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/ws"

export class BridgeSocket {
  ws = null
  handlers = new Map()
  t0 = null
  sentChunks = 0
  sentBytes = 0
  lastTickAt = 0

  connect() {
    return new Promise((resolve, reject) => {
      this.t0 = performance.now()
      const ws = new WebSocket(DEFAULT_URL)
      this.ws = ws
      ws.onopen = () => {
        debug(`[ws] conectado a ${DEFAULT_URL} (T1+: ${elapsedSec(this.t0)})`)
        resolve()
      }
      ws.onerror = () => {
        debug(`[ws] error de conexión a ${DEFAULT_URL}`)
        reject(new Error(`No se pudo conectar a ${DEFAULT_URL}`))
      }
      ws.onclose = (event) => {
        debug(`[ws] close (code ${event.code}${event.reason ? ` ${event.reason}` : ""})`)
        this.emit("close", event)
      }
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return
        try {
          const message = JSON.parse(event.data)
          debug(`[ws] <- ${message.type}${message.phase ? `/${message.phase}` : ""}${message.text ? ` ${message.text.slice(0, 120)}` : ""} (T5: ${elapsedSec(this.t0)})`)
          this.emit(message)
        } catch {
          // mensaje no JSON: se ignora
        }
      }
    })
  }

  on(type, handler) {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  emit(message) {
    const list = this.handlers.get(message.type) ?? []
    list.forEach((handler) => handler(message))
  }

  tickChunkTick() {
    const now = performance.now()
    if (now - this.lastTickAt >= 10_000) {
      this.lastTickAt = now
      debug(`[ws] bin subidos: ${this.sentChunks} chunks / ${this.sentBytes} bytes (${elapsedSec(this.t0)})`)
    }
  }

  start() {
    debug(`[ws] -> start (${elapsedSec(this.t0)})`)
    this.ws?.send(JSON.stringify({ type: "start" }))
  }

  sendAudioChunk(chunk) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const chunkIndex = this.sentChunks + 1
      this.sentChunks += 1
      this.sentBytes += chunk.byteLength
      if (chunkIndex === 1) {
        debug(`[ws] -> primer chunk binario (chunk 1, ${chunk.byteLength} bytes) (T1: ${elapsedSec(this.t0)})`)
      }
      this.tickChunkTick()
      this.ws.send(chunk)
    }
  }

  endTurn() {
    debug(`[ws] -> end (${elapsedSec(this.t0)})`)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "end" }))
    }
  }

  stop() {
    debug(`[ws] -> stop (${elapsedSec(this.t0)})`)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }))
    }
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}