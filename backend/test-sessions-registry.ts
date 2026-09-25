import type { WebSocket } from "ws";
import { SessionRegistry, type TranscriberLike } from "./src/sessions/registry.js";
import type { BridgeConfig } from "./src/config.js";
import type { TranscriberCallbacks } from "./src/gemini/transcriber.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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

const BASE_CONFIG: BridgeConfig = {
  geminiApiKey: "fake-key",
  geminiLiveModel: "fake-model",
  geminiLiveVoice: "Aoede",
  port: 0,
  bridgeResponseModality: "audio",
  bridgeSourceLang: "en",
  bridgeTargetLang: "es",
  reconnectMaxAttempts: 3,
  reconnectBaseDelayMs: 1000,
  readyTimeoutMs: 15000,
  staleSessionMs: 60000,
  maxSessions: 4,
  sessionGraceMs: 15000,
  videoModel: "fake-video-model",
  videoMaxSeconds: 600,
  videoMaxBytes: 209715200,
  videoTimeoutMs: 600000,
  corsOrigins: ["http://localhost:5173"],
};

/** Transcriber falso: no toca la red, sólo registra lo que recibió. */
class FakeTranscriber implements TranscriberLike {
  chunks: Buffer[] = [];
  endTurns = 0;
  closed = 0;
  connecting = 0;
  connectError: Error | null = null;

  constructor(
    readonly config: BridgeConfig,
    readonly callbacks: TranscriberCallbacks,
  ) {}

  async connect(): Promise<void> {
    this.connecting += 1;
    this.callbacks.onStatus?.("connecting");
    if (this.connectError) throw this.connectError;
    this.callbacks.onStatus?.("ready");
  }

  sendAudio(data: Buffer): void {
    this.chunks.push(data);
  }

  endTurn(): void {
    this.endTurns += 1;
  }

  close(): void {
    this.closed += 1;
  }
}

interface SentPayload {
  sessionId?: string;
  type?: string;
  text?: string;
  phase?: string;
  reason?: string;
}

class Harness {
  readonly sent = new Map<WebSocket, SentPayload[]>();
  readonly transcribers: FakeTranscriber[] = [];
  registry: SessionRegistry;
  clientSeq = 0;

  constructor(options: { maxSessions?: number; graceMs?: number } = {}) {
    this.registry = new SessionRegistry({
      config: BASE_CONFIG,
      maxSessions: options.maxSessions ?? 4,
      graceMs: options.graceMs ?? 15000,
      createTranscriber: (config, callbacks) => {
        const fake = new FakeTranscriber(config, callbacks);
        this.transcribers.push(fake);
        return fake;
      },
      send: (ws, payload) => {
        const list = this.sent.get(ws) ?? [];
        list.push(payload as SentPayload);
        this.sent.set(ws, list);
      },
      onChange: () => {},
    });
  }

  client(): { ws: WebSocket; id: string } {
    this.clientSeq += 1;
    const ws = { readyState: 1, tag: `c${this.clientSeq}` } as unknown as WebSocket;
    this.sent.set(ws, []);
    return { ws, id: `client-${this.clientSeq}` };
  }

  payloads(ws: WebSocket, type?: string): SentPayload[] {
    return (this.sent.get(ws) ?? []).filter((p) => !type || p.type === type);
  }

  open(id: string, options: { label?: string; sourceLang?: string; targetLang?: string } = {}) {
    const owner = this.client();
    const created = this.registry.create({
      owner: owner.ws,
      ownerClientId: owner.id,
      label: options.label,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
    });
    if (!created.ok) throw new Error(`create falló: ${created.reason}`);
    // El handler separa alta y apertura: el ACK viaja antes del primer status.
    const connected = this.registry.connect(created.entry.id);
    if (!connected.ok) throw new Error(`connect falló: ${connected.reason}`);
    const trans = this.transcribers[this.transcribers.length - 1];
    return { ...owner, entry: created.entry, ownerToken: created.ownerToken, trans };
  }
}

