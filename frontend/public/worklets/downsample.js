/**
 * AudioWorkletProcessor: captura el canal 0 del micrófono (48 kHz) y lo
 * reducemuestrea a 16 kHz promediando bloques, en chunks de 100 ms (1600
 * muestras Int16) que se envían al hilo principal.
 */
class BridgeDownsampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.sum = 0;
    this.count = 0;
    this.pcm = new Int16Array(1600);
    this.pcmLen = 0;
    this.enabled = true;
    this.port.onmessage = (event) => {
      if (event.data === "start") this.enabled = true;
      if (event.data === "stop") this.enabled = false;
    };
  }

  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count += 1;
      if (this.count >= this.ratio) {
        let sample = this.sum / this.count;
        if (sample > 1) sample = 1;
        if (sample < -1) sample = -1;
        this.pcm[this.pcmLen++] = (sample * 0x7fff) | 0;
        this.sum = 0;
        this.count = 0;
        if (this.pcmLen === this.pcm.length) this.flush();
      }
    }
    return true;
  }

  flush() {
    const buffer = new Int16Array(this.pcm);
    this.port.postMessage(buffer.buffer, [buffer.buffer]);
    this.pcmLen = 0;
  }
}

registerProcessor("bridge-downsample", BridgeDownsampleProcessor);