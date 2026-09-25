let context = null
let stream = null

let probeCtx = null
let probeStream = null
let probeRaf = 0
let probeAnalyser = null

export async function createMicProbe(onLevel) {
  probeStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

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
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

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