import http from "node:http";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { registerWsHandlers } from "./ws/handler.js";
import { generateVideoSubtitles, parseTargetLang } from "./video/subtitles.js";

const config = loadConfig();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const { registry } = registerWsHandlers(wss, config);

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const formatBytes = (bytes: number): string => {
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
};

const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
]);

const safeDecodeFileName = (raw: string | undefined): string => {
  if (!raw) return "video.mp4";
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded || "video.mp4";
  } catch {
    return "video.mp4";
  }
};

const CORS_ALLOW_METHODS = "POST, OPTIONS";
const CORS_ALLOW_HEADERS = "content-type, x-file-name";

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
  }
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

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
    video: {
      model: config.videoModel,
      maxSeconds: config.videoMaxSeconds,
      maxBytes: config.videoMaxBytes,
    },
  });
});

const videoRaw = express.raw({
  type: [...VIDEO_MIME_TYPES],
  limit: config.videoMaxBytes,
});

app.post("/api/video/subtitles", videoRaw, async (req, res) => {
  const targetLang = parseTargetLang(
    typeof req.query.lang === "string" ? req.query.lang : undefined,
  );
  if (!targetLang) {
    res.status(400).json({
      ok: false,
      error: 'El idioma de subtítulos debe ser "es" o "en".',
    });
    return;
  }

  if (!config.geminiApiKey) {
    res.status(503).json({
      ok: false,
      error: "Gemini no está configurado: revisá la GEMINI_API_KEY en backend/.env",
    });
    return;
  }

  const mimeType = (req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!VIDEO_MIME_TYPES.has(mimeType)) {
    res.status(415).json({
      ok: false,
      error: `Formato de video no soportado: ${mimeType || "desconocido"}. Usá MP4, MOV, WebM o MKV.`,
    });
    return;
  }

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ ok: false, error: "No se recibió ningún archivo de video." });
    return;
  }

  const fileName = safeDecodeFileName(req.get("x-file-name"));
  const startedAt = Date.now();
  if (process.env.BRIDGE_DEBUG === "1") {
    console.log(
      `[video] job recibido ${fileName} · ${(body.length / 1_048_576).toFixed(1)}MB · ${mimeType} → ${targetLang}`,
    );
  }

  try {
    const result = await generateVideoSubtitles({
      ai,
      model: config.videoModel,
      timeoutMs: config.videoTimeoutMs,
      data: body,
      mimeType,
      fileName,
      targetLang,
      maxSeconds: config.videoMaxSeconds,
    });
    if (process.env.BRIDGE_DEBUG === "1") {
      console.log(
        `[video] job listo ${fileName} · ${result.cues.length} cues · ${Date.now() - startedAt}ms`,
      );
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudieron generar los subtítulos del video.";
    if (process.env.BRIDGE_DEBUG === "1") {
      console.error(`[video] job fallido ${fileName} tras ${Date.now() - startedAt}ms`, message);
    }
    res.status(502).json({ ok: false, error: message });
  }
});

app.use((error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((error as { type?: string }).type === "entity.too.large") {
    res.status(413).json({
      ok: false,
      error: `El video supera el límite de ${formatBytes(config.videoMaxBytes)}.`,
    });
    return;
  }
  next(error);
});

server.listen(config.port, () => {
  console.log(`[bridge] backend escuchando en http://localhost:${config.port}`);
  if (!config.geminiApiKey) {
    console.warn(
      "[bridge] GEMINI_API_KEY vacía: copiá backend/.env.example a backend/.env y pegá tu key.",
    );
  }
  console.log(
    `[bridge] subtítulos de video con ${config.videoModel} (máx ${Math.round(config.videoMaxSeconds / 60)}min / ${formatBytes(config.videoMaxBytes)})`,
  );
  console.log(`[bridge] orígenes CORS permitidos: ${config.corsOrigins.join(", ") || "(ninguno)"}`);
});

server.requestTimeout = config.videoTimeoutMs + 60_000;
server.headersTimeout = config.videoTimeoutMs + 60_000;

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