import "dotenv/config";

export type ResponseModality = "text" | "audio";

export interface BridgeConfig {
  geminiApiKey: string;
  geminiLiveModel: string;
  geminiLiveVoice: string;
  port: number;
  bridgeResponseModality: ResponseModality;
  bridgeSourceLang: string;
  bridgeTargetLang: string;
  reconnectMaxAttempts: number;
  reconnectBaseDelayMs: number;
  readyTimeoutMs: number;
  staleSessionMs: number;
  maxSessions: number;
  sessionGraceMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const modality = String(env.BRIDGE_RESPONSE_MODALITY ?? "audio").toLowerCase();
  return {
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    geminiLiveModel: env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview",
    geminiLiveVoice: env.GEMINI_LIVE_VOICE ?? "Aoede",
    port: Number(env.PORT ?? 3001),
    bridgeResponseModality: modality === "audio" ? "audio" : "text",
    bridgeSourceLang: String(env.BRIDGE_SOURCE_LANG ?? "en"),
    bridgeTargetLang: String(env.BRIDGE_TARGET_LANG ?? "es"),
    reconnectMaxAttempts: Math.max(0, Number(env.BRIDGE_RECONNECT_MAX_ATTEMPTS ?? 3)),
    reconnectBaseDelayMs: Math.max(0, Number(env.BRIDGE_RECONNECT_BASE_DELAY_MS ?? 1000)),
    readyTimeoutMs: Math.max(0, Number(env.BRIDGE_READY_TIMEOUT_MS ?? 15000)),
    staleSessionMs: Math.max(0, Number(env.BRIDGE_STALE_SESSION_MS ?? 60000)),
    maxSessions: Math.max(1, Number(env.BRIDGE_MAX_SESSIONS ?? 4)),
    sessionGraceMs: Math.max(0, Number(env.BRIDGE_SESSION_GRACE_MS ?? 15000)),
  };
}