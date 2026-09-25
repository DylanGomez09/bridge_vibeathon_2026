import { WebSocket } from "ws"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(`C:/Users/gomez/Desktop/bridge_vibeathon_2026/backend/package.json`)
const { WaveFile } = require("wavefile")

const WS_URL = "ws://localhost:3001/ws"
const WAV = "C:/Users/gomez/Desktop/bridge_vibeathon_2026/backend/assets/short-talk.wav"
const CHUNK_BYTES = 3200
const CHUNK_STEP_MS = 50
const TURN_CHUNKS = 100

const t0 = Date.now()
const t = () => `[T+${Date.now() - t0}ms]`

function loadWavPcm16kMono(filePath) {
  const wav = new WaveFile(fs.readFileSync(path.resolve(filePath)))
  wav.toSampleRate(16000)
  wav.toBitDepth("16")
  const fmt = wav.fmt ?? {}
  const numChannels = fmt.numChannels ?? 1
  const samples = wav.getSamples(true, Int16Array)
  if (numChannels > 1) {
    const mono = new Int16Array(samples.length / numChannels)
    for (let i = 0; i < mono.length; i++) {
      let sum = 0
      for (let ch = 0; ch < numChannels; ch++) sum += samples[i * numChannels + ch]
      mono[i] = sum / numChannels
    }
    return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength)
  }
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
}

const pcm = loadWavPcm16kMono(WAV)
const chunks = []
for (let i = 0; i < pcm.length; i += CHUNK_BYTES) chunks.push(pcm.subarray(i, i + CHUNK_BYTES))
console.log(`${t()} chunks: ${chunks.length}`)

const ws = new WebSocket(WS_URL)
let readyAt = 0
let sentInTurn = 0
let turn = 0
let dumpedStart = false

function dump(msg) {
  const phase = msg.phase ? `/${msg.phase}` : ""
  const detail = msg.detail ? ` detail=${JSON.stringify(msg.detail).slice(0, 240)}` : ""
  const text = msg.text ? ` text="${String(msg.text).slice(0, 90)}"` : ""
  console.log(`${t()} <- ${msg.type}${phase}${msg.interim ? " (INTERIM)" : ""}${text}${detail}`)
}

ws.on("open", () => {
  console.log(`${t()} OPEN -> start`)
  ws.send(JSON.stringify({ type: "start" }))
})

ws.on("message", (data, isBinary) => {
  if (isBinary) return
  let msg
  try { msg = JSON.parse(data.toString()) } catch { return }
  dump(msg)
  if (msg.type === "status" && msg.phase === "ready" && !readyAt) {
    readyAt = Date.now()
    console.log(`${t()} READY -> enviando audio...`)
    pump()
  }
  if (msg.type === "status" && ["failed", "ended", "error"].includes(msg.phase)) {
    console.log(`${t()} TERMINAL ${msg.phase}: ${JSON.stringify(msg)}`)
    setTimeout(() => process.exit(0), 400)
  }
})

async function pump() {
  let last = 0
  for (let i = 0; i < chunks.length; i++) {
    const now = Date.now()
    const wait = last ? Math.max(0, CHUNK_STEP_MS - (now - last)) : 0
    if (wait) await new Promise((r) => setTimeout(r, wait))
    last = Date.now()
    ws.send(chunks[i])
    sentInTurn++
    if ((i + 1) % TURN_CHUNKS === 0 && i < chunks.length - 1) {
      turn++
      ws.send(JSON.stringify({ type: "end" }))
      console.log(`${t()} endTurn #${turn} (chunks ${sentInTurn})`)
    }
  }
  ws.send(JSON.stringify({ type: "end" }))
  console.log(`${t()} endTurn final (chunks ${sentInTurn})`)
}

ws.on("error", (e) => console.error(`${t()} ERROR ${e.message}`))
ws.on("close", (code, reason) => { console.log(`${t()} CLOSE ${code} ${reason}`); process.exit(0) })

setTimeout(() => { console.log(`${t()} GLOBAL TIMEOUT`); process.exit(1) }, 75000)
