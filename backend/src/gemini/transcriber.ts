import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveConnectConfig, LiveServerMessage, Session } from "@google/genai";
import { buildInterpreterSystemInstruction } from "./prompts.js";
import { friendlyError } from "../errors.js";
import type { BridgeConfig } from "../config.js";

export type StatusPhase = "connecting" | "ready" | "reconnecting" | "failed" | "ended";

export interface StatusInfo {
  attempt?: number;
  maxAttempts?: number;
  code?: number;
  reason?: string;
}

export interface TranscriberCallbacks {
  onStatus?: (phase: StatusPhase, detail?: string, info?: StatusInfo) => void;
  onInputInterim?: (text: string) => void;
  onInput?: (text: string) => void;
  onTranslation?: (text: string) => void;
  onTurnComplete?: () => void;
  onError?: (message: string) => void;
  onClose?: (code: number, reason: string) => void;
}

type AttemptResult = { ok: true } | { ok: false; detail: string };
type Settle = (result: AttemptResult) => void;

interface CloseLike {
  code: number;
  reason?: string;
}

const PCM_MIME = "audio/pcm;rate=16000";
const MIN_CHUNK_INTERVAL_MS = 15;
const STALE_CHECK_MS = 5000;
const DEBUG = process.env.BRIDGE_DEBUG === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Transcriber {
  private session: Session | null = null;
  private queue: Buffer[] = [];
  private pumping = false;
  private lastSentAt = 0;
  private accumulatedOutput = "";
  private ended = false;
  private disposed = false;
  private ready = false;
  private connecting = false;
  private reconnectRunning = false;
  private receivedChunks = 0;
  private receivedBytes = 0;
  private readonly startMs = Date.now();
  private lastCountLogAt = 0;
  private lastActivityAt = 0;
  private lastAudioSentAt = 0;

  private reconnectAttempts = 0;
  private attemptSettle: Settle | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  private readonly reconAttempts: number;
  private readonly reconBaseDelayMs: number;
  private readonly readyTimeoutMs: number;
  private readonly staleSessionMs: number;

  private dbg(...args: unknown[]): void {
    if (DEBUG) console.log(`[tscriber-verbose][+${Date.now() - this.startMs}ms]`, ...args);
  }

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly config: BridgeConfig,
    private readonly callbacks: TranscriberCallbacks = {},
  ) {
    this.reconAttempts = config.reconnectMaxAttempts;
    this.reconBaseDelayMs = config.reconnectBaseDelayMs;
    this.readyTimeoutMs = config.readyTimeoutMs;
    this.staleSessionMs = config.staleSessionMs;
  }

  async connect(): Promise<void> {
    this.callbacks.onStatus?.("connecting");
    return this.run({ initial: true });
  }

  sendAudio(data: Buffer): void {
    this.receivedChunks += 1;
    this.receivedBytes += data.length;
    if (this.receivedChunks === 1) {
      this.dbg("primer chunk recibido del client (chunk 1,", data.length, "bytes)");
    }
    const now = Date.now();
    if (now - this.lastCountLogAt >= 10_000) {
      this.lastCountLogAt = now;
      this.dbg(
        "recuento: chunks recibidos del client:",
        this.receivedChunks,
        " bytes:",
        this.receivedBytes,
      );
    }
    this.lastAudioSentAt = now;
    this.queue.push(data);
    this.pump();
  }

  endTurn(): void {
    this.dbg(
      ">> audioStreamEnd (chunks recibidos del client:",
      this.receivedChunks,
      " bytes:",
      this.receivedBytes,
      ")",
    );
    const result = this.session?.sendRealtimeInput({ audioStreamEnd: true });
    this.trackSent(result);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ended = true;
    this.queue = [];
    this.cancelAllTimers();
    this.cleanupSession();
  }

  private run(opts: { initial: boolean }): Promise<void> {
    return (async () => {
      while (!this.ended && !this.disposed) {
        const outcome = await this.attemptConnect();
        if (outcome.ok) {
          this.reconnectAttempts = 0;
          return;
        }
        this.cleanupSession();
        if (this.ended || this.disposed) break;
        if (this.reconAttempts === 0 || this.reconnectAttempts >= this.reconAttempts) {
          this.fail(outcome.detail);
        }
        this.reconnectAttempts += 1;
        const delay = this.reconBaseDelayMs * 2 ** (this.reconnectAttempts - 1);
        this.callbacks.onStatus?.("reconnecting", undefined, {
          attempt: this.reconnectAttempts,
          maxAttempts: this.reconAttempts,
        });
        this.dbg(
          `reintento en ${delay}ms (${this.reconnectAttempts}/${this.reconAttempts}) ← ${outcome.detail}`,
        );
        await sleep(delay);
      }
      if (opts.initial && !this.ended && !this.disposed) {
        this.callbacks.onStatus?.("ended", "La sesión se cerró antes de estar lista");
      }
    })();
  }

  private attemptConnect(): Promise<AttemptResult> {
    if (this.ended || this.disposed) {
      return Promise.resolve({ ok: false, detail: "Sesión cerrada" });
    }
    this.connecting = true;
    this.ready = false;

    return new Promise<AttemptResult>((resolve) => {
      let settled = false;
      const settle: Settle = (result) => {
        if (settled) return;
        settled = true;
        this.connecting = false;
        this.attemptSettle = null;
        resolve(result);
      };
      this.attemptSettle = settle;

      const dropSession = (): void => {
        try {
          this.session?.close();
        } catch {
          // la sesión ya está cerrada
        }
        this.session = null;
      };

      try {
        this.dbg(
          "conectando a Gemini Live (model:",
          this.config.geminiLiveModel,
          ", modality:",
          this.config.bridgeResponseModality,
          ")",
        );
        const liveConfig = this.buildLiveConfig();
        this.ai.live
          .connect({
            model: this.config.geminiLiveModel,
            config: liveConfig,
            callbacks: {
              onopen: () => this.dbg("socket Gemini abierto"),
              onmessage: (message) => this.handleMessage(message),
              onerror: (error) => this.handleSocketError(settle, error),
              onclose: (event) => this.handleSocketClose(settle, event),
            },
          })
          .then((session) => {
            if (this.disposed || this.ended) {
              dropSession();
              settle({ ok: false, detail: "Sesión cerrada" });
              return;
            }
            this.session = session;
            if (this.readyTimeoutMs > 0) {
              this.readyTimer = setTimeout(() => {
                this.readyTimer = null;
                if (this.ready) return;
                const settleReady = this.attemptSettle;
                if (!settleReady) return;
                settleReady({
                  ok: false,
                  detail: "Timeout esperando la confirmación de Gemini",
                });
                dropSession();
              }, this.readyTimeoutMs);
            }
          })
          .catch((cause) => {
            dropSession();
            settle({
              ok: false,
              detail: cause instanceof Error ? cause.message : String(cause),
            });
          });
      } catch (cause) {
        settle({
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  }

  private buildLiveConfig(): LiveConnectConfig {
    const modality =
      this.config.bridgeResponseModality === "audio" ? Modality.AUDIO : Modality.TEXT;

    const liveConfig: LiveConnectConfig = {
      responseModalities: [modality],
      systemInstruction: {
        parts: [
          {
            text: buildInterpreterSystemInstruction(
              this.config.bridgeSourceLang,
              this.config.bridgeTargetLang,
            ),
          },
        ],
      },
      inputAudioTranscription: {
        languageCodes: [this.config.bridgeSourceLang],
      },
    };

    if (modality === Modality.AUDIO) {
      liveConfig.outputAudioTranscription = {
        languageCodes: [this.config.bridgeTargetLang],
      };
      liveConfig.speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: this.config.geminiLiveVoice },
        },
      };
    }

    return liveConfig;
  }

  private handleUnexpectedClose(detail: string): void {
    if (this.ended || this.disposed || this.connecting || this.reconnectRunning) return;
    this.dbg("cierre inesperado → reconectando:", detail);
    this.reconnectRunning = true;
    this.cleanupSession();
    this.cancelAllTimers();
    this.callbacks.onStatus?.("reconnecting", undefined, {
      attempt: this.reconnectAttempts,
      maxAttempts: this.reconAttempts,
    });
    this.run({ initial: false })
      .catch((error: unknown) => {
        this.dbg("reconexión terminó:", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.reconnectRunning = false;
      });
  }

  private fail(detail: string): never {
    this.ended = true;
    this.cleanupSession();
    this.cancelAllTimers();
    const message = friendlyError(detail, "No se pudo restablecer la sesión.");
    this.callbacks.onStatus?.("failed", message);
    throw Object.assign(new Error(message), { code: "SESSION_FAILED" });
  }

  private handleSocketError(settleForAttempt: Settle, error: unknown): void {
    const raw = error as { message?: string; type?: string } | null;
    const detail = `${raw?.message ?? "error desconocido"}${raw?.type ? ` (${raw.type})` : ""}`;
    this.dbg("socket Gemini onerror:", detail);
    this.callbacks.onError?.(friendlyError(detail, "Se perdió la conexión con Gemini."));
    this.handleSocketClose(settleForAttempt, { code: 1011, reason: "" });
  }

  private handleSocketClose(settleForAttempt: Settle | null, event: CloseLike): void {
    const detail = `close ${event.code}${event.reason ? ` — ${event.reason}` : ""}`;
    this.dbg("socket Gemini onclose:", event.code, event.reason ?? "");
    this.callbacks.onClose?.(event.code, event.reason ?? "");

    const pending = this.attemptSettle;
    if (pending && settleForAttempt && pending === settleForAttempt) {
      this.cancelReadyTimer();
      pending({ ok: false, detail });
      return;
    }

    if (this.ended || this.disposed) return;
    if (event.code === 1000 || event.code === 1005) {
      this.ended = true;
      this.cleanupSession();
      this.cancelAllTimers();
      this.callbacks.onStatus?.("ended", detail);
      return;
    }
    this.handleUnexpectedClose(detail);
  }

  private cleanupSession(): void {
    this.ready = false;
    try {
      this.session?.close();
    } catch {
      // la sesión ya está cerrada
    }
    this.session = null;
    this.accumulatedOutput = "";
  }

  private cancelAllTimers(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private cancelReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private armStaleWatchdog(): void {
    if (this.staleSessionMs <= 0 || this.staleTimer) return;
    this.staleTimer = setInterval(() => {
      const now = Date.now();
      if (this.ended || this.disposed || !this.ready || !this.session) return;
      const audioActive = now - this.lastAudioSentAt < this.staleSessionMs;
      const noActivity = now - this.lastActivityAt > this.staleSessionMs;
      if (audioActive && noActivity) {
        this.dbg("watchdog: audio fluyendo pero Gemini no responde");
        this.handleUnexpectedClose("Gemini no respondió (sesión colgada)");
      }
    }, STALE_CHECK_MS);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.drain();
  }

  private drain(): void {
    if (!this.session) {
      this.pumping = false;
      return;
    }
    if (this.queue.length === 0) {
      this.pumping = false;
      return;
    }
    const wait = this.lastSentAt + MIN_CHUNK_INTERVAL_MS - Date.now();
    if (wait > 0) {
      setTimeout(() => this.drain(), wait);
      return;
    }
    const chunk = this.queue.shift();
    if (!chunk) {
      this.pumping = false;
      return;
    }
    this.lastSentAt = Date.now();
    const sent = this.session.sendRealtimeInput({
      audio: { data: chunk.toString("base64"), mimeType: PCM_MIME },
    });
    this.trackSent(sent);
    this.drain();
  }

  private trackSent(result: unknown): void {
    if (result && typeof (result as Promise<unknown>)?.catch === "function") {
      (result as Promise<unknown>).catch((error: unknown) => {
        if (DEBUG) {
          console.error(
            "[tscriber] sendRealtimeInput rechazó:",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!this.ended && !this.disposed) {
          this.pumping = false;
          this.handleUnexpectedClose("Se perdió el envío de audio a Gemini");
        }
      });
    }
  }

  private handleMessage(message: LiveServerMessage): void {
    this.lastActivityAt = Date.now();
    try {
      if (message.setupComplete) {
        this.cancelReadyTimer();
        if (!this.ready) {
          this.ready = true;
          this.dbg(">> setupComplete (sesión lista)");
          this.armStaleWatchdog();
          if (this.attemptSettle) this.attemptSettle({ ok: true });
          this.callbacks.onStatus?.("ready");
          this.pump();
        }
        return;
      }

      const content = message.serverContent;
      if (content) {
        this.dbg(">> serverContent", {
          interim: content.interimInputTranscription?.text,
          input: content.inputTranscription?.text,
          output: content.outputTranscription?.text,
          modelTurnText: (content.modelTurn?.parts ?? [])
            .filter((part) => part.text)
            .map((part) => part.text)
            .join(""),
          turnComplete: content.turnComplete ?? false,
          generationComplete: content.generationComplete ?? false,
          interrupted: content.interrupted ?? false,
          waitingForInput: content.waitingForInput ?? false,
        });
      }

      if (!content) return;

      if (content.interimInputTranscription?.text) {
        this.callbacks.onInputInterim?.(content.interimInputTranscription.text);
      }
      if (content.inputTranscription?.text) {
        this.callbacks.onInput?.(content.inputTranscription.text);
      }

      if (this.config.bridgeResponseModality === "audio") {
        if (content.outputTranscription?.text) {
          this.accumulatedOutput = this.mergeText(
            this.accumulatedOutput,
            content.outputTranscription.text,
          );
        }
      } else {
        const textParts = (content.modelTurn?.parts ?? [])
          .filter((part) => part.text)
          .map((part) => part.text);
        if (textParts.length > 0) {
          this.accumulatedOutput = this.mergeText(
            this.accumulatedOutput,
            textParts.join(""),
          );
        }
      }
      if (this.accumulatedOutput) {
        this.callbacks.onTranslation?.(this.accumulatedOutput);
      }

      if (content.turnComplete) {
        this.accumulatedOutput = "";
        this.callbacks.onTurnComplete?.();
      }
    } catch (error) {
      if (DEBUG) console.error("[tscriber] error procesando mensaje de Gemini", error);
    }
  }

  private mergeText(previous: string, incoming: string): string {
    if (!previous) return incoming;
    if (incoming.startsWith(previous)) return incoming;
    if (previous.startsWith(incoming)) return previous;
    return previous + incoming;
  }
}