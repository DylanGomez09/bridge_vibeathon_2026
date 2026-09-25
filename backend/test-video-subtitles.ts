import {
  buildVideoPrompt,
  extractRetryAfterMs,
  extractStatus,
  formatSeconds,
  isRetryableError,
  isVideoTargetLang,
  normalizeCues,
  parseTargetLang,
  readModelPayload,
  VIDEO_RESPONSE_SCHEMA,
  withRetry,
} from "./src/video/subtitles.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`${GREEN}  ok${RESET} ${label}`);
  } else {
    failed += 1;
    console.error(`${RED}  FAIL${RESET} ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${DIM}── ${title} ──${RESET}`);
}

function testIdiomaDestino(): void {
  section("Idioma de salida: sólo es o en");
  check("acepta es", isVideoTargetLang("es"));
  check("acepta en", isVideoTargetLang("en"));
  check("rechaza fr", !isVideoTargetLang("fr"));
  check("rechaza undefined", !isVideoTargetLang(undefined));
  check("parsea 'ES' en minúscula", parseTargetLang("ES") === "es");
  check("parsea 'en-US' como en", parseTargetLang("en-US") === "en");
  check("parsea con espacios", parseTargetLang(" es ") === "es");
  check("devuelve null si no matchea", parseTargetLang("de") === null);
  check("devuelve null si falta", parseTargetLang(undefined) === null);
}

function testPrompt(): void {
  section("El prompt pide el idioma y el formato correctos");
  const es = buildVideoPrompt("es", 600);
  const en = buildVideoPrompt("en", 600);
  check("el prompt en español pide español", es.includes("español"));
  check("el prompt en inglés pide inglés", en.includes("inglés"));
  check("el prompt declara el tope de duración", es.includes("00:10:00"));
  check("el prompt avisa que el video no es sólo audio", es.includes("texto en pantalla"));
  check("el prompt exige JSON", es.includes("cues"));
  check("el schema pide start/end/original/translation", (() => {
    const cue = VIDEO_RESPONSE_SCHEMA.properties.cues.items;
    return (
      cue.type === "object" &&
      cue.properties.start.type === "number" &&
      cue.properties.end.type === "number" &&
      cue.properties.original.type === "string" &&
      cue.properties.translation.type === "string"
    );
  })());
}

function testFormatSeconds(): void {
  section("Formato de tiempo");
  check("0 segundos", formatSeconds(0) === "00:00:00");
  check("65 segundos", formatSeconds(65) === "00:01:05");
  check("600 segundos", formatSeconds(600) === "00:10:00");
  check("3661 segundos", formatSeconds(3661) === "01:01:01");
  check("negativo no rompe", formatSeconds(-5) === "00:00:00");
}

function testLecturaDelModelo(): void {
  section("Lectura de la respuesta del modelo");
  check("usa parsed si viene", normalizeCues(readModelPayload({ parsed: { cues: [] } }), 60).length === 0);
  check("usa text si no viene parsed", normalizeCues(readModelPayload({ text: '{"cues":[{"start":0,"end":1,"original":"a","translation":"b"}]}' }), 60).length === 1);
  check("desenvuelve un ```json", normalizeCues(readModelPayload({ text: '```json\n{"cues":[{"start":0,"end":1,"original":"a","translation":"b"}]}\n```' }), 60).length === 1);
  check("devuelve null ante basura", readModelPayload({ text: "no soy json" }) === null);
  check("no explota con text vacío", readModelPayload({ text: "   " }) === null);
  check("no explota con text undefined", readModelPayload({}) === null);
}