async function testFanOutDeSuscriptores(): Promise<void> {
  section("Varios suscriptores de la misma sesión (lo que usa el muro)");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const muros = [h.client(), h.client(), h.client()];
  for (const m of muros) h.registry.subscribe(m.ws, m.id, a.entry.id);

  check("3 oyentes + owner = 4 clientes", h.registry.meta(a.entry.id)?.clients === 4);

  a.trans.callbacks.onInput?.("frase-para-todos");
  a.trans.callbacks.onTranslation?.("traduccion-para-todos");

  for (const [index, m] of muros.entries()) {
    const texts = h.payloads(m.ws).map((p) => p.text ?? "");
    check(
      `el oyente ${index + 1} recibió los subtítulos de A`,
      texts.includes("frase-para-todos") && texts.includes("traduccion-para-todos"),
      texts.join(" | "),
    );
    check(
      `el oyente ${index + 1} los recibe con el sessionId correcto`,
      h.payloads(m.ws, "translation").every((p) => p.sessionId === a.entry.id),
    );
  }

  const other = h.open("2", { label: "B" });
  other.trans.callbacks.onTranslation?.("esto-es-de-B");
  for (const [index, m] of muros.entries()) {
    check(
      `el oyente ${index + 1} no ve nada de B`,
      !h.payloads(m.ws).some((p) => p.text === "esto-es-de-B"),
    );
  }

  const target = muros[0];
  h.registry.removeClient(target.ws, target.id);
  check("baja un oyente y quedan 3 clientes", h.registry.meta(a.entry.id)?.clients === 3);

  a.trans.callbacks.onTranslation?.("sigue-llegando");
  check(
    "el fan-out sigue funcionando para los que quedan",
    muros[1].ws !== target.ws &&
      h.payloads(muros[1].ws).some((p) => p.text === "sigue-llegando") &&
      h.payloads(muros[2].ws).some((p) => p.text === "sigue-llegando"),
  );
  check(
    "el oyente que se fue no recibe más subtítulos",
    !h.payloads(target.ws).some((p) => p.text === "sigue-llegando"),
  );

  h.registry.close(a.entry.id, "stopped");
  check(
    "el cierre notifica a todos los oyentes vivos",
    muros.slice(1).every((m) => h.payloads(m.ws, "sessionEnded").length === 1),
  );
  check(
    "no se filtró texto de B al muro",
    muros.every((m) => !h.payloads(m.ws).some((p) => p.text?.includes("de-B"))),
  );
}

async function testConnectEsIdempotente(): Promise<void> {
  section("connect() es idempotente: el reclaim no duplica la conexión a Gemini");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  check(
    "el alta abre exactamente 1 conexión",
    a.trans.connecting === 1,
    `connecting=${a.trans.connecting}`,
  );

  h.registry.connect(a.entry.id);
  h.registry.connect(a.entry.id);
  check(
    "repetir connect() no reconecta",
    a.trans.connecting === 1,
    `connecting=${a.trans.connecting}`,
  );

  const reclaimer = h.client();
  const reclaimed = h.registry.create({
    owner: reclaimer.ws,
    ownerClientId: reclaimer.id,
    reclaim: { sessionId: a.entry.id, ownerToken: a.ownerToken },
  });
  if (!reclaimed.ok) throw new Error(`reclaim falló: ${reclaimed.reason}`);
  check("el reclaim recupera la sesión existente", reclaimed.entry.id === a.entry.id);
  check(
    "el reclaim no crea un transcoder nuevo",
    h.transcribers.length === 1,
    `transcribers=${h.transcribers.length}`,
  );

  h.registry.connect(a.entry.id);
  check(
    "el connect() del handler tras el reclaim no duplica la conexión",
    a.trans.connecting === 1,
    `connecting=${a.trans.connecting}`,
  );
  check(
    "la propiedad pasa al cliente que reclamó",
    h.registry.meta(a.entry.id)?.ownerId === reclaimer.id,
  );

  h.registry.close(a.entry.id, "fin");
  check("el transcoder se cierra una sola vez", a.trans.closed === 1, `closed=${a.trans.closed}`);
  check(
    "connect() sobre una sesión cerrada no la revive",
    !h.registry.connect(a.entry.id).ok,
  );
}

