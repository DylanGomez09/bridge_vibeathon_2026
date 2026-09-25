import { useEffect, useRef, useState } from "react"
import { createMicProbe } from "../../lib/audio/capture-mic.js"
import { friendlyMessage } from "../../lib/errors.js"
import { MicIcon } from "../icons.jsx"

const LISTENING_RMS = 0.02
const WAVE_BARS = 60
const SMOOTHING = 0.2

function smoothLevels(state) {
  const { levels } = state
  state.rms = Math.max(...levels) * (state.signal ? 1 : 0.75)
  state.alpha += state.signal ? (1 - state.alpha) * 0.4 : (0.12 - state.alpha) * 0.08
}

function paintWave(canvas, samples, color, stateRef) {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  canvas.width = width * dpr
  canvas.height = height * dpr

  const context = canvas.getContext("2d")
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)

  const mid = height / 2
  const bin = Math.floor(samples.length / WAVE_BARS)
  const state = stateRef.current ?? (stateRef.current = { levels: new Array(WAVE_BARS).fill(0), alpha: 0.14, signal: false })

  const peak = { value: 0 }
  const targets = new Array(WAVE_BARS)
  for (let bar = 0; bar < WAVE_BARS; bar += 1) {
    let sum = 0
    for (let index = 0; index < bin; index += 1) {
      const value = (samples[bar * bin + index] - 128) / 128
      sum += Math.abs(value)
    }
    const target = Math.min(1, sum / bin)
    targets[bar] = target
    if (target > peak.value) peak.value = target
  }

  state.signal = peak.value >= LISTENING_RMS
  const maxH = Math.max(4, height / 2 - 12)
  const barWidth = Math.max(2.5, Math.min(6, width / WAVE_BARS - 1.5))

  context.globalAlpha = 0.2
  context.strokeStyle = color
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(0, mid + 0.5)
  context.lineTo(width, mid + 0.5)
  context.stroke()

  context.strokeStyle = color
  context.lineWidth = barWidth
  context.lineCap = "round"
  context.globalAlpha = state.alpha

  for (let bar = 0; bar < WAVE_BARS; bar += 1) {
    const level = state.levels[bar] + (targets[bar] - state.levels[bar]) * SMOOTHING
    state.levels[bar] = level
    const h = Math.max(3, level * maxH)
    const x = (bar + 0.5) * (width / WAVE_BARS)
    context.beginPath()
    context.moveTo(x, mid - h)
    context.lineTo(x, mid + h)
    context.stroke()
  }

  smoothLevels(state)
}

export default function Microphone() {
  const [active, setActive] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const canvasRef = useRef(null)
  const probeRef = useRef(null)
  const listeningRef = useRef(false)
  const colorRef = useRef(null)
  const waveStateRef = useRef(null)

  const liveColor = () => {
    if (!colorRef.current) {
      colorRef.current = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-live")
        .trim()
    }
    return colorRef.current
  }

  const applyListening = (next) => {
    if (listeningRef.current === next) return
    listeningRef.current = next
    setListening(next)
  }

  const toggle = async () => {
    if (active) {
      await probeRef.current?.stop()
      probeRef.current = null
      setActive(false)
      applyListening(false)
      return
    }
    setError(null)
    try {
      const probe = await createMicProbe(({ rms, samples }) => {
        paintWave(canvasRef.current, samples, liveColor(), waveStateRef)
        applyListening(rms >= LISTENING_RMS)
      })
      probeRef.current = probe
      setActive(true)
    } catch (cause) {
      setError(friendlyMessage(cause, "No se pudo acceder al micrófono"))
    }
  }

  useEffect(() => {
    return () => {
      probeRef.current?.stop()
      probeRef.current = null
    }
  }, [])

  return (
    <div className="content">
      <div className="mic-panel">
        <article className="card waveform-card">
          <h3>
            <MicIcon size={18} /> Prueba de micrófono
          </h3>
          <canvas
            ref={canvasRef}
            className="waveform-canvas"
            aria-label="Waveform del micrófono en vivo"
          />
          <p className={`mic-status ${listening ? "listening" : "idle"}`}>
            <span className="dot" />
            {listening ? "Escuchando" : "Inactivo"}
          </p>
          <div>
            <button type="button" className="btn btn-brand" onClick={toggle}>
              {active ? "Detener prueba" : "Probar micrófono"}
            </button>
          </div>
          {error ? (
            <p className="error-banner" role="alert">
              {error}
            </p>
          ) : null}
        </article>

        <article className="card">
          <h3>Nota</h3>
          <p className="stat-label">
            Esta es una prueba de dispositivo: solo mide el nivel de audio y dibuja
            la onda. Para transcribir y traducir de verdad, andá al panel
            Traducción y usá el micrófono o un archivo desde ahí.
          </p>
        </article>
      </div>
    </div>
  )
}