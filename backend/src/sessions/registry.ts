import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import type {
  StatusInfo,
  StatusPhase,
  TranscriberCallbacks,
} from "../gemini/transcriber.js";

const DEBUG = process.env.BRIDGE_DEBUG === "1";

/**
 * Superficie mínima que el registro necesita de un transcriber. El Transcriber real
 * la cumple tal cual; los tests offline inyectan un fake que también la cumple, por
 * lo que el ciclo de vida se puede verificar sin red ni GEMINI_API_KEY.
 */
export interface TranscriberLike {
  connect(): Promise<void>;
  sendAudio(data: Buffer): void;
  endTurn(): void;
  close(): void;
}

export type TranscriberFactory = (
  sessionConfig: BridgeConfig,
  callbacks: TranscriberCallbacks,
) => TranscriberLike;

export interface SessionMeta {
  id: string;
  label: string;
  sourceLang: string;
  targetLang: string;
  createdAt: number;
  phase: StatusPhase;
  clients: number;
  ownerId: string | null;
  orphaned: boolean;
  graceUntil: number | null;
}

export interface SessionEntry {
  id: string;
  ownerToken: string;
  label: string;
  sourceLang: string;
  targetLang: string;
  createdAt: number;
  lastActivityAt: number;
  ownerClientId: string | null;
  transcriber: TranscriberLike | null;
  clients: Set<WebSocket>;
  phase: StatusPhase;
  closing: boolean;
  connectStarted: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  graceUntil: number | null;
}

export interface SessionRegistryOptions {
  config: BridgeConfig;
  createTranscriber: TranscriberFactory;
  send: (ws: WebSocket, payload: unknown) => void;
  onChange: () => void;
  maxSessions?: number;
  graceMs?: number;
  now?: () => number;
}

export type CreateResult =
  | { ok: true; entry: SessionEntry; ownerToken: string }
  | { ok: false; reason: string };

export type ActionResult = { ok: true } | { ok: false; reason: string };