async function testAltaAislamiento(): Promise<void> {
  section("Alta e aislamiento: cada sesión tiene su propia conexión");
  const h = new Harness();

  const a = h.open("1", { label: "Auditorio", sourceLang: "en", targetLang: "es" });
  const b = h.open("2", { label: "Sala Cóndor", sourceLang: "es", targetLang: "en" });

  check("dos sesiones tienen session_id distintos", a.entry.id !== b.entry.id);
  check("el registro tiene 2 sesiones", h.registry.size === 2, `size=${h.registry.size}`);
  check(
    "cada sesión abrió su propio connect() a Gemini",
    a.trans !== b.trans && a.trans.connecting === 1 && b.trans.connecting === 1,
  );
  check(
    "los idiomas son por sesión (en→es vs es→en)",
    a.trans.config.bridgeSourceLang === "en" &&
      a.trans.config.bridgeTargetLang === "es" &&
      b.trans.config.bridgeSourceLang === "es" &&
      b.trans.config.bridgeTargetLang === "en",
    `A=${a.trans.config.bridgeSourceLang}→${a.trans.config.bridgeTargetLang} B=${b.trans.config.bridgeSourceLang}→${b.trans.config.bridgeTargetLang}`,
  );
  check(
    "el resto de la config no se pisa entre sesiones",
    a.trans.config.geminiLiveModel === BASE_CONFIG.geminiLiveModel &&
      b.trans.config.geminiLiveModel === BASE_CONFIG.geminiLiveModel,
  );
}

async function testAudioNoSeMezcla(): Promise<void> {
  section("El audio de A nunca llega al pipeline de B");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const b = h.open("2", { label: "B" });

  h.registry.pushAudio(a.ws, a.id, Buffer.from("audio-de-A"));
  h.registry.pushAudio(a.ws, a.id, Buffer.from("mas-audio-de-A"));
  h.registry.pushAudio(b.ws, b.id, Buffer.from("audio-de-B"));

  const aTexts = a.trans.chunks.map((c) => c.toString()).join(",");
  const bTexts = b.trans.chunks.map((c) => c.toString()).join(",");
  check("A recibió sus 2 chunks", a.trans.chunks.length === 2, aTexts);
  check("B recibió sólo su chunk", b.trans.chunks.length === 1, bTexts);
  check("B nunca vio el audio de A", !bTexts.includes("audio-de-A"));
  check("A nunca vio el audio de B", !aTexts.includes("audio-de-B"));
}

async function testSoloOwnerMandaAudio(): Promise<void> {
  section("Tune-in es sólo escucha: un oyente no puede subir audio");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const listener = h.client();

  const sub = h.registry.subscribe(listener.ws, listener.id, a.entry.id);
  check("el suscriptor entra a la sesión", sub.ok);

  const result = h.registry.pushAudio(listener.ws, listener.id, Buffer.from("intento"));
  check("el oyente no puede mandar audio", !result.ok, result.ok ? "aceptó audio" : result.reason);
  check("el pipeline de A no recibió el intento", a.trans.chunks.length === 0);
  check("el oyente figura en la lista de la sesión", (h.registry.meta(a.entry.id)?.clients ?? 0) === 2);
}

async function testSintonizacionAislada(): Promise<void> {
  section("Cada WS recibe sólo los subtítulos de su sesión");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const b = h.open("2", { label: "B" });
  const listener = h.client();
  h.registry.subscribe(listener.ws, listener.id, b.entry.id);

  a.trans.callbacks.onInput?.("texto-de-A");
  a.trans.callbacks.onTranslation?.("traduccion-de-A");
  b.trans.callbacks.onInput?.("texto-de-B");
  b.trans.callbacks.onTranslation?.("traduccion-de-B");

  const ownerA = h.payloads(a.ws);
  const listenerTexts = h.payloads(listener.ws).map((p) => p.text ?? "");
  check(
    "el owner de A recibe lo suyo",
    ownerA.some((p) => p.text === "texto-de-A") && ownerA.some((p) => p.text === "traduccion-de-A"),
  );
  check("el owner de A no recibe nada de B", !ownerA.some((p) => p.text?.includes("de-B")));
  check(
    "el oyente de B recibe sólo lo de B",
    listenerTexts.includes("texto-de-B") && listenerTexts.includes("traduccion-de-B"),
    listenerTexts.join(" | "),
  );
  check(
    "el oyente de B no recibe nada de A",
    !listenerTexts.some((t) => t.includes("de-A")),
    listenerTexts.join(" | "),
  );
  check(
    "todos los mensajes van etiquetados con sessionId",
    h.payloads(listener.ws).every((p) => p.sessionId === b.entry.id),
  );
}

