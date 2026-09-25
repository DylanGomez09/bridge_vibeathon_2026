import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { registerWsHandlers } from "./ws/handler.js";

const config = loadConfig();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const { registry } = registerWsHandlers(wss, config);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bridge-backend",
    hasGeminiKey: Boolean(config.geminiApiKey),
    geminiLiveModel: config.geminiLiveModel,
    activeSessions: registry.size,
    sessions: registry.list(),
    bridge: {
      responseModality: config.bridgeResponseModality,
      sourceLang: config.bridgeSourceLang,
      targetLang: config.bridgeTargetLang,
      maxSessions: config.maxSessions,
      sessionGraceMs: config.sessionGraceMs,
    },
  });
});

server.listen(config.port, () => {
  console.log(`[bridge] backend escuchando en http://localhost:${config.port}`);
  if (!config.geminiApiKey) {
    console.warn(
      "[bridge] GEMINI_API_KEY vacía: copiá backend/.env.example a backend/.env y pegá tu key.",
    );
  }
});

// tsx watch reinicia el proceso en cada guardado: el proceso viejo puede seguir
// ocupando 3001 unos milisegundos. Reintentamos el bind con backoff corto en vez
// de morir, así el backend nuevo entra solo y nunca queda un hueco sin relay.
const BIND_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 3000];
let bindAttempt = 0;
let shuttingDown = false;
let lastBindError: NodeJS.ErrnoException | null = null;

// El WebSocketServer se crea con { server }, así que re-emite en su propio evento
// "error" exactamente el mismo objeto Error que emite el http.Server. Deduplicamos
// por identidad para no gastar dos intentos de reintento por el mismo fallo.
const onBindError = (error: NodeJS.ErrnoException) => {
  if (error === lastBindError) return;
  lastBindError = error;
  if (error.code === "EADDRINUSE" && bindAttempt < BIND_RETRY_DELAYS_MS.length) {
    const delay = BIND_RETRY_DELAYS_MS[bindAttempt];
    bindAttempt += 1;
    console.warn(
      `[bridge] puerto ${config.port} ocupado por el proceso anterior; reintento en ${delay}ms ` +
        `(${bindAttempt}/${BIND_RETRY_DELAYS_MS.length})`,
    );
    setTimeout(() => {
      if (!shuttingDown) server.listen(config.port);
    }, delay);
    return;
  }
  console.error(`[bridge] no se pudo escuchar en el puerto ${config.port}:`, error.message);
  process.exit(1);
};

server.on("error", onBindError);
wss.on("error", onBindError);

// Salida limpia: terminamos los sockets WS y cerramos el server (que suelta el
// listener de 3001 al instante) para que el siguiente proceso pueda bindear ya.
const shutdown = (signal: string, code: number) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bridge] ${signal} recibido: liberando puerto ${config.port}…`);
  registry.closeAll("server-shutdown");
  const force = setTimeout(() => process.exit(code), 3000);
  force.unref();
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close(() => {
    clearTimeout(force);
    console.log(`[bridge] puerto ${config.port} liberado. Saliendo.`);
    process.exit(code);
  });
};

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));