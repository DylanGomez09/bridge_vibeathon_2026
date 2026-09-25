import type { GoogleGenAI } from "@google/genai";
import { friendlyError } from "../errors.js";
import { VIDEO_TARGET_LANGS, type VideoTargetLang } from "../config.js";

const DEBUG = process.env.BRIDGE_DEBUG === "1";

const MIN_CUE_SECONDS = 0.2;
const MAX_CUE_CHARS = 300;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const MAX_RETRY_AFTER_MS = 30000;

type HeaderReader = { get?: (name: string) => string | null };

export function extractStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    for (const value of [candidate.status, candidate.statusCode]) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 100 && parsed < 600) return parsed;
    }
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match = text.match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function isRetryableError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== null) return RETRYABLE_STATUS.has(status);
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return /resource.?exhausted|unavailable|high demand|overloaded|rate.?limit|too many requests/.test(text);
}

export function extractRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as { headers?: HeaderReader }).headers;
  if (typeof headers?.get !== "function") return null;
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return null;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  deadlineAt: number,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt === delays.length;
      if (isLast || !isRetryableError(error) || Date.now() >= deadlineAt) throw error;
      const wait = extractRetryAfterMs(error) ?? delays[attempt];
      if (DEBUG) {
        console.warn(
          `[video] generateContent falló con ${extractStatus(error) ?? "?"}; reintento ${attempt + 1} en ${wait}ms`,
        );
      }
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

export interface VideoCue {
  start: number;
  end: number;
  original: string;
  translation: string;
}

export interface VideoSubtitleResult {
  model: string;
  targetLang: VideoTargetLang;
  durationSeconds: number | null;
  cues: VideoCue[];
}

export function isVideoTargetLang(value: unknown): value is VideoTargetLang {
  return typeof value === "string" && (VIDEO_TARGET_LANGS as readonly string[]).includes(value);
}

export function parseTargetLang(raw: string | undefined): VideoTargetLang | null {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .split("-")[0];
  return isVideoTargetLang(value) ? value : null;
}

export function formatSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

const LANG_NAMES: Record<VideoTargetLang, string> = {
  es: "español",
  en: "inglés",
};

export function buildVideoPrompt(targetLang: VideoTargetLang, maxSeconds: number): string {
  return [
    "Sos un subtitulador profesional. Analizá el video y escribí subtítulos en dos columnas.",
    "",
    `Idioma de salida de la columna "translation": ${LANG_NAMES[targetLang]}.`,
    `Idioma de la columna "original": el idioma en el que se habla en el video.`,
    "Si el idioma del video ya coincide con el de salida, copiá el mismo texto en ambas columnas.",
    "",
    "Reglas:",
    "- Un cue por locución, de 1 a 2 segundos de lectura comfortable.",
    "- Los timecodes van en SEGUNDOS desde el inicio del video, con decimales (por ejemplo 12.4).",
    "- `start` es el momento en que aparece la palabra; `end` es el momento en que termina.",
    "- Los cues van en orden creciente y nunca se superponen.",
    "- `end` siempre es MAYOR que `start`.",
    "- No dejes huecos mayores a 2 segundos entre cues si alguien está hablando.",
    "- Si no hay voz, no inventes cues: el video puede tener texto en pantalla o gráficos,",
    "  en cuyo caso incluí ese texto como un cue breve marcado como [texto en pantalla].",
    `- El video no dura más de ${formatSeconds(maxSeconds)}. No generes cues más allá del final.`,
    "",
    'Respondé únicamente con el objeto JSON {"cues": [...]} sin texto adicional.',
  ].join("\n");
}

export const VIDEO_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    cues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          original: { type: "string" },
          translation: { type: "string" },
        },
        required: ["start", "end", "original", "translation"],
      },
    },
  },
  required: ["cues"],
} as const;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_CUE_CHARS);
}

function extractCueList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cues?: unknown }).cues)) {
    return (parsed as { cues: unknown[] }).cues;
  }
  return [];
}