async function testBajaQuirurgica(): Promise<void> {
  section("Baja quirúrgica: cerrar A no toca B");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const b = h.open("2", { label: "B" });
  const listenerB = h.client();
  h.registry.subscribe(listenerB.ws, listenerB.id, b.entry.id);

  h.registry.close(a.entry.id, "stopped");

  check("A sale del registro", h.registry.size === 1);
  check("B sigue en el registro", h.registry.meta(b.entry.id) !== undefined);
  check("A cerró su conexión a Gemini", a.trans.closed === 1);
  check("B NO cerró su conexión a Gemini", b.trans.closed === 0);
  check(
    "el oyente de B sigue registrado en B",
    h.registry.meta(b.entry.id)?.clients === 2,
  );
  check("A no puede volver a escribirse", h.registry.pushAudio(a.ws, a.id, Buffer.from("x")).ok === false);

  b.trans.callbacks.onTranslation?.("B-sigue-vivo");
  check(
    "B sigue emitiendo hacia sus oyentes",
    h.payloads(listenerB.ws).some((p) => p.text === "B-sigue-vivo"),
  );
}

async function testCierresConcurrentes(): Promise<void> {
  section("Cierres concurrentes y doble cierre");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const b = h.open("2", { label: "B" });
  const c = h.open("3", { label: "C" });

  const first = h.registry.close(a.entry.id, "stopped");
  const again = h.registry.close(a.entry.id, "stopped");
  const third = h.registry.close(c.entry.id, "stopped");

  check("el primer cierre de A se aplica", first);
  check("el segundo cierre de A es no-op (sin condición de carrera)", again === false);
  check("A no se cierra dos veces a nivel Gemini", a.trans.closed === 1, `closed=${a.trans.closed}`);
  check("el cierre de C se aplica", third);
  check("B sobrevive", h.registry.meta(b.entry.id) !== undefined);
  check("queda 1 sesión", h.registry.size === 1, `size=${h.registry.size}`);
  check("B nunca se cerró", b.trans.closed === 0);

  const [r1, r2, r3] = [
    h.registry.close(b.entry.id, "x"),
    h.registry.close("no-existe", "x"),
    h.registry.close(b.entry.id, "x"),
  ];
  check("cerrar B se aplica una vez y el resto es no-op", r1 && !r2 && !r3);
  check("el registro queda vacío", h.registry.size === 0);
}

async function testCallbackTardio(): Promise<void> {
  section("Callback tardío de Gemini tras el cierre no rompe nada");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const b = h.open("2", { label: "B" });
  const late = a.trans.callbacks;

  h.registry.close(a.entry.id, "stopped");
  let threw = false;
  try {
    late.onTranslation?.("fantasma");
    late.onInput?.("fantasma");
    late.onStatus?.("ready");
    late.onTurnComplete?.();
  } catch {
    threw = true;
  }
  check("un callback de una sesión cerrada no tira excepción", !threw);
  check(
    "no filtró texto a nadie tras el cierre",
    h.payloads(b.ws).every((p) => p.text !== "fantasma"),
  );
  check("B quedó intacta", h.registry.meta(b.entry.id) !== undefined && b.trans.closed === 0);
}

async function testTopeDeSesiones(): Promise<void> {
  section("Tope de sesiones simultáneas");
  const h = new Harness({ maxSessions: 2 });
  h.open("1", { label: "A" });
  h.open("2", { label: "B" });

  const extra = h.client();
  const result = h.registry.create({ owner: extra.ws, ownerClientId: extra.id, label: "C" });
  check("la tercera sesión es rechazada con el tope de 2", !result.ok);
  check(
    "el error es explícito y menciona el límite",
    !result.ok && /máximo de 2/.test(result.reason),
    result.ok ? "aceptada" : result.reason,
  );
  check("sigue habiendo 2 sesiones", h.registry.size === 2);
  check("no se abrió una conexión de Gemini extra", h.transcribers.length === 2);
}

