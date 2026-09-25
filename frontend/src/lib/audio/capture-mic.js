let context = null
let stream = null

let probeCtx = null
let probeStream = null
let probeRaf = 0
let probeAnalyser = null

const MIC_CONSTRAINTS = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

// getUserMedia sólo existe en contexto seguro. Sobre http:// en una IP de la LAN
// navigator.mediaDevices viene undefined y el TypeError crudo no le dice nada al
// usuario, así que se corta acá con un motivo que friendlyMessage sabe traducir.
const requireMic = () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      window.isSecureContext ? "mic-unsupported" : "mic-insecure-context",
    )
  }
  return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
}

export async function createMicProbe(onLevel) {
  probeStream = await requireMic()

  probeCtx = new AudioContext()
  const source = probeCtx.createMediaStreamSource(probeStream)
  probeAnalyser = probeCtx.createAnalyser()
  probeAnalyser.fftSize = 256
  source.connect(probeAnalyser)

  const data = new Uint8Array(probeAnalyser.fftSize)
  const tick = () => {
    probeAnalyser.getByteTimeDomainData(data)
    let sum = 0
    for (let index = 0; index < data.length; index += 1) {
      const n = (data[index] - 128) / 128
      sum += n * n
    }
    onLevel({
      rms: Math.sqrt(sum / data.length),
      samples: Array.from(data),
    })
    probeRaf = requestAnimationFrame(tick)
  }
  probeRaf = requestAnimationFrame(tick)

  return {
    stop: async () => {
      cancelAnimationFrame(probeRaf)
      probeStream?.getTracks().forEach((track) => track.stop())
      probeStream = null
      await probeCtx?.close().catch(() => undefined)
      probeCtx = null
      probeAnalyser = null
    },
  }
}

export async function startMicCapture(onChunk) {
  // Si quedó una captura anterior viva, se cierra primero. stream y context son
  // singletons de módulo: sin esto el worklet viejo sigue procesando y mandando audio
  // en paralelo con el nuevo, o sea el doble de audio hacia la misma sesión.
  if (stream) stopMicCapture()
  stream = await requireMic()

  context = new AudioContext()
  await context.audioWorklet.addModule("/worklets/downsample.js")

  const source = context.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(context, "bridge-downsample")
  worklet.port.onmessage = (event) => onChunk(event.data)

  source.connect(worklet)
  worklet.connect(context.destination)
  worklet.port.postMessage("start")

  return worklet
}

export function stopMicCapture() {
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  context?.close().catch(() => undefined)
  context = null
}