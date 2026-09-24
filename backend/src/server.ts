import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";

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
  });
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", service: "bridge-backend" }));
});

server.listen(config.port, () => {
  console.log(`[bridge] backend escuchando en http://localhost:${config.port}`);
  if (!config.geminiApiKey) {
    console.warn(
      "[bridge] GEMINI_API_KEY vacía: copiá backend/.env.example a backend/.env y pegá tu key.",
    );
  }
});