async function testGracePeriod(): Promise<void> {
  section("Grace period: refresh de pestaña no corta la sesión");
  const h = new Harness({ graceMs: 120 });
  const a = h.open("1", { label: "A" });

  h.registry.removeClient(a.ws, a.id);

  const meta = h.registry.meta(a.entry.id);
  check("la sesión sobrevive al refresh", h.registry.size === 1);
  check("Queda huérfana (sin owner)", meta?.orphaned === true);
  check("tiene graceUntil para la UI", typeof meta?.graceUntil === "number");
  check("no se cerró la conexión a Gemini todavía", a.trans.closed === 0);

  const newcomer = h.client();
  const wrong = h.registry.attachOwner(newcomer.ws, newcomer.id, a.entry.id, "token-falso");
  check("un token inválido no puede reclamar la sesión", !wrong.ok);

  const good = h.registry.attachOwner(newcomer.ws, newcomer.id, a.entry.id, a.ownerToken);
  check("con el ownerToken correcto recupera ownership", good.ok);
  check("vuelve a tener owner", h.registry.meta(a.entry.id)?.orphaned === false);
  check("el cliente nuevo quedó suscripto", h.registry.meta(a.entry.id)?.clients === 1);

  await sleep(220);
  check("vencido el grace con owner de vuelta, NO se cierra", h.registry.size === 1);
  check("la conexión a Gemini sigue viva", a.trans.closed === 0);
}

async function testGraceVencido(): Promise<void> {
  section("Grace vencido sin owner: se cierra aunque queden oyentes");
  const h = new Harness({ graceMs: 60 });
  const a = h.open("1", { label: "A" });
  const listener = h.client();
  h.registry.subscribe(listener.ws, listener.id, a.entry.id);

  h.registry.removeClient(a.ws, a.id);
  check("durante el grace la sesión sigue viva", h.registry.size === 1);

  await sleep(140);
  check("vencido el grace se cierra la sesión", h.registry.size === 0);
  check("se cerró la conexión a Gemini", a.trans.closed === 1);
  check("el oyente fue notificado", h.payloads(listener.ws).some((p) => p.type === "sessionEnded"));
}

async function testGraceCero(): Promise<void> {
  section("Grace 0: cierre inmediato al desconectarse el owner");
  const h = new Harness({ graceMs: 0 });
  const a = h.open("1", { label: "A" });
  h.registry.removeClient(a.ws, a.id);
  check("se cierra en el acto", h.registry.size === 0);
  check("se cerró la conexión a Gemini", a.trans.closed === 1);
}

async function testStopSoloOwner(): Promise<void> {
  section("Sólo el owner puede cerrar su sesión");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const listener = h.client();
  h.registry.subscribe(listener.ws, listener.id, a.entry.id);

  const denied = h.registry.stop(listener.ws, listener.id);
  check("el oyente no puede cerrar la sesión de otro", !denied.ok, denied.ok ? "permitió" : denied.reason);
  check("la sesión sigue viva", h.registry.size === 1);

  const allowed = h.registry.stop(a.ws, a.id);
  check("el owner sí puede cerrar", allowed.ok);
  check("la sesión se cerró", h.registry.size === 0);
}

async function testDesconexionDeOyente(): Promise<void> {
  section("Si se va un oyente, la sesión del owner sigue viva");
  const h = new Harness();
  const a = h.open("1", { label: "A" });
  const l1 = h.client();
  const l2 = h.client();
  h.registry.subscribe(l1.ws, l1.id, a.entry.id);
  h.registry.subscribe(l2.ws, l2.id, a.entry.id);

  h.registry.removeClient(l1.ws, l1.id);
  check("la sesión sigue viva", h.registry.size === 1);
  check("el owner conserva su conexión a Gemini", a.trans.closed === 0);
  check("queda el owner + 1 oyente", h.registry.meta(a.entry.id)?.clients === 2);
  check("el owner sigue con ownership", h.registry.meta(a.entry.id)?.ownerId === a.id);
  check("el owner todavía puede mandar audio", h.registry.pushAudio(a.ws, a.id, Buffer.from("x")).ok);
}

