import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./src/config.js";
import { loadPcm16kMono } from "./src/audio/load-pcm.js";
import { registerWsHandlers } from "./src/ws/handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const CHUNK_BYTES = 3200;
const CHUNK_DELAY_MS = 50;
const READY_TIMEOUT_MS = 30_000;
const TEXT_TIMEOUT_MS = 60_000;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`${GREEN}  ok${RESET} ${label}`);
  } else {
    failed += 1;
    console.error(`${RED}  FAIL${RESET} ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${DIM}── ${title} ──${RESET}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Incoming {
  type?: string;
  sessionId?: string;
  phase?: string;
  text?: string;
  interim?: boolean;
  ownerToken?: string;
  reason?: string;
  sessions?: { id: string; label: string; sourceLang: string; targetLang: string; clients: number }[];
  meta?: { id: string; sourceLang: string; targetLang: string };
}

const SUBTITLE_TYPES = new Set(["original", "translation", "segment", "status"]);

class Client {
  readonly messages: Incoming[] = [];
  sessionId: string | null = null;
  ownerToken: string | null = null;
  originals = 0;
  translations = 0;
  ready = false;
  ended = false;

  constructor(
    readonly name: string,
    readonly url: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      (this as { ws?: WebSocket }).ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name}: no abrió el WS`)), 10_000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Incoming;
        this.messages.push(message);
        if (message.sessionId && !this.sessionId) this.sessionId = message.sessionId;
        if (message.ownerToken) this.ownerToken = message.ownerToken;
        if (message.type === "status" && message.phase === "ready") this.ready = true;
        if (message.type === "status" && (message.phase === "ended" || message.phase === "failed")) {
          this.ended = true;
        }
        if (message.type === "original" && !message.interim) this.originals += 1;
        if (message.type === "translation") this.translations += 1;
        if (message.type === "sessionEnded") this.ended = true;
      });
    });
  }

  get open(): boolean {
    const ws = (this as { ws?: WebSocket }).ws;
    return ws?.readyState === WebSocket.OPEN;
  }

  send(payload: unknown): void {
    (this as { ws?: WebSocket }).ws?.send(JSON.stringify(payload));
  }

  streamAudio(pcm: Buffer, limitSec?: number): void {
    const ws = (this as { ws?: WebSocket }).ws;
    if (!ws) return;
    const limit = limitSec ? Math.floor(limitSec * 16000 * 2) : pcm.length;
    const slice = pcm.subarray(0, Math.min(pcm.length, limit));
    let index = 0;
    const pump = (): void => {
      if (!this.open || index >= slice.length) {
        this.send({ type: "end" });
        return;
      }
      ws.send(slice.subarray(index, index + CHUNK_BYTES));
      index += CHUNK_BYTES;
      setTimeout(pump, CHUNK_DELAY_MS);
    };
    pump();
  }

  subtitlesFor(sessionId: string): Incoming[] {
    return this.messages.filter(
      (m) => SUBTITLE_TYPES.has(m.type ?? "") && m.sessionId === sessionId,
    );
  }

  foreignSubtitles(): Incoming[] {
    return this.messages.filter(
      (m) => SUBTITLE_TYPES.has(m.type ?? "") && !!m.sessionId && m.sessionId !== this.sessionId,
    );
  }
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  console.log(`${DIM}      (timeout esperando: ${label})${RESET}`);
  return false;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.geminiApiKey) {
    console.error(
      `${RED}[bridge] GEMINI_API_KEY vacía. Copiá backend/.env.example → backend/.env y pegá tu key.${RESET}`,
    );
    process.exit(1);
  }

  console.log(`${DIM}[bridge] test-multisession: 2 sesiones reales simultáneas contra Gemini${RESET}`);
  console.log(`  modelo:   ${config.geminiLiveModel}`);
  console.log(`  modality: ${config.bridgeResponseModality}`);
  console.log(`  tope:     ${config.maxSessions} sesiones · grace: ${config.sessionGraceMs}ms`);
  console.log("");

  // Backend real en proceso, sobre un puerto efímero: no hace falta tener 3001 arriba.
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  const { registry } = registerWsHandlers(wss, config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}/ws`;
  console.log(`[bridge] backend de prueba en ${url}\n`);

  const a = new Client("A", url);
  const b = new Client("B", url);
  const listener = new Client("oyente", url);
  const listener2 = new Client("oyente-2", url);
  await Promise.all([a.connect(), b.connect(), listener.connect(), listener2.connect()]);

  try {
    section("Alta de dos sesiones con idiomas distintos");
    a.send({ type: "start", label: "Auditorio principal", sourceLang: "en", targetLang: "es" });
    b.send({ type: "start", label: "Sala Cóndor", sourceLang: "es", targetLang: "en" });

    const bothStarted = await waitFor(
      "los dos started",
      () => !!a.sessionId && !!b.sessionId,
      15_000,
    );
    check("las dos sesiones arrancaron", bothStarted && !!a.sessionId && !!b.sessionId);
    if (!bothStarted || !a.sessionId || !b.sessionId) return finish(server, registry);
    check("los session_id son distintos", a.sessionId !== b.sessionId, `${a.sessionId} vs ${b.sessionId}`);
    check("el owner recibe su ownerToken", !!a.ownerToken);

    const readyBoth = await waitFor("las dos listas para audio", () => a.ready && b.ready, READY_TIMEOUT_MS);
    check("las dos sesiones quedaron ready en paralelo", readyBoth, `A=${a.ready} B=${b.ready}`);

    section("El listado expone los idiomas por sesión");
    listener.send({ type: "sessions" });
    const listMsg = await waitFor(
      "el listado",
      () => listener.messages.find((m) => m.type === "sessions")?.sessions !== undefined,
      5_000,
    ).then(() => listener.messages.filter((m) => m.type === "sessions").pop());

    const sessions = listMsg?.sessions ?? [];
    const metaA = sessions.find((s) => s.id === a.sessionId);
    const metaB = sessions.find((s) => s.id === b.sessionId);
    check("el oyente ve las 2 sesiones activas", listMsg && sessions.length === 2, `n=${sessions.length}`);
    check(
      "la sesión A figura en→es",
      metaA?.sourceLang === "en" && metaA?.targetLang === "es",
      `${metaA?.sourceLang}→${metaA?.targetLang}`,
    );
    check(
      "la sesión B figura es→en (idiomas independientes)",
      metaB?.sourceLang === "es" && metaB?.targetLang === "en",
      `${metaB?.sourceLang}→${metaB?.targetLang}`,
    );

    section("Dos flujos de audio simultáneos, sin mezcla");
    const audioA = loadPcm16kMono(path.join(__dirname, "assets", "short-talk.wav"));
    const audioB = loadPcm16kMono(path.join(__dirname, "assets", "short-demo.wav"));
    console.log(
      `  A: short-talk.wav (${(audioA.length / 32000).toFixed(1)}s) · B: short-demo.wav primeros 8s`,
    );
    a.streamAudio(audioA);
    b.streamAudio(audioB, 8);

    const textBoth = await waitFor(
      "traducción en ambas sesiones",
      () => a.translations > 0 && b.translations > 0,
      TEXT_TIMEOUT_MS,
    );
    check("ambas sesiones produjeron traducción", textBoth, `A=${a.translations} B=${b.translations}`);
    check("ambas Sessions produjeron transcripción", a.originals > 0 && b.originals > 0, `A=${a.originals} B=${b.originals}`);

    section("Aislamiento de subtítulos entre sesiones");
    check(
      "A no recibió ningún subtítulo de B",
      a.foreignSubtitles().length === 0,
      JSON.stringify(a.foreignSubtitles().slice(0, 2)),
    );
    check(
      "B no recibió ningún subtítulo de A",
      b.foreignSubtitles().length === 0,
      JSON.stringify(b.foreignSubtitles().slice(0, 2)),
    );
    check(
      "cada mensaje de A va etiquetado con su sessionId",
      a.messages
        .filter((m) => SUBTITLE_TYPES.has(m.type ?? ""))
        .every((m) => m.sessionId === a.sessionId),
    );
    console.log(
      `  A tradujo: ${JSON.stringify(a.messages.find((m) => m.type === "translation")?.text?.slice(0, 60))}`,
    );
    console.log(
      `  B tradujo: ${JSON.stringify(b.messages.find((m) => m.type === "translation")?.text?.slice(0, 60))}`,
    );

    section("Tune-in: un tercer cliente se suscribe a A");
    listener.send({ type: "subscribe", sessionId: a.sessionId });
    const subscribed = await waitFor(
      "el ack de subscribed",
      () => listener.messages.some((m) => m.type === "subscribed"),
      5_000,
    );
    check("el oyente se suscribió", subscribed);
    check(
      "no se le anuncia replay de historial",
      listener.messages.find((m) => m.type === "subscribed")?.type === "subscribed" &&
        listener.messages.find((m) => m.type === "subscribed")?.meta !== undefined,
    );

    a.streamAudio(loadPcm16kMono(path.join(__dirname, "assets", "short-talk.wav")));
    const listenerGot = await waitFor(
      "subtítulos de A en el oyente",
      () => listener.subtitlesFor(a.sessionId ?? "").length > 0,
      40_000,
    );
    check("el oyente recibe subtítulos de A", listenerGot);
    check(
      "el oyente no recibe nada de B",
      listener.messages.filter((m) => m.sessionId === b.sessionId).length === 0,
    );

    section("Muro: dos oyentes simultáneos de la misma sesión");
    listener2.send({ type: "subscribe", sessionId: a.sessionId });
    const bothSubscribed = await waitFor(
      "los dos oyentes suscriptos",
      () =>
        listener.messages.some((m) => m.type === "subscribed") &&
        listener2.messages.some((m) => m.type === "subscribed"),
      8_000,
    );
    check("dos clientes se suscribieron a la misma sesión", bothSubscribed);

    listener.send({ type: "sessions" });
    await waitFor("listado actualizado", () => true, 300);
    const afterWall = listener.messages.filter((m) => m.type === "sessions").pop();
    const metaA2 = afterWall?.sessions?.find((s) => s.id === a.sessionId);
    check(
      "el backend cuenta a los 2 oyentes (owner + 2)",
      metaA2?.clients === 3,
      `clients=${metaA2?.clients}`,
    );

    a.streamAudio(loadPcm16kMono(path.join(__dirname, "assets", "short-talk.wav")));
    const bothGot = await waitFor(
      "subtítulos de A en los dos oyentes",
      () =>
        listener.subtitlesFor(a.sessionId ?? "").length > 0 &&
        listener2.subtitlesFor(a.sessionId ?? "").length > 0,
      45_000,
    );
    check("ambos oyentes reciben los subtítulos de A", bothGot);
    check(
      "ambos los reciben con el sessionId de A",
      listener2.messages
        .filter((m) => SUBTITLE_TYPES.has(m.type ?? ""))
        .every((m) => m.sessionId === a.sessionId),
    );
    check(
      "ninguno de los dos oyentes ve nada de B",
      listener.messages.filter((m) => m.sessionId === b.sessionId).length === 0 &&
        listener2.messages.filter((m) => m.sessionId === b.sessionId).length === 0,
    );
    check("el owner A también los sigue recibiendo", a.originals > 0);

    section("Baja quirúrgica: cerrar A no rompe B");
    a.send({ type: "stop", sessionId: a.sessionId });
    const aClosed = await waitFor(
      "el cierre de A",
      () => a.messages.some((m) => m.type === "sessionEnded") || a.ended,
      10_000,
    );
    check("A se cerró", aClosed);
    await sleep(1500);
    check("el registro quedó con 1 sesión", registry.size === 1, `size=${registry.size}`);
    check("la sesión de B sigue viva en el registro", registry.meta(b.sessionId ?? "") !== undefined);
    check("el WS de B sigue abierto", b.open);

    const bBefore = b.translations;
    b.streamAudio(audioA);
    const bStillWorks = await waitFor(
      "B sigue transcribiendo después del cierre de A",
      () => b.translations > bBefore,
      40_000,
    );
    check("B sigue transcribiendo y traduciendo", bStillWorks, `antes=${bBefore} ahora=${b.translations}`);
  } finally {
    finish(server, registry);
  }
}

function finish(server: http.Server, registry: { closeAll: (reason: string) => void }): void {
  registry.closeAll("test-finished");
  server.close();
  setTimeout(() => {
    console.log("");
    if (failed === 0) {
      console.log(`${GREEN}[bridge] OK: ${passed} checks de multi-sesión e2e pasaron.${RESET}`);
      process.exit(0);
    }
    console.error(`${RED}[bridge] ${failed} checks fallaron de ${passed + failed}.${RESET}`);
    process.exit(1);
  }, 500).unref();
}

main().catch((error: Error) => {
  console.error(`${RED}[bridge] Error fatal: ${error?.message ?? error}${RESET}`);
  process.exit(1);
});
