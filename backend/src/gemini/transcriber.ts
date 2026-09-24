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
const MIN_CHUNK_INTERVAL_MS = 75;

export class Transcriber {
  private session: Session | null = null;
  private queue: Buffer[] = [];
  private pumping = false;
  private lastSentAt = 0;
  private accumulatedOutput = "";
  private ended = false;

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
    this.session = await this.ai.live.connect({
      model: this.config.geminiLiveModel,
      config: liveConfig,
      callbacks: {
        onopen: () => undefined,
        onmessage: (message) => this.handleMessage(message),
        onerror: (error) => {
          const detail = `${error?.message ?? "error desconocido"} (${error?.type ?? "tipo desconocido"})`;
          this.callbacks.onError?.(detail);
          this.callbacks.onStatus?.("error", detail);
        },
        onclose: (event) => {
          const detail = `close ${event.code}${event.reason ? ` — ${event.reason}` : ""}`;
          if (!this.ended) this.callbacks.onStatus?.("ended", detail);
          this.callbacks.onClose?.(event.code, event.reason ?? "");
        },
      },
    });
  }

  sendAudio(data: Buffer): void {
    if (!this.session) {
      this.queue.push(data);
      return;
    }
    this.queue.push(data);
    this.pump();
  }

  endTurn(): void {
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
      this.callbacks.onStatus?.("ready");
      this.pump();
      return;
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interimInputTranscription?.text) {
      this.callbacks.onInputInterim?.(content.interimInputTranscription.text);
    }
    if (content.inputTranscription?.text) {
      this.callbacks.onInput?.(content.inputTranscription.text);
    }

    if (this.config.bridgeResponseModality === "audio") {
      if (content.outputTranscription?.text) {
        this.callbacks.onTranslation?.(content.outputTranscription.text);
      }
    } else {
      const textParts = (content.modelTurn?.parts ?? [])
        .filter((part) => part.text)
        .map((part) => part.text);
      if (textParts.length > 0) {
        this.accumulatedOutput = this.mergeText(this.accumulatedOutput, textParts.join(""));
        this.callbacks.onTranslation?.(this.accumulatedOutput);
      }
    }

    if (content.turnComplete) {
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