import fs from "node:fs";
import path from "node:path";
import pkg from "wavefile";

const { WaveFile } = pkg;

function downmixToMonoPcm(samples: Int16Array, numChannels: number): Buffer {
  if (numChannels === 1) {
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  }
  const mono = new Int16Array(samples.length / numChannels);
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += samples[i * numChannels + ch];
    }
    mono[i] = sum / numChannels;
  }
  return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength);
}

export function loadPcm16kMono(filePath: string): Buffer {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No existe el audio: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pcm") {
    return fs.readFileSync(filePath);
  }

  if (ext === ".wav") {
    const wav = new WaveFile();
    wav.fromBuffer(fs.readFileSync(filePath));
    wav.toSampleRate(16000);
    wav.toBitDepth("16");
    const fmt = wav.fmt as { numChannels?: number };
    const numChannels = fmt.numChannels ?? 1;
    const samples = wav.getSamples(true, Int16Array) as unknown as Int16Array;
    return downmixToMonoPcm(samples, numChannels);
  }

  throw new Error(`Formato no soportado (usá .pcm o .wav): ${filePath}`);
}