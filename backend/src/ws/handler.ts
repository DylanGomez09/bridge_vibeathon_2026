import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { Transcriber } from "../gemini/transcriber.js";

interface Send {
  send: (payload: unknown) => void;
}

const DEBUG = process.env.BRIDGE_DEBUG === "1";

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function registerWsHandlers(wss: WebSocketServer, config: BridgeConfig): void {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  wss.on("connection", (ws) => {
    let transcriber: Transcriber | null = null;
    let starting = false;
    const startMs = Date.now();

    const send: Send["send"] = (payload) => {
      if (DEBUG) {
        const p = payload as { type?: string; phase?: string; text?: string } | null;
        const text = p?.text ? ` "${p.text.slice(0, 120)}${p.text.length > 120 ? "…" : ""}"` : "";
        console.log(
          `[ws-relay][T+${Date.now() - startMs}ms] ->`,
          `${p?.type ?? "?"}${p?.phase ? `/${p.phase}` : ""}${text}`,
        );
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    const stop = (): void => {
      transcriber?.close();
      transcriber = null;
      starting = false;
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!transcriber) return;
        transcriber.sendAudio(toBuffer(data));
        return;
      }

      let message: { type?: string };
      try {
        message = JSON.parse(data.toString()) as { type?: string };
      } catch {
        send({ type: "status", phase: "error", detail: "JSON inválido en el mensaje" });
        return;
      }

      switch (message.type) {
        case "start":
          if (transcriber || starting) {
            send({ type: "status", phase: "error", detail: "Sesión ya activa" });
            return;
          }
          if (!config.geminiApiKey) {
            send({
              type: "status",
              phase: "error",
              detail: "GEMINI_API_KEY no configurada en backend/.env",
            });
            return;
          }
          starting = true;
          transcriber = new Transcriber(ai, config, {
            onStatus: (phase, detail) => {
              send({ type: "status", phase, detail });
              if (phase === "ended" || phase === "error") stop();
            },
            onInputInterim: (text) => send({ type: "original", text, interim: true }),
            onInput: (text) => send({ type: "original", text, interim: false }),
            onTranslation: (text) => send({ type: "translation", text }),
            onTurnComplete: () => send({ type: "segment" }),
            onError: (detail) => send({ type: "status", phase: "error", detail }),
            onClose: () => undefined,
          });
          transcriber.connect().catch((error: Error) => {
            transcriber = null;
            starting = false;
            send({
              type: "status",
              phase: "error",
              detail: error instanceof Error ? error.message : String(error),
            });
          });
          break;

        case "end":
          transcriber?.endTurn();
          break;

        case "stop":
          stop();
          send({ type: "status", phase: "ended" });
          break;

        default:
          send({ type: "status", phase: "error", detail: "Tipo de mensaje desconocido" });
      }
    });

    ws.on("close", () => stop());
    ws.on("error", () => stop());
  });
}