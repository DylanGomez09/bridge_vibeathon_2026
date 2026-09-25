import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { Transcriber, type StatusPhase, type StatusInfo } from "../gemini/transcriber.js";
import { friendlySessionError } from "../errors.js";

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
        const p = payload as
          | { type?: string; phase?: string; attempt?: number; detail?: string; text?: string }
          | null;
        const text = p?.text ? ` "${p.text.slice(0, 120)}${p.text.length > 120 ? "…" : ""}"` : "";
        console.log(
          `[ws-relay][T+${Date.now() - startMs}ms] ->`,
          `${p?.type ?? "?"}${p?.phase ? `/${p.phase}` : ""}${p?.attempt ? ` (intento ${p.attempt})` : ""}${text}`,
        );
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        if (DEBUG) console.error("[ws-relay] send falló", error);
      }
    };

    const stop = (): void => {
      const current = transcriber;
      transcriber = null;
      starting = false;
      current?.close();
    };

    const onStatus = (phase: StatusPhase, detail?: string, info?: StatusInfo): void => {
      send({ type: "status", phase, detail, ...(info ?? {}) });
      if (phase === "ended" || phase === "failed") stop();
    };

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          if (!transcriber) return;
          transcriber.sendAudio(toBuffer(data));
          return;
        }

        let message: { type?: string };
        try {
          message = JSON.parse(data.toString()) as { type?: string };
        } catch {
          send({ type: "status", phase: "error", detail: "Mensaje inválido del cliente" });
          return;
        }

        switch (message.type) {
          case "start":
            if (transcriber || starting) {
              send({ type: "status", phase: "error", detail: "La sesión ya está activa" });
              return;
            }
            if (!config.geminiApiKey) {
              send({
                type: "status",
                phase: "error",
                detail: "Gemini no está configurado: revisá la GEMINI_API_KEY en backend/.env",
              });
              return;
            }
            starting = true;
            send({ type: "started" });
            transcriber = new Transcriber(ai, config, {
              onStatus,
              onInputInterim: (text) => send({ type: "original", text, interim: true }),
              onInput: (text) => send({ type: "original", text, interim: false }),
              onTranslation: (text) => send({ type: "translation", text }),
              onTurnComplete: () => send({ type: "segment" }),
              onError: (detail) => {
                if (DEBUG) console.log("[ws-relay][transcriber-error]", detail);
              },
              onClose: (code, reason) => {
                if (DEBUG) console.log(`[ws-relay][transcriber-close] ${code} ${reason ?? ""}`);
              },
            });
            transcriber.connect().catch((error: unknown) => {
              // Un fallo terminal ya fue notificado por onStatus("failed"/"ended").
              if (DEBUG) {
                console.log(
                  "[ws-relay] connect() terminó sin sesión:",
                  error instanceof Error ? error.message : String(error),
                );
              }
              stop();
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
      } catch (error) {
        // Aislamiento: un error en esta sesión jamás tumba el proceso ni otras sesiones.
        if (DEBUG) console.error("[ws-relay] error en sesión", error);
        send({
          type: "status",
          phase: "failed",
          detail: friendlySessionError(error, "La sesión tuvo un error interno"),
        });
        stop();
      }
    });

    ws.on("close", () => stop());
    ws.on("error", (error) => {
      if (DEBUG) console.error("[ws-relay] ws error", error);
      stop();
    });
  });
}