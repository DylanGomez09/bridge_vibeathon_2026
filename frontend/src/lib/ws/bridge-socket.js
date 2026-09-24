const DEFAULT_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/ws"

export class BridgeSocket {
  ws = null
  handlers = new Map()

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(DEFAULT_URL)
      this.ws = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error(`No se pudo conectar a ${DEFAULT_URL}`))
      ws.onclose = (event) => this.emit("close", event)
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return
        try {
          this.emit(JSON.parse(event.data))
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

  start() {
    this.ws?.send(JSON.stringify({ type: "start" }))
  }

  sendAudioChunk(chunk) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  endTurn() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "end" }))
    }
  }

  stop() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }))
    }
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}