import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { registerWsHandlers } from "./ws/handler.js";

const config = loadConfig();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bridge-backend",
    hasGeminiKey: Boolean(config.geminiApiKey),
    geminiLiveModel: config.geminiLiveModel,
    bridge: {
      responseModality: config.bridgeResponseModality,
      sourceLang: config.bridgeSourceLang,
      targetLang: config.bridgeTargetLang,
    },
  });
});

registerWsHandlers(wss, config);

server.listen(config.port, () => {
  console.log(`[bridge] backend escuchando en http://localhost:${config.port}`);
  if (!config.geminiApiKey) {
    console.warn(
      "[bridge] GEMINI_API_KEY vacía: copiá backend/.env.example a backend/.env y pegá tu key.",
    );
  }
});