async function testSuscripcionATodas(): Promise<void> {
  section("Ninguna baja de un cliente afecta a las demás sesiones");
  // grace 0 para que la baja del owner sea un cierre inmediato y se pueda comprobar
  // que el cierre de B no arrastra a A ni a C.
  const h = new Harness({ graceMs: 0 });
  const owners = [h.open("1", { label: "A" }), h.open("2", { label: "B" }), h.open("3", { label: "C" })];

  h.registry.removeClient(owners[1].ws, owners[1].id);

  for (const [index, entry] of owners.entries()) {
    const expected = index === 1;
    const alive = h.registry.meta(entry.entry.id) !== undefined;
    check(
      `sesión ${entry.entry.label} ${expected ? "se cerró" : "sigue viva"}`,
      alive === !expected,
    );
  }
  check("el owner de B cerró su Gemini", owners[1].trans.closed === 1);
  check("A y C no cerraron su Gemini", owners[0].trans.closed === 0 && owners[2].trans.closed === 0);
}

async function testMultiplesOwnersSimultaneos(): Promise<void> {
  section("Varias sesiones abiertas y propias desde la misma pestaña");
  const h = new Harness();
  const opened = [
    h.open("1", { label: "A", sourceLang: "en", targetLang: "es" }),
    h.open("2", { label: "B", sourceLang: "en", targetLang: "es" }),
    h.open("3", { label: "C", sourceLang: "pt", targetLang: "en" }),
    h.open("4", { label: "D", sourceLang: "en", targetLang: "fr" }),
  ];

  check("hay 4 sesiones vivas", h.registry.size === 4);
  check("cada una abrió su propia conexión a Gemini", h.transcribers.length === 4);
  check(
    "cada una tiene un ownerToken distinto",
    new Set(opened.map((o) => o.ownerToken)).size === 4,
  );
  check(
    "cada una quedó con su owner",
    opened.every((o) => h.registry.meta(o.entry.id)?.ownerId === o.id),
  );
  check(
    "los idiomas son por sesión",
    h.registry.meta(opened[2].entry.id)?.sourceLang === "pt" &&
      h.registry.meta(opened[2].entry.id)?.targetLang === "en" &&
      h.registry.meta(opened[3].entry.id)?.targetLang === "fr",
  );
  check("C no compartió config con A", opened[2].trans.config.bridgeSourceLang === "pt");
  check("A no compartió config con D", opened[0].trans.config.bridgeTargetLang === "es");

  for (const [index, owner] of opened.entries()) {
    check(
      `${owner.entry.label} puede mandar audio a su propia sesión`,
      h.registry.pushAudio(owner.ws, owner.id, Buffer.from(`audio-${index}`)).ok,
    );
  }
  for (const [index, owner] of opened.entries()) {
    check(
      `${owner.entry.label} recibió sólo su propio audio`,
      owner.trans.chunks.length === 1 &&
        owner.trans.chunks[0].toString() === `audio-${index}`,
    );
  }

  opened[1].trans.callbacks.onTranslation?.("solo-para-B");
  for (const owner of [opened[0], opened[2], opened[3]]) {
    check(
      `${owner.entry.label} no recibió la traducción de B`,
      !h.payloads(owner.ws).some((p) => p.text === "solo-para-B"),
    );
  }
  check(
    "B sí recibió su propia traducción",
    h.payloads(opened[1].ws).some((p) => p.text === "solo-para-B"),
  );

  h.registry.stop(opened[1].ws, opened[1].id);
  check("cerrar B no afecta a las otras 3", h.registry.size === 3);
  check("A, C y D siguen con ownership", opened
    .filter((_, i) => i !== 1)
    .every((o) => h.registry.meta(o.entry.id)?.ownerId === o.id));
}

