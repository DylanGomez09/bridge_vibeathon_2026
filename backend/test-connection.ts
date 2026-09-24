import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveConnectConfig } from "@google/genai";
import pkg from "wavefile";
import { loadConfig } from "./src/config.js";

const { WaveFile } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

// 100 ms de audio a 16 kHz / 16-bit / mono = 16000 * 2 * 0.1 bytes
const CHUNK_BYTES = 3200;
const CHUNK_DELAY_MS = 90;
const TIMEOUT_MS = 20_000;

const AUDIO_PATH = process.argv[2] ?? path.join(__dirname, "assets", "sample.pcm");

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

function loadPcm(filePath: string): Buffer {
  if (!fs.existsSync(filePath)) {
    console.error(`${RED}[bridge] No existe el audio: ${filePath}${RESET}`);
    console.error("  Uso: pnpm test:connection [ruta-a-audio.pcm|.wav]");
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pcm") {
    return fs.readFileSync(filePath);
  }

  if (ext === ".wav") {
    // Normaliza el WAV a PCM crudo 16 kHz / 16-bit / mono.
    const wav = new WaveFile();
    wav.fromBuffer(fs.readFileSync(filePath));
    wav.toSampleRate(16000);
    wav.toBitDepth("16");
    const fmt = wav.fmt as { numChannels?: number };
    const numChannels = fmt.numChannels ?? 1;
    const samples = wav.getSamples(true, Int16Array) as unknown as Int16Array;
    return downmixToMonoPcm(samples, numChannels);
  }

  console.error(`${RED}[bridge] Formato no soportado (usá .pcm o .wav): ${filePath}${RESET}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.geminiApiKey) {
    console.error(
      `${RED}[bridge] GEMINI_API_KEY vacía. Copiá backend/.env.example → backend/.env y pegá tu key.${RESET}`,
    );
    process.exit(1);
  }

  const pcm = loadPcm(AUDIO_PATH);
  const durationSec = (pcm.length / (16000 * 2)).toFixed(2);

  console.log("[bridge] Conectando a Gemini Live API...");
  console.log(`  modelo: ${config.geminiLiveModel}`);
  console.log(`  voz:    ${config.geminiLiveVoice}`);
  console.log(`  audio:  ${AUDIO_PATH} (${(pcm.length / 1024).toFixed(1)} KiB, ~${durationSec}s)`);

  const liveConfig: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: config.geminiLiveVoice },
      },
    },
  };

  let gotInputTranscript = false;
  let gotModelResponse = false;

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const session = await ai.live.connect({
    model: config.geminiLiveModel,
    config: liveConfig,
    callbacks: {
      onopen: () => console.log("[bridge] WebSocket abierto"),
      onmessage: (message) => {
        const content = message.serverContent;
        if (!content) return;

        if (content.interimInputTranscription?.text) {
          console.log(`[transcripción EN] ${content.interimInputTranscription.text}`);
        }
        if (content.inputTranscription?.text) {
          gotInputTranscript = true;
          console.log(`${GREEN}[transcripción EN - final] ${content.inputTranscription.text}${RESET}`);
        }
        if (content.outputTranscription?.text) {
          gotModelResponse = true;
          console.log(`${GREEN}[respuesta del modelo] ${content.outputTranscription.text}${RESET}`);
        }
        if (content.modelTurn?.parts?.length) {
          gotModelResponse = true;
          const audioBytes = content.modelTurn.parts.reduce(
            (acc, part) => acc + (part.inlineData?.data ? Math.ceil((part.inlineData.data.length * 3) / 4) : 0),
            0,
          );
          console.log(`[modelTurn] ${content.modelTurn.parts.length} part(s), ${audioBytes} bytes de audio de Gemini`);
        }
        if (content.turnComplete) {
          console.log("[bridge] turno completado");
        }
      },
      onerror: (error) => {
        console.error(`${RED}[bridge] Error de conexión: ${JSON.stringify(error)}${RESET}`);
      },
      onclose: (event) => {
        console.log(`[bridge] Sesión cerrada (código ${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      },
    },
  });

  console.log("[bridge] Session activa. Enviando audio en chunks de 100 ms...");

  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    const chunk = pcm.subarray(offset, offset + CHUNK_BYTES);
    session.sendRealtimeInput({
      audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
    if (offset + CHUNK_BYTES < pcm.length) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  session.sendRealtimeInput({ audioStreamEnd: true });

  console.log("[bridge] Audio enviado. Esperando respuesta de Gemini...");

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (gotInputTranscript && gotModelResponse) break;
    await sleep(200);
  }

  session.close();
  await sleep(300);

  if (gotInputTranscript && gotModelResponse) {
    console.log(`${GREEN}[bridge] OK: Gemini Live API recibió el audio y respondió.${RESET}`);
    process.exit(0);
  }
  if (gotInputTranscript) {
    console.log(`${GREEN}[bridge] OK parcial: transcribió el audio; la respuesta del modelo no llegó a tiempo.${RESET}`);
    process.exit(0);
  }
  console.error(
    `${RED}[bridge] Sin transcripción en ${TIMEOUT_MS / 1000}s. Revisá GEMINI_API_KEY, el modelo y el formato del audio.${RESET}`,
  );
  process.exit(1);
}

main().catch((error: Error) => {
  console.error(`${RED}[bridge] Error fatal: ${error?.message ?? error}${RESET}`);
  process.exit(1);
});