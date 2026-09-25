import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveConnectConfig, LiveServerMessage, Session } from "@google/genai";
import { buildInterpreterSystemInstruction } from "./prompts.js";
import type { BridgeConfig } from "../config.js";

export type StatusPhase = "connecting" | "ready" | "ended" | "error";

export interface TranscriberCallbacks {
  onStatus?: (phase: StatusPhase, detail?: string) => void;
  onInputInterim?: (text: string) => void;
  onInput?: (text: string) => void;
  onTranslation?: (text: string) => void;
  onTurnComplete?: () => void;
  onError?: (message: string) => void;
  onClose?: (code: number, reason: string) => void;
}

const PCM_MIME = "audio/pcm;rate=16000";
const MIN_CHUNK_INTERVAL_MS = 15;
const DEBUG = process.env.BRIDGE_DEBUG === "1";

export class Transcriber {
  private session: Session | null = null;
  private queue: Buffer[] = [];
  private pumping = false;
  private lastSentAt = 0;
  private accumulatedOutput = "";
  private ended = false;
  private receivedChunks = 0;
  private receivedBytes = 0;
  private readonly startMs = Date.now();
  private lastCountLogAt = 0;

  private dbg(...args: unknown[]): void {
    if (DEBUG) console.log(`[tscriber-verbose][+${Date.now() - this.startMs}ms]`, ...args);
  }

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly config: BridgeConfig,
    private readonly callbacks: TranscriberCallbacks = {},
  ) {}

  async connect(): Promise<void> {
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

    this.callbacks.onStatus?.("connecting");
    this.dbg(
      "connecting a Gemini Live (model:",
      this.config.geminiLiveModel,
      ", modality:",
      modality,
      ")",
    );
    this.session = await this.ai.live.connect({
      model: this.config.geminiLiveModel,
      config: liveConfig,
      callbacks: {
        onopen: () => this.dbg("socket Gemini abierto"),
        onmessage: (message) => this.handleMessage(message),
        onerror: (error) => {
          const detail = `${error?.message ?? "error desconocido"} (${error?.type ?? "tipo desconocido"})`;
          this.dbg("socket Gemini onerror:", detail);
          this.callbacks.onError?.(detail);
          this.callbacks.onStatus?.("error", detail);
        },
        onclose: (event) => {
          const detail = `close ${event.code}${event.reason ? ` — ${event.reason}` : ""}`;
          this.dbg("socket Gemini onclose:", event.code, event.reason ?? "");
          if (!this.ended) this.callbacks.onStatus?.("ended", detail);
          this.callbacks.onClose?.(event.code, event.reason ?? "");
        },
      },
    });
    this.dbg("session Gemini establecida");
  }

  sendAudio(data: Buffer): void {
    const chunkIndex = this.receivedChunks + 1;
    this.receivedChunks += 1;
    this.receivedBytes += data.length;
    if (chunkIndex === 1) {
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
    if (!this.session) {
      this.queue.push(data);
      return;
    }
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
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  close(): void {
    this.ended = true;
    this.queue = [];
    try {
      this.session?.close();
    } catch {
      // la sesión ya está cerrada
    }
    this.session = null;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;

    const drain = (): void => {
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
        setTimeout(drain, wait);
        return;
      }
      const chunk = this.queue.shift();
      if (!chunk) {
        this.pumping = false;
        return;
      }
      this.lastSentAt = Date.now();
      this.session.sendRealtimeInput({
        audio: { data: chunk.toString("base64"), mimeType: PCM_MIME },
      });
      drain();
    };

    drain();
  }

  private handleMessage(message: LiveServerMessage): void {
    if (message.setupComplete) {
      this.dbg(">> setupComplete (sesión lista)");
      this.callbacks.onStatus?.("ready");
      this.pump();
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
        this.accumulatedOutput = this.mergeText(this.accumulatedOutput, textParts.join(""));
      }
    }
    if (this.accumulatedOutput) {
      this.callbacks.onTranslation?.(this.accumulatedOutput);
    }

    if (content.turnComplete) {
      this.accumulatedOutput = "";
      this.callbacks.onTurnComplete?.();
    }
  }

  private mergeText(previous: string, incoming: string): string {
    if (!previous) return incoming;
    if (incoming.startsWith(previous)) return incoming;
    if (previous.startsWith(incoming)) return previous;
    return previous + incoming;
  }
}