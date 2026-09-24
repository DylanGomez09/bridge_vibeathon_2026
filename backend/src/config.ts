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
  };
}