async function testOwnerQueSeMudaDeSesion(): Promise<void> {
  section("El owner que se sintoniza a otra sesión deja la anterior con grace");
  const h = new Harness({ graceMs: 40 });
  const a = h.open("1", { label: "A" });
  const b = h.open("2", { label: "B" });

  // Un WS sólo puede estar suscrito a una sesión: el socket del owner de A se
  // re-apunta a B con subscribe. A queda sin nadie capaz de mandarle audio, así que
  // tiene que entrar en grace y cerrarse sola en vez de quedar huérfana.
  h.registry.subscribe(a.ws, a.id, b.entry.id);
  check("A queda huérfana", h.registry.meta(a.entry.id)?.ownerId === null);
  check("A tiene graceUntil para la UI", h.registry.meta(a.entry.id)?.graceUntil !== null);
  check("A no se cierra en el acto", h.registry.size === 2);
  check("A ya no puede recibir audio", !h.registry.pushAudio(a.ws, a.id, Buffer.from("x")).ok);

  await sleep(120);
  check("vencido el grace A se cierra sola", h.registry.size === 1);
  check("A cerró su conexión a Gemini", a.trans.closed === 1);
  check("B quedó intacta", b.trans.closed === 0);
}

async function testStartRepetidoEnElMismoSocket(): Promise<void> {
  section("Un start repetido en el mismo socket no deja la sesión anterior huérfana");
  const h = new Harness({ graceMs: 40 });
  const owner = h.client();

  const alta = (label: string) => {
    const created = h.registry.create({
      owner: owner.ws,
      ownerClientId: owner.id,
      label,
    });
    if (!created.ok) throw new Error(`create falló: ${created.reason}`);
    const connected = h.registry.connect(created.entry.id);
    if (!connected.ok) throw new Error(`connect falló: ${connected.reason}`);
    return created.entry;
  };

  // create() re-apunta el ws a la sesión nueva, igual que hace subscribe(). Si no saca
  // al cliente de la anterior, esa sesión queda con un ownerClientId que ya no la
  // apunta, nunca entra en grace y se queda ocupando un cupo de maxSessions para
  // siempre: es una sesión que aparece sin que nadie la haya creado.
  const a = alta("A");
  const transA = h.transcribers[h.transcribers.length - 1];
  const b = alta("B");
  const transB = h.transcribers[h.transcribers.length - 1];

  check("quedan 2 sesiones", h.registry.size === 2);
  check("A queda huérfana", h.registry.meta(a.id)?.ownerId === null);
  check("A tiene graceUntil para la UI", h.registry.meta(a.id)?.graceUntil !== null);
  check("A no se cierra en el acto", h.registry.size === 2);
  check("el socket quedó apuntado a B", h.registry.meta(b.id)?.ownerId === owner.id);
  check(
    "el audio del socket va al pipeline de B y no al de A",
    h.registry.pushAudio(owner.ws, owner.id, Buffer.from("y")).ok &&
      transB.chunks[0]?.toString() === "y" &&
      transA.chunks.length === 0,
  );

  await sleep(120);
  check("vencido el grace A se cierra sola", h.registry.size === 1);
  check("A cerró su conexión a Gemini", transA.closed === 1);
  check("B quedó intacta", transB.closed === 0);
}

async function main(): Promise<void> {
  console.log(`${DIM}[bridge] test-sessions-registry: ciclo de vida multi-sesión (offline)${RESET}`);

  await testAltaAislamiento();
  await testFanOutDeSuscriptores();
  await testConnectEsIdempotente();
  await testMultiplesOwnersSimultaneos();
  await testAudioNoSeMezcla();
  await testSoloOwnerMandaAudio();
  await testSintonizacionAislada();
  await testBajaQuirurgica();
  await testCierresConcurrentes();
  await testCallbackTardio();
  await testTopeDeSesiones();
  await testGracePeriod();
  await testGraceVencido();
  await testGraceCero();
  await testStopSoloOwner();
  await testDesconexionDeOyente();
  await testSuscripcionATodas();
  await testOwnerQueSeMudaDeSesion();
  await testStartRepetidoEnElMismoSocket();

  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}[bridge] OK: ${passed} checks de multi-sesión pasaron.${RESET}`);
    process.exit(0);
  }
  console.error(`${RED}[bridge] ${failed} checks fallaron de ${passed + failed}.${RESET}`);
  process.exit(1);
}

main().catch((error: Error) => {
  console.error(`${RED}[bridge] Error fatal: ${error?.message ?? error}${RESET}`);
  process.exit(1);
});
