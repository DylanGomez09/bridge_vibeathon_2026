import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "./src/config.js";
import { loadPcm16kMono } from "./src/audio/load-pcm.js";
import { Transcriber } from "./src/gemini/transcriber.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

// 100 ms de audio a 16 kHz / 16-bit / mono = 16000 * 2 * 0.1 bytes
const CHUNK_BYTES = 3200;
const CHUNK_DELAY_MS = 90;
const TIMEOUT_MS = 60_000;

const AUDIO_PATH = process.argv[2] ?? path.join(__dirname, "assets", "sample.pcm");

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

  const pcm = loadPcm16kMono(AUDIO_PATH);
  const durationSec = (pcm.length / (16000 * 2)).toFixed(2);

  console.log("[bridge] test-pipeline: EN → ES con Gemini Live API");
  console.log(`  modelo:   ${config.geminiLiveModel}`);
  console.log(`  modality: ${config.bridgeResponseModality}`);
  console.log(`  audio:    ${AUDIO_PATH} (${(pcm.length / 1024).toFixed(1)} KiB, ~${durationSec}s)`);
  console.log("");

  const result = { inputCount: 0, translation: "" };

  const transcriber = new Transcriber(new GoogleGenAI({ apiKey: config.geminiApiKey }), config, {
    onStatus: (phase, detail) => {
      console.log(`[status] ${phase}${detail ? ` — ${detail}` : ""}`);
    },
    onInputInterim: (text) => console.log(`[EN · interim] ${text}`),
    onInput: (text) => {
      result.inputCount += 1;
      console.log(`${GREEN}[EN] ${text}${RESET}`);
    },
    onTranslation: (text) => {
      result.translation = text;
      console.log(`${GREEN}[ES] ${text}${RESET}`);
    },
    onTurnComplete: () => console.log("[segment] turno completado"),
    onError: (detail) => console.error(`${RED}[error] ${detail}${RESET}`),
  });

  await transcriber.connect();

  console.log(`[bridge] Enviando audio en chunks de 100 ms (${pcm.length / CHUNK_BYTES} chunks)...`);

  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    transcriber.sendAudio(pcm.subarray(offset, offset + CHUNK_BYTES));
    if (offset + CHUNK_BYTES < pcm.length) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  transcriber.endTurn();

  console.log(`[bridge] Audio enviado. Esperando transcripción EN y traducción ES...`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (result.inputCount > 0 && result.translation.length > 0) break;
    await sleep(200);
  }

  transcriber.close();
  await sleep(300);

  const ok = result.inputCount > 0 && result.translation.length > 0;
  console.log("");
  if (ok) {
    console.log(
      `${GREEN}[bridge] OK: transcripción EN y traducción ES recibidas en streaming.${RESET}`,
    );
    process.exit(0);
  }
  if (result.inputCount > 0) {
    console.error(
      `${RED}[bridge] Fallo parcial: el EN llegó pero la traducción ES no. Revisá BRIDGE_RESPONSE_MODALITY y el system prompt.${RESET}`,
    );
  } else {
    console.error(
      `${RED}[bridge] Sin transcripción en ${TIMEOUT_MS / 1000}s. Revisá GEMINI_API_KEY, el modelo y el audio (16 kHz / 16-bit / mono).${RESET}`,
    );
  }
  process.exit(1);
}

main().catch((error: Error) => {
  console.error(`${RED}[bridge] Error fatal: ${error?.message ?? error}${RESET}`);
  process.exit(1);
});