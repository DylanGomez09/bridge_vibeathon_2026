import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeConfig } from "../config.js";
import { Transcriber, type TranscriberCallbacks } from "../gemini/transcriber.js";
import { SessionRegistry, type SessionMeta } from "../sessions/registry.js";
import { friendlySessionError } from "../errors.js";

const DEBUG = process.env.BRIDGE_DEBUG === "1";

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

interface ClientMessage {
  type?: string;
  sessionId?: string;
  label?: string;
  sourceLang?: string;
  targetLang?: string;
  ownerToken?: string;
  reclaimSessionId?: string;
}

export interface WsRegistry {
  readonly registry: SessionRegistry;
  broadcastSessions: () => void;
}

export function registerWsHandlers(wss: WebSocketServer, config: BridgeConfig): WsRegistry {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  const sendTo = (ws: WebSocket, payload: unknown): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      if (DEBUG) console.error("[ws-relay] send falló", error);
    }
  };

  const broadcastSessions = (): void => {
    const sessions: SessionMeta[] = registry.list();
    const payload = { type: "sessions", sessions };
    for (const client of wss.clients) sendTo(client, payload);
  };

  const registry = new SessionRegistry({
    config,
    maxSessions: config.maxSessions,
    graceMs: config.sessionGraceMs,
    createTranscriber: (sessionConfig, callbacks: TranscriberCallbacks) =>
      new Transcriber(ai, sessionConfig, callbacks),
    send: sendTo,
    onChange: broadcastSessions,
  });

  wss.on("connection", (ws) => {
    const clientId = randomUUID();
    const startMs = Date.now();
    let audioErrorNotified = false;

    const send = (payload: unknown): void => {
      if (DEBUG) {
        const p = payload as
          | { type?: string; phase?: string; sessionId?: string; text?: string }
          | null;
        const short = p?.sessionId ? `[${p.sessionId.slice(0, 8)}]` : "";
        const text = p?.text ? ` "${p.text.slice(0, 120)}${p.text.length > 120 ? "…" : ""}"` : "";
        console.log(
          `[ws-relay][T+${Date.now() - startMs}ms]${short} ->`,
          `${p?.type ?? "?"}${p?.phase ? `/${p.phase}` : ""}${text}`,
        );
      }
      sendTo(ws, payload);
    };

    const fail = (detail: string): void => {
      send({ type: "status", phase: "error", sessionId: registry.subscribedSessionId(ws), detail });
    };

    send({ type: "hello", clientId, sessions: registry.list() });

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          // El audio se rutea exclusivamente a la sesión de este cliente. Si no es el
          // owner, el registro lo rechaza: así el audio de A nunca llega al pipeline de B.
          const result = registry.pushAudio(ws, clientId, toBuffer(data));
          if (result.ok) {
            // Un rechazo transitorio no puede dejar el error pegado para siempre: si
            // el audio vuelve a pasar, el próximo fallo vuelve a avisar.
            audioErrorNotified = false;
          } else if (!audioErrorNotified) {
            audioErrorNotified = true;
            fail(result.reason);
          }
          return;
        }

        let message: ClientMessage;
        try {
          message = JSON.parse(data.toString()) as ClientMessage;
        } catch {
          fail("Mensaje inválido del cliente");
          return;
        }

        switch (message.type) {
          case "start": {
            if (!config.geminiApiKey) {
              fail(
                "Gemini no está configurado: revisá la GEMINI_API_KEY en backend/.env",
              );
              return;
            }
            const result = registry.create({
              owner: ws,
              ownerClientId: clientId,
              label: message.label,
              sourceLang: message.sourceLang,
              targetLang: message.targetLang,
              reclaim:
                message.ownerToken && message.reclaimSessionId
                  ? { sessionId: message.reclaimSessionId, ownerToken: message.ownerToken }
                  : undefined,
            });
            if (!result.ok) {
              fail(result.reason);
              return;
            }
            const { entry, ownerToken } = result;
            // ACK primero: el cliente resuelve el arranque con este mensaje.
            send({
              type: "started",
              sessionId: entry.id,
              ownerToken,
              meta: registry.meta(entry.id),
            });
            registry.connect(entry.id);
            return;
          }

          case "subscribe": {
            if (!message.sessionId) {
              fail("Falta el sessionId para suscribirse");
              return;
            }
            const result = registry.subscribe(ws, clientId, message.sessionId);
            if (!result.ok) {
              fail(result.reason);
              return;
            }
            send({
              type: "subscribed",
              sessionId: message.sessionId,
              meta: registry.meta(message.sessionId),
              // Gemini no permite recuperar historial: sólo entra lo que se diga de aquí
              // en adelante. Se avisa explícito para que la UI no prometa un replay.
              replayed: false,
            });
            return;
          }

          case "unsubscribe": {
            const target = message.sessionId ?? registry.subscribedSessionId(ws);
            if (!target) return;
            registry.unsubscribe(ws, target);
            send({ type: "unsubscribed", sessionId: target });
            return;
          }

          case "sessions": {
            send({ type: "sessions", sessions: registry.list() });
            return;
          }

          case "end": {
            const result = registry.endTurn(ws);
            if (!result.ok) fail(result.reason);
            return;
          }

          case "stop": {
            const result = registry.stop(ws, clientId, message.sessionId);
            if (!result.ok) fail(result.reason);
            return;
          }

          default:
            fail("Tipo de mensaje desconocido");
        }
      } catch (error) {
        // Aislamiento: un error en una sesión jamás tumba el proceso ni otras sesiones.
        if (DEBUG) console.error("[ws-relay] error en sesión", error);
        fail(friendlySessionError(error, "La sesión tuvo un error interno"));
      }
    });

    ws.on("close", () => {
      registry.removeClient(ws, clientId);
    });
    ws.on("error", (error) => {
      if (DEBUG) console.error("[ws-relay] ws error", error);
      registry.removeClient(ws, clientId);
    });
  });

  return { registry, broadcastSessions };
}
