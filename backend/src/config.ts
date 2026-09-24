import "dotenv/config";

export interface BridgeConfig {
  geminiApiKey: string;
  geminiLiveModel: string;
  geminiLiveVoice: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    geminiLiveModel: env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview",
    geminiLiveVoice: env.GEMINI_LIVE_VOICE ?? "Aoede",
    port: Number(env.PORT ?? 3001),
  };
}