export function normalizeCues(raw: unknown, maxSeconds: number): VideoCue[] {
  const limit = maxSeconds > 0 ? maxSeconds : Number.POSITIVE_INFINITY;
  const valid: VideoCue[] = [];

  for (const item of extractCueList(raw)) {
    if (!item || typeof item !== "object") continue;
    const cue = item as Record<string, unknown>;
    const start = toFiniteNumber(cue.start);
    const end = toFiniteNumber(cue.end);
    const original = toText(cue.original);
    const translation = toText(cue.translation);
    if (start === null || end === null) continue;
    if (start < 0 || start >= limit) continue;
    if (end <= start) continue;
    if (!original && !translation) continue;
    valid.push({
      start,
      end: Math.min(end, limit),
      original,
      translation,
    });
  }

  valid.sort((a, b) => a.start - b.start);

  const resolved: VideoCue[] = [];
  for (const cue of valid) {
    const previous = resolved[resolved.length - 1];
    let end = cue.end;
    if (previous) {
      if (cue.start <= previous.start) continue;
      if (end > cue.start) end = cue.start;
      if (previous.end > cue.start) previous.end = Math.max(previous.start + MIN_CUE_SECONDS, cue.start);
    }
    if (end <= cue.start) end = cue.start + MIN_CUE_SECONDS;
    if (end > limit) end = limit;
    if (end <= cue.start) continue;
    resolved.push({ ...cue, end });
  }

  return resolved;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function readModelPayload(response: {
  text?: string | (() => string);
  parsed?: unknown;
}): unknown {
  if (response.parsed !== undefined && response.parsed !== null) return response.parsed;
  const text = typeof response.text === "function" ? response.text() : response.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return extractJson(text);
}

async function waitForFileActive(ai: GoogleGenAI, name: string): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const file = await ai.files.get({ name });
    if (file.state === "ACTIVE") return true;
    if (file.state === "FAILED") {
      if (DEBUG) console.error("[video] Gemini no pudo procesar el archivo:", file.error?.message);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

export async function generateVideoSubtitles(options: {
  ai: GoogleGenAI;
  model: string;
  timeoutMs: number;
  data: Buffer;
  mimeType: string;
  fileName: string;
  targetLang: VideoTargetLang;
  maxSeconds: number;
}): Promise<VideoSubtitleResult> {
  const { ai, model, timeoutMs, data, mimeType, fileName, targetLang, maxSeconds } = options;
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });

  let uploadedName: string | null = null;
  try {
    const uploaded = await withTimeout(
      ai.files.upload({
        file: blob,
        config: {
          mimeType,
          displayName: fileName,
        },
      }),
      timeoutMs,
      "Se agotó el tiempo límite para subir el video a Gemini.",
    );
    if (!uploaded.name) throw new Error("Gemini no devolvió un identificador de archivo");
    uploadedName = uploaded.name;
    if (DEBUG) console.log(`[video] archivo subido ${uploaded.name} (${uploaded.mimeType})`);

    const ready = await waitForFileActive(ai, uploadedName);
    if (!ready) throw new Error("No se pudo procesar el video en Gemini");

    const deadlineAt = Date.now() + timeoutMs;
    const response = await withRetry(async () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("Se agotó el tiempo límite del job de subtítulos");
      return ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ fileData: { fileUri: uploaded.uri, mimeType } }, { text: buildVideoPrompt(targetLang, maxSeconds) }],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: VIDEO_RESPONSE_SCHEMA,
          httpOptions: { timeout: remaining },
        },
      });
    }, deadlineAt);

    const payload = readModelPayload(response);
    const cues = normalizeCues(payload, maxSeconds);
    if (DEBUG) console.log(`[video] ${cues.length} cues normalizados`);

    const metadata = (uploaded as { videoMetadata?: Record<string, unknown> }).videoMetadata;
    const rawDuration = metadata?.["videoDurationSeconds"];
    const durationSeconds = toFiniteNumber(rawDuration);

    return { model, targetLang, durationSeconds, cues };
  } catch (error) {
    if (DEBUG) console.error("[video] fallo el job de subtítulos", error);
    throw new Error(friendlyError(error instanceof Error ? error.message : String(error), "No se pudieron generar los subtítulos del video."));
  } finally {
    if (uploadedName) {
      try {
        await ai.files.delete({ name: uploadedName });
      } catch (error) {
        if (DEBUG) console.warn("[video] no se pudo borrar el archivo remoto", error);
      }
    }
  }
}
