export const PCM_SAMPLE_RATE = 16000
export const CHUNK_SAMPLES = 1600 // 100 ms a 16 kHz
export const CHUNK_BYTES = CHUNK_SAMPLES * 2

export function float32ToPcmChunks(samples) {
  const chunks = []
  for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
    const sub = samples.subarray(offset, offset + CHUNK_SAMPLES)
    const int16 = new Int16Array(sub.length)
    for (let i = 0; i < sub.length; i++) {
      const s = Math.max(-1, Math.min(1, sub[i]))
      int16[i] = (s * 0x7fff) | 0
    }
    chunks.push(new Uint8Array(int16.buffer))
  }
  return chunks
}

export function pcmChunkDurationMs() {
  return (CHUNK_SAMPLES / PCM_SAMPLE_RATE) * 1000
}