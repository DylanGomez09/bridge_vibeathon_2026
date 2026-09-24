let decodeContext = null

function getDecodeContext() {
  if (!decodeContext) {
    decodeContext = new AudioContext()
  }
  return decodeContext
}

export async function decodeFileToPcm16kMono(file) {
  const arrayBuffer = await file.arrayBuffer()
  const audioBuffer = await getDecodeContext().decodeAudioData(arrayBuffer)

  const seconds = audioBuffer.duration
  const offline = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.ceil(seconds * 16000),
    sampleRate: 16000,
  })

  const source = offline.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offline.destination)
  source.start()

  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

export function closeDecodeContext() {
  decodeContext?.close().catch(() => undefined)
  decodeContext = null
}