function testNormalizacion(): void {
  section("Normalización de cues: la parte que no puede fallar en silencio");
  const ok = { start: 0, end: 2, original: "hola", translation: "hello" };

  check("un cue válido pasa intacto", (() => {
    const cues = normalizeCues({ cues: [ok] }, 60);
    return cues.length === 1 && cues[0].start === 0 && cues[0].end === 2;
  })());

  check("acepta un array desnudo", normalizeCues([ok], 60).length === 1);
  check("descarta cue sin timecodes", normalizeCues({ cues: [{ original: "x", translation: "y" }] }, 60).length === 0);
  check("descarta start no numérico", normalizeCues({ cues: [{ ...ok, start: "abc" }] }, 60).length === 0);
  check("acepta start como string numérico", normalizeCues({ cues: [{ ...ok, start: "0" }] }, 60).length === 1);
  check("acepta coma decimal", normalizeCues({ cues: [{ ...ok, start: "0,5" }] }, 60).length === 1);
  check("descarta start negativo", normalizeCues({ cues: [{ ...ok, start: -1 }] }, 60).length === 0);
  check("descarta start fuera del video", normalizeCues({ cues: [{ ...ok, start: 61, end: 70 }] }, 60).length === 0);
  check("recorta end al tope del video", (() => {
    const cues = normalizeCues({ cues: [{ ...ok, start: 59, end: 90 }] }, 60);
    return cues.length === 1 && cues[0].end === 60;
  })());
  check("descarta end <= start", normalizeCues({ cues: [{ ...ok, end: 0 }] }, 60).length === 0);
  check("descarta cue sin texto", normalizeCues({ cues: [{ start: 0, end: 1, original: " ", translation: "" }] }, 60).length === 0);
  check("conserva cue sólo con translation", normalizeCues({ cues: [{ start: 0, end: 1, original: "", translation: "hola" }] }, 60).length === 1);
  check("ordena por start", (() => {
    const cues = normalizeCues(
      { cues: [{ ...ok, start: 10, end: 12 }, { ...ok, start: 2, end: 4 }] },
      60,
    );
    return cues[0].start === 2 && cues[1].start === 10;
  })());
  check("descarta cue duplicado en el mismo start", (() => {
    const cues = normalizeCues(
      { cues: [{ ...ok, start: 5, end: 8 }, { ...ok, start: 5, end: 9 }] },
      60,
    );
    return cues.length === 1;
  })());
  check("el orden de entrada no importa (ordena antes de validar)", (() => {
    const cues = normalizeCues(
      { cues: [{ ...ok, start: 30, end: 32 }, { ...ok, start: 2, end: 4 }, { ...ok, start: 15, end: 17 }] },
      60,
    );
    return cues.length === 3 && cues[0].start === 2 && cues[1].start === 15 && cues[2].start === 30;
  })());
  check("end nunca queda <= start", (() => {
    const cues = normalizeCues(
      { cues: [
        { ...ok, start: 0, end: 5 },
        { ...ok, start: 5, end: 5 },
        { ...ok, start: 6, end: 6 },
      ] },
      60,
    );
    return cues.length > 0 && cues.every((cue) => cue.end > cue.start);
  })());
  check("los cues nunca se superponen", (() => {
    const cues = normalizeCues(
      { cues: [
        { ...ok, start: 0, end: 10 },
        { ...ok, start: 3, end: 6 },
        { ...ok, start: 20, end: 25 },
      ] },
      60,
    );
    for (let i = 1; i < cues.length; i += 1) {
      if (cues[i].start < cues[i - 1].end) return false;
    }
    return cues.length === 3;
  })());
  check("colapsa espacios y recorta el texto", (() => {
    const cues = normalizeCues({ cues: [{ ...ok, original: "  hola   mundo  " }] }, 60);
    return cues[0].original === "hola mundo";
  })());
  check("descarta nulls y no-objetos", (() => {
    const cues = normalizeCues({ cues: [null, 5, "x", undefined, ok] }, 60);
    return cues.length === 1;
  })());
  check("respeta cues muy juntos sin perderlos", (() => {
    const cues = normalizeCues(
      { cues: Array.from({ length: 5 }, (_, i) => ({ ...ok, start: i * 0.1, end: i * 0.1 + 0.1 })) },
      60,
    );
    return cues.length === 5 && cues.every((cue) => cue.end > cue.start);
  })());
  check("sin límite (0) no recorta por duración", normalizeCues({ cues: [{ ...ok, start: 500, end: 502 }] }, 0).length === 1);
  check("respuesta vacía no rompe", normalizeCues({ cues: [] }, 60).length === 0);
  check("respuesta sin envelope no rompe", normalizeCues({}, 60).length === 0);
  check("null no rompe", normalizeCues(null, 60).length === 0);
}

const apiError = (status: number, message = "fallo", headers?: Record<string, string>) =>
  Object.assign(new Error(`${status} ${message}`), {
    status,
    headers: headers ? { get: (name: string) => headers[name.toLowerCase()] ?? null } : undefined,
  });

async function testReintentos(): Promise<void> {
  section("Reintentos ante 429/503");

  check("extrae status de APIError", extractStatus(apiError(503, "alta demanda")) === 503);
  check("extrae status del mensaje si no hay propiedad", extractStatus(new Error("404 model not found")) === 404);
  check("devuelve null si no hay status", extractStatus(new Error("fallo raro")) === null);

  check("503 es reintentable", isRetryableError(apiError(503)));
  check("429 es reintentable", isRetryableError(apiError(429)));
  check("500 es reintentable", isRetryableError(apiError(500)));
  check("404 NO es reintentable", !isRetryableError(apiError(404, "model not found")));
  check("400 NO es reintentable", !isRetryableError(apiError(400, "schema invalido")));
  check("503 sin status pero con texto sí es reintentable", isRetryableError(new Error("503 high demand")));
  check("error de texto no es reintentable", !isRetryableError(new Error("no se pudo procesar")));

  check("lee Retry-After numérico", extractRetryAfterMs(apiError(503, "x", { "retry-after": "7" })) === 7000);
  check("lee Retry-After como fecha futura", (() => {
    const ms = extractRetryAfterMs(apiError(503, "x", { "retry-after": new Date(Date.now() + 5000).toUTCString() }));
    return ms !== null && ms > 0 && ms <= 30000;
  })());
  check("sin headers devuelve null", extractRetryAfterMs(apiError(503)) === null);

  let attempts = 0;
  const ok = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw apiError(503, "alta demanda");
    return "listo";
  }, Date.now() + 60_000, [0, 0, 0]);
  check("reintenta hasta tener éxito", ok === "listo" && attempts === 3, `attempts=${attempts}`);

  attempts = 0;
  const thrown = await withRetry(async () => {
    attempts += 1;
    throw apiError(404, "model not found");
  }, Date.now() + 60_000, [0, 0, 0]).then(
    () => null,
    (error: unknown) => error,
  );
  check("no reintenta un 404", attempts === 1, `attempts=${attempts}`);
  check("propaga el 404 original", extractStatus(thrown) === 404);

  attempts = 0;
  await withRetry(async () => {
    attempts += 1;
    throw apiError(503, "alta demanda");
  }, Date.now() + 60_000, [0, 0, 0]).catch(() => undefined);
  check("agota los reintentos y falla", attempts === 4, `attempts=${attempts}`);

  attempts = 0;
  await withRetry(async () => {
    attempts += 1;
    throw apiError(503, "alta demanda");
  }, Date.now() - 1, [0, 0, 0]).catch(() => undefined);
  check("no reintenta si venció el deadline", attempts === 1, `attempts=${attempts}`);
}

async function main(): Promise<void> {
  console.log(`${DIM}[bridge] test-video-subtitles: cues, validación y reintentos (offline)${RESET}`);
  testIdiomaDestino();
  testPrompt();
  testFormatSeconds();
  testLecturaDelModelo();
  testNormalizacion();
  await testReintentos();

  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}[bridge] OK: ${passed} checks de subtítulos de video pasaron.${RESET}`);
    process.exit(0);
  }
  console.error(`${RED}[bridge] ${failed} checks fallaron de ${passed + failed}.${RESET}`);
  process.exit(1);
}

main();