/**
 * Registro de sesiones activas: session_id -> sesión de Gemini + WS suscritos.
 *
 * Aislamiento: cada sesión tiene su propio Transcriber (y por lo tanto su propio
 * socket a Gemini Live) y su propio Set de clientes. No hay estado de pipeline
 * compartido entre sesiones.
 *
 * Concurrencia: el mapa es privado y todas las mutaciones pasan por acá, así que
 * cada operación es síncrona y atómica respecto de las demás (JS es single-threaded).
 * `closing` evita dobles cierres y remover la entrada del mapa ANTES de cerrar el
 * transcriber hace que cualquier callback tardío de Gemini no encuentre la sesión
 * y no escriba sobre clientes.
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #subscribed = new Map<WebSocket, string>();
  readonly #config: BridgeConfig;
  readonly #createTranscriber: TranscriberFactory;
  readonly #send: (ws: WebSocket, payload: unknown) => void;
  readonly #onChange: () => void;
  readonly #maxSessions: number;
  readonly #graceMs: number;
  readonly #now: () => number;
  #sequence = 0;

  constructor(options: SessionRegistryOptions) {
    this.#config = options.config;
    this.#createTranscriber = options.createTranscriber;
    this.#send = options.send;
    this.#onChange = options.onChange;
    this.#maxSessions = options.maxSessions ?? 4;
    this.#graceMs = options.graceMs ?? 15_000;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#sessions.size;
  }

  list(): SessionMeta[] {
    return [...this.#sessions.values()].map((entry) => this.#toMeta(entry));
  }

  #toMeta(entry: SessionEntry): SessionMeta {
    return {
      id: entry.id,
      label: entry.label,
      sourceLang: entry.sourceLang,
      targetLang: entry.targetLang,
      createdAt: entry.createdAt,
      phase: entry.phase,
      clients: entry.clients.size,
      ownerId: entry.ownerClientId,
      orphaned: entry.ownerClientId === null,
      graceUntil: entry.graceUntil,
    };
  }

  meta(id: string): SessionMeta | undefined {
    const entry = this.#sessions.get(id);
    return entry ? this.#toMeta(entry) : undefined;
  }

  subscribedSessionId(ws: WebSocket): string | undefined {
    return this.#subscribed.get(ws);
  }

  /**
   * Alta de sesión. Cada sesión abre su propia conexión a Gemini Live.
   * Si viene ownerToken y matchea una sesión huérfana, recupera esa sesión en vez
   * de crear una nueva (refresh de pestaña).
   */
  create(options: {
    ownerClientId: string;
    owner: WebSocket;
    label?: string;
    sourceLang?: string;
    targetLang?: string;
    reclaim?: { sessionId: string; ownerToken: string };
  }): CreateResult {
    const { owner, ownerClientId } = options;

    if (options.reclaim) {
      const existing = this.#sessions.get(options.reclaim.sessionId);
      if (existing && !existing.closing) {
        // La sesión sigue viva: el token tiene que matchear. Si no, se rechaza en vez
        // de crear otra sesión y dejar la primera huérfana consumiendo cuota.
        const result = this.attachOwner(
          owner,
          ownerClientId,
          options.reclaim.sessionId,
          options.reclaim.ownerToken,
        );
        if (!result.ok) return result;
        return { ok: true, entry: existing, ownerToken: existing.ownerToken };
      }
      // La sesión ya no existe (pasó el grace period): se crea una nueva.
    }

    if (this.#sessions.size >= this.#maxSessions) {
      return {
        ok: false,
        reason: `Se alcanzó el máximo de ${this.#maxSessions} sesiones simultáneas. Cerrá una para continuar.`,
      };
    }

    this.#sequence += 1;
    const id = randomUUID();
    const now = this.#now();
    const ownerToken = randomUUID();
    const sourceLang = options.sourceLang ?? this.#config.bridgeSourceLang;
    const targetLang = options.targetLang ?? this.#config.bridgeTargetLang;

    const entry: SessionEntry = {
      id,
      ownerToken,
      label: options.label?.trim() || `Sesión ${this.#sequence}`,
      sourceLang,
      targetLang,
      createdAt: now,
      lastActivityAt: now,
      ownerClientId: ownerClientId,
      transcriber: null,
      clients: new Set<WebSocket>([owner]),
      phase: "connecting",
      closing: false,
      connectStarted: false,
      graceTimer: null,
      graceUntil: null,
    };

    // Los idiomas son por sesión: se clona la config base overriding solo los campos
    // de idioma, de modo que el Transcriber de esta sesión no comparte nada con otra.
    const sessionConfig: BridgeConfig = {
      ...this.#config,
      bridgeSourceLang: sourceLang,
      bridgeTargetLang: targetLang,
    };

    const transcriber = this.#createTranscriber(sessionConfig, this.#callbacksFor(entry));
    entry.transcriber = transcriber;

    // Un socket sólo puede estar apuntado a una sesión (#subscribed es ws -> sessionId).
    // Si este ws ya estaba en otra hay que sacarlo de ella y dispararle su grace: si
    // no, la sesión vieja queda con un ownerClientId que ya no la apunta, nunca entra
    // en grace y se queda ocupando uno de los cupos de maxSessions para siempre.
    // Es el mismo tratamiento que le da subscribe() más abajo.
    let orphanedEntry: SessionEntry | undefined;
    const previous = this.#subscribed.get(owner);
    if (previous && previous !== id) {
      this.#subscribed.delete(owner);
      const old = this.#sessions.get(previous);
      if (old) {
        old.clients.delete(owner);
        if (old.ownerClientId === ownerClientId) orphanedEntry = old;
      }
    }

    this.#sessions.set(id, entry);
    this.#subscribed.set(owner, id);

    if (orphanedEntry && !orphanedEntry.closing) {
      this.#startGrace(orphanedEntry);
    } else {
      this.#onChange();
    }

    return { ok: true, entry, ownerToken };
  }

  /**
   * Abre la conexión a Gemini Live de esta sesión. Se separa del alta para que el
   * servidor pueda mandar el ACK "started" antes del primer "status".
   * Cada sesión abre la suya: nunca se comparte un socket entre sesiones.
   *
   * Idempotente: recuperar una sesión ya viva (reclaim por refresh de pestaña) no
   * debe abrir una segunda conexión contra Gemini sobre el mismo token.
   */
  connect(id: string): ActionResult {
    const entry = this.#sessions.get(id);
    if (!entry || entry.closing) return { ok: false, reason: "La sesión ya no está activa" };
    if (entry.connectStarted) return { ok: true };
    const transcriber = entry.transcriber;
    if (!transcriber) return { ok: false, reason: "La sesión no tiene transcoder" };
    entry.connectStarted = true;
    transcriber.connect().catch((error: unknown) => {
      // Un fallo terminal ya fue notificado por onStatus("failed"/"ended").
      if (DEBUG) {
        console.log(
          `[sessions][${id.slice(0, 8)}] connect() terminó sin sesión:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      this.close(id, "connect-failed");
    });
    return { ok: true };
  }

  #callbacksFor(entry: SessionEntry): TranscriberCallbacks {
    return {
      onStatus: (phase, detail, info) => {
        const live = this.#sessions.get(entry.id);
        if (!live || live.closing) return;
        // La fase vive también en el listado, así que hay que re-broadcastar el
        // snapshot cuando cambia (si no, la UI se queda en "connecting" para siempre).
        const changed = live.phase !== phase;
        live.phase = phase;
        this.#broadcast(entry.id, { type: "status", phase, detail, ...(info ?? {}) });
        if (changed) this.#onChange();
        if (phase === "ended" || phase === "failed") this.close(entry.id, phase);
      },
      onInputInterim: (text) => {
        this.#broadcast(entry.id, { type: "original", text, interim: true });
      },
      onInput: (text) => {
        const live = this.#sessions.get(entry.id);
        if (live) live.lastActivityAt = this.#now();
        this.#broadcast(entry.id, { type: "original", text, interim: false });
      },
      onTranslation: (text) => {
        this.#broadcast(entry.id, { type: "translation", text });
      },
      onTurnComplete: () => this.#broadcast(entry.id, { type: "segment" }),
      onError: (detail) => {
        if (DEBUG) console.log(`[sessions][${entry.id.slice(0, 8)}][error]`, detail);
      },
      onClose: (code, reason) => {
        if (DEBUG) {
          console.log(`[sessions][${entry.id.slice(0, 8)}][close] ${code} ${reason ?? ""}`);
        }
      },
    };
  }

  #broadcast(id: string, payload: Record<string, unknown>): void {
    const entry = this.#sessions.get(id);
    if (!entry || entry.closing) return;
    const full = { sessionId: id, ...payload };
    for (const ws of entry.clients) this.#send(ws, full);
  }

  /** Tune-in a una sesión existente. Solo escucha: no puede enviar audio. */
  subscribe(ws: WebSocket, clientId: string, sessionId: string): ActionResult {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.closing) {
      return { ok: false, reason: "La sesión ya no está activa" };
    }
    let orphanedEntry: SessionEntry | undefined;
    const previous = this.#subscribed.get(ws);
    if (previous && previous !== sessionId) {
      this.#subscribed.delete(ws);
      const old = this.#sessions.get(previous);
      if (old) {
        old.clients.delete(ws);
        if (old.ownerClientId === clientId) orphanedEntry = old;
      }
    }
    this.#subscribed.set(ws, sessionId);
    entry.clients.add(ws);
    entry.lastActivityAt = this.#now();

    // El socket del owner se mudó de sesión, así que la que dejaba queda sin nadie
    // capaz de mandarle audio. Se le dispara su grace: si un refresh la reclama,
    // se recupera; si no, se cierra sola en vez de quedar huérfana ocupando cupo.
    if (orphanedEntry && !orphanedEntry.closing) {
      this.#startGrace(orphanedEntry);
    } else {
      this.#onChange();
    }
    return { ok: true };
  }

  /** Recupera ownership tras un refresh usando el ownerToken emitido al crear. */
  attachOwner(
    ws: WebSocket,
    clientId: string,
    sessionId: string,
    ownerToken: string,
  ): ActionResult {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.closing) {
      return { ok: false, reason: "La sesión ya no está activa" };
    }
    if (entry.ownerToken !== ownerToken) {
      return { ok: false, reason: "Token de ownership inválido" };
    }
    this.#cancelGrace(entry);
    entry.ownerClientId = clientId;
    this.#subscribed.set(ws, sessionId);
    entry.clients.add(ws);
    entry.lastActivityAt = this.#now();
    this.#onChange();
    return { ok: true };
  }

  unsubscribe(ws: WebSocket, sessionId: string): ActionResult {
    const entry = this.#sessions.get(sessionId);
    if (this.#subscribed.get(ws) === sessionId) this.#subscribed.delete(ws);
    if (!entry) return { ok: false, reason: "La sesión ya no está activa" };
    entry.clients.delete(ws);
    this.#onChange();
    return { ok: true };
  }

  /**
   * El audio sólo viaja a la sesión que el WS tiene asignada, y sólo si es el owner.
   * Es el punto donde se garantiza que el audio de A nunca alcanza el pipeline de B.
   */
  pushAudio(ws: WebSocket, clientId: string, chunk: Buffer): ActionResult {
    const id = this.#subscribed.get(ws);
    if (!id) return { ok: false, reason: "No estás suscripto a ninguna sesión" };
    const entry = this.#sessions.get(id);
    if (!entry || entry.closing) return { ok: false, reason: "La sesión ya no está activa" };
    if (entry.ownerClientId !== clientId) {
      if (DEBUG) {
        console.log(
          `[audio][denegado] sesion=${id.slice(0, 8)} ws=${clientId.slice(0, 8)} owner=${String(entry.ownerClientId).slice(0, 8)} clientes=${entry.clients.size}`,
        );
      }
      return { ok: false, reason: "Sólo el owner de la sesión puede enviar audio" };
    }
    entry.lastActivityAt = this.#now();
    entry.transcriber?.sendAudio(chunk);
    return { ok: true };
  }

  endTurn(ws: WebSocket): ActionResult {
    const id = this.#subscribed.get(ws);
    if (!id) return { ok: false, reason: "No estás suscripto a ninguna sesión" };
    const entry = this.#sessions.get(id);
    if (!entry || entry.closing) return { ok: false, reason: "La sesión ya no está activa" };
    entry.transcriber?.endTurn();
    return { ok: true };
  }

  /** Cierre explícito. Sólo el owner puede cerrar su sesión. */
  stop(ws: WebSocket, clientId: string, sessionId?: string): ActionResult {
    const id = sessionId ?? this.#subscribed.get(ws);
    if (!id) return { ok: false, reason: "No estás suscripto a ninguna sesión" };
    const entry = this.#sessions.get(id);
    if (!entry || entry.closing) return { ok: false, reason: "La sesión ya no está activa" };
    if (entry.ownerClientId !== clientId) {
      return { ok: false, reason: "Sólo el owner puede cerrar la sesión" };
    }
    this.close(id, "stopped");
    return { ok: true };
  }

  /**
   * Baja de sesión. Idempotente y libre de carreras: el flag `closing` hace que un
   * doble cierre sea un no-op, y la entrada sale del mapa antes de tocar Gemini para
   * que ningún callback tardío pueda emitir hacia clientes de otras sesiones.
   */
  close(id: string, reason: string): boolean {
    const entry = this.#sessions.get(id);
    if (!entry || entry.closing) return false;
    entry.closing = true;
    this.#cancelGrace(entry);
    this.#sessions.delete(id);

    for (const ws of entry.clients) {
      if (this.#subscribed.get(ws) === id) this.#subscribed.delete(ws);
      this.#send(ws, { type: "sessionEnded", sessionId: id, reason });
    }
    entry.clients.clear();

    const transcriber = entry.transcriber;
    entry.transcriber = null;
    if (DEBUG) console.log(`[sessions][${id.slice(0, 8)}] cerrada (${reason})`);
    transcriber?.close();

    this.#onChange();
    return true;
  }

  #cancelGrace(entry: SessionEntry): void {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.graceUntil = null;
  }

  /**
   * El owner se fue. Se concede una ventana de gracia para que un refresh de pestaña
   * no corte la sesión; si nadie recupera ownership, se cierra aunque queden
   * suscriptores (sin owner no hay audio posible).
   */
  #startGrace(entry: SessionEntry): void {
    if (entry.closing) return;
    entry.ownerClientId = null;
    if (this.#graceMs <= 0) {
      this.close(entry.id, "owner-disconnected");
      return;
    }
    this.#cancelGrace(entry);
    entry.graceUntil = this.#now() + this.#graceMs;
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      this.close(entry.id, "owner-timeout");
    }, this.#graceMs);
    entry.graceTimer.unref?.();
    this.#onChange();
  }

  /**
   * Baja quirúrgica de un cliente: lo saca de las sesiones donde estaba y, si era el
   * owner de una, dispara el grace period de ESA sesión. Las demás no se tocan.
   */
  removeClient(ws: WebSocket, clientId: string): void {
    const subscribed = this.#subscribed.get(ws);
    this.#subscribed.delete(ws);

    let orphanedEntry: SessionEntry | undefined;
    for (const entry of this.#sessions.values()) {
      entry.clients.delete(ws);
      if (entry.ownerClientId === clientId) orphanedEntry = entry;
    }

    if (orphanedEntry && !orphanedEntry.closing) {
      this.#startGrace(orphanedEntry);
    } else {
      this.#onChange();
    }
  }

  /** Cierra todas las sesiones (shutdown del proceso). */
  closeAll(reason: string): void {
    for (const id of [...this.#sessions.keys()]) this.close(id, reason);
  }
}

export type { StatusInfo };
