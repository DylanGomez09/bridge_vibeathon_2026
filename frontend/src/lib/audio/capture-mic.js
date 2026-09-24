let context = null
let stream = null

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