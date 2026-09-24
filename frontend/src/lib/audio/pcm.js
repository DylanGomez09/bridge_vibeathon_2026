export const PCM_SAMPLE_RATE = 16000
export const CHUNK_SAMPLES = 1600 // 100 ms a 16 kHz
export const CHUNK_BYTES = CHUNK_SAMPLES * 2

export function float32ToPcmChunks(samples) {
  const chunks = []
  for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
    const bytes = new Int16Array(samples.subarray(offset, offset + CHUNK_SAMPLES))
    chunks.push(new Uint8Array(bytes.buffer))
  }
  return chunks
}

export function pcmChunkDurationMs() {
  return (CHUNK_SAMPLES / PCM_SAMPLE_RATE) * 1000
}