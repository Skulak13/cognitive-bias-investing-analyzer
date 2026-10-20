/**
 * Klient Gemini (Etap 8.8, D8-14, D8-26).
 *
 * To JEDYNY moduł aplikacji, który zna API Google: adres, nagłówki, nazwy pól
 * żądania i odpowiedzi, kody błędów HTTP. Reszta aplikacji (orkiestrator, builder
 * danych, walidator, dziennik zużycia) zna wyłącznie kształt neutralny, opisany niżej.
 *
 * ── Endpoint i kształt API ─────────────────────────────────────────────────────
 * Interactions API (`POST /v1beta/interactions`, nagłówek `Api-Revision: 2026-05-20`),
 * potwierdzone testem technicznym 8.2 (19.10.2026):
 *   żądanie : model, input, system_instruction, response_format{type:"text",
 *             mime_type:"application/json", schema}, generation_config{max_output_tokens}
 *   odpowiedź: status, steps[], usage{total_tokens, total_input_tokens,
 *             total_output_tokens, total_thought_tokens}, model
 * Test 8.2 potwierdził przyjęcie żądania i zużycie tokenów; MIEJSCE tekstu modelu
 * (`steps[].type === "model_output"` → `content[].type === "text"` → `text`) oraz znaczenie
 * statusów innych niż `completed` pochodzą z DOKUMENTACJI Google (przewodnik migracji
 * „Interactions API: Breaking changes (May 2026)”, odczyt 22.10.2026), a nie z testu 8.2.
 * Nie ma pola `modelVersion` (jest tylko `model`).
 *
 * ── Wejście neutralne (funkcja `generateStructured`) ───────────────────────────
 *   {
 *     model,              // string, np. z getAiConfig().model
 *     systemInstruction,  // tekst; trafia do osobnego pola `system_instruction`
 *     userContent,        // GOTOWA treść użytkownika z Etapu 8.7 (`prepareAiRequest().request`);
 *                         // trafia do `input` BEZ zmian: bez serializacji, trimowania ani opakowania
 *     responseSchema,     // neutralny podzbiór JSON Schema (patrz `translateSchema`)
 *     limits?: { timeoutMs?, maxOutputTokens?, totalTimeoutMs? }   // dokłada orkiestrator (8.9)
 *   }
 * Obiekt `request` z `prepareAiRequest()` można przekazać w całości: pola `kind`,
 * `promptVersion`, `systemInstructionHash` (i każde inne spoza listy wyżej) są IGNOROWANE
 * i nigdy nie trafiają do żądania Google. Klient nie buduje i nie serializuje danych
 * (to robi 8.7); stare pole `data` jest odrzucane (TypeError), żeby nikt nie wysłał
 * dwóch różnych treści. `limits` to osobny argument parametrów wywołania — nie jest
 * częścią `modelInput` ani `userContent`; braki uzupełniają się wartościami domyślnymi:
 * timeoutMs ← AI_REQUEST_TIMEOUT_MS, maxOutputTokens ← 8192 (wartość z testu 8.2),
 * totalTimeoutMs ← 90 s. Użyte wartości wraca wynik w `requestSettings`.
 * Żadnych narzędzi (brak `tools`).
 *
 * ── Zapis po stronie Google (`store`) ──────────────────────────────────────────
 * Interactions API DOMYŚLNIE zapisuje interakcje (`store=true`; według dokumentacji
 * z 15.10.2026: 1 dzień na poziomie bezpłatnym, 55 dni na płatnym). Klient wysyła więc
 * jawnie `store: false` — nie używamy niczego, co wymaga zapisu (`previous_interaction_id`,
 * `background`). To ogranicza przechowywanie interakcji, ale NIE zmienia warunków
 * przetwarzania danych w usługach bezpłatnych/płatnych (plan 3.1).
 *
 * ── Wynik znormalizowany (6.14) ────────────────────────────────────────────────
 *   sukces: {ok:true, value, usage{input,output,reasoning,total}, modelVersion,
 *            finishReason:"stop", attempts, requestSettings}
 *   błąd  : {ok:false, error{kind, httpStatus, providerCode}, attempts, requestSettings}
 * `requestSettings` = {maxOutputTokens, thinkingLevel, store, apiRevision} — parametry
 * generowania faktycznie wysłane w żądaniu (`thinkingLevel: null` = nie ustawiono, działa
 * domyślne dostawcy); orkiestrator zapisuje je w `meta` migawki. Przy błędzie konfiguracji
 * bez żądania sieciowego (brak klucza, zła nazwa modelu) jest `null`.
 * `kind` ∈ rate_limited | unavailable | timeout | config | blocked | truncated | bad_output.
 * Wartości niedostępne = null. `attempts` (dodatek z 8.8.3, „każdy wynik próby trafia do
 * dziennika”) to tablica opisów prób BEZ treści: {attempt, ok, errorKind, httpStatus,
 * providerCode, durationMs, usage, finishReason, endpointKind}. `endpointKind` to krótki kod
 * rodzaju użytego endpointu (dziennik zużycia zapisuje go bez znajomości API Google).
 *
 * ── Błędy programisty a błędy środowiska ───────────────────────────────────────
 * Niepoprawne ARGUMENTY wywołania (zły typ `data`, schemat, limity) → rzucany TypeError
 * (błąd w kodzie wywołującym; orkiestrator zamienia wyjątek na `internal_error`).
 * Problemy ŚRODOWISKA (brak/niepoprawny klucz, niepoprawna nazwa modelu, 400–404 od
 * Google) → wynik `{ok:false, error:{kind:"config"}}`; funkcja nie rzuca z powodu sieci,
 * odpowiedzi ani konfiguracji.
 *
 * ── Bezpieczeństwo ─────────────────────────────────────────────────────────────
 * Klucz tylko z getGeminiApiKey() (zmienna środowiskowa), tylko w nagłówku
 * `x-goog-api-key`, nigdy w URL. `redirect: "error"` — nagłówek z kluczem nie może
 * zostać przekazany pod inny adres. Wynik błędu nie zawiera komunikatów dostawcy
 * (mogą cytować dane wejściowe); `providerCode` to krótki, przefiltrowany kod. Moduł nie
 * loguje niczego domyślnie; opcjonalny `log` dostaje wyłącznie zdarzenia bez treści i klucza.
 *
 * ── Ponowienia (6.8) ───────────────────────────────────────────────────────────
 * Tylko błędy przejściowe (sieć, timeout, 408, 500, 503, 504): do 2 ponowień (3 próby),
 * odstęp ~1 s i ~2 s z losowym rozrzutem ±25%, limit czasu każdej próby i łączny limit
 * czasu całego wywołania. 429, konfiguracja, blokada, ucięcie i błędy semantyczne odpowiedzi
 * NIE są ponawiane przez klienta. Ponowienie po odrzuceniu wyniku przez walidator należy
 * do orkiestratora (8.9) — klient nie zna walidatora.
 */

import { getAiConfig, getGeminiApiKey } from "../config/aiConfig.js";

export const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_API_REVISION = "2026-05-20";
/** Krótki kod rodzaju endpointu dla dziennika zużycia (potwierdzony w teście technicznym 8.2). */
export const GEMINI_ENDPOINT_KIND = "interactions";

export const ERROR_KINDS = Object.freeze([
  "rate_limited",
  "unavailable",
  "timeout",
  "config",
  "blocked",
  "truncated",
  "bad_output",
]);
export const FINISH_REASONS = Object.freeze([
  "stop",
  "truncated",
  "blocked",
  "other",
]);

/** Twardy limit ponowień (plan 6.8: max 2), niezależnie od AI_MAX_RETRIES (dopuszcza do 5). */
export const HARD_MAX_RETRIES = 2;
/** Odstęp przed ponowieniem nr 1 i 2: baza × 2^(n-1) × rozrzut (0,75–1,25). */
export const RETRY_BASE_DELAY_MS = 1_000;
/** Limit tokenów wyjścia, gdy wywołujący go nie poda; wartość użyta w teście technicznym 8.2 (PROPONOWANE jako domyślna). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Łączny limit czasu wywołania, gdy wywołujący go nie poda (PROPONOWANE — plan nie ustala liczby). */
export const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;
/** Nie zaczynamy próby, gdy do końca łącznego limitu zostało mniej niż to. */
export const MIN_ATTEMPT_MS = 1_000;

const MAX_RESPONSE_CHARS = 2_000_000;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const API_KEY_PATTERN = /^[\x21-\x7E]{8,512}$/; // widoczne znaki ASCII, bez spacji i znaków sterujących
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Kody blokad generowania, porównanie bez wielkości liter. Pierwsze 11 to „Generation blocked
// codes” ze strony „API errors” (Interactions, 23.10.2026). `jailbreak` tej listy NIE ma, ale
// przewodnik „Safety settings” podaje go jako `error.code` (obok `prohibited_content` i
// `blocklist`) przy zablokowanym wejściu: HTTP 400, komunikat zaczyna się od „Input blocked:”.
// Dokumentacja jest w tym punkcie niespójna, więc przyjmujemy ostrożniejszą wersję — rozpoznajemy
// `jailbreak` jako blokadę (bez ponowień, jak pozostałe), żeby nie raportować go jako `config`.
// `jailbreak` jest też nazwą kategorii szkód w `safety_settings`; tutaj dotyczy tylko `error.code`.
const BLOCKED_CODES = new Set([
  "safety",
  "recitation",
  "language",
  "prohibited_content",
  "spii",
  "blocklist",
  "image_safety",
  "image_prohibited_content",
  "image_recitation",
  "image_other",
  "content_blocked",
  "jailbreak",
]);

/* ───────────────────────── mapowanie błędów (8.8.2) ───────────────────────── */

/**
 * Odpowiedź HTTP Google → rodzaj błędu + czy ponawiać. JEDNO miejsce tej tabeli.
 *
 *  429                         → rate_limited, nie (pauza ochronna: po stronie orkiestratora)
 *  408, 504                    → timeout,      tak
 *  500, 503                    → unavailable,  tak
 *  400 401 402 403 404 i inne 4xx → config,    nie
 *  499, pozostałe 5xx, nietypowe → unavailable, nie
 *  dowolny kod HTTP z kodem blokady generowania (`error.code`, lista BLOCKED_CODES) → blocked, nie
 *
 * Kody błędów (`error.code`) służą tylko do wykrycia blokady i trafiają do `providerCode`;
 * reszta klasyfikacji opiera się na statusie HTTP (kody standardowe mają jednoznaczny status).
 */
export function classifyHttpError(httpStatus, providerCode = null) {
  if (typeof providerCode === "string" && BLOCKED_CODES.has(providerCode.toLowerCase())) {
    return { kind: "blocked", retryable: false };
  }
  if (httpStatus === 429) return { kind: "rate_limited", retryable: false };
  if (httpStatus === 408 || httpStatus === 504) {
    return { kind: "timeout", retryable: true };
  }
  if (httpStatus === 500 || httpStatus === 503) {
    return { kind: "unavailable", retryable: true };
  }
  if (httpStatus === 499) return { kind: "unavailable", retryable: false };
  if (httpStatus >= 400 && httpStatus < 500) {
    return { kind: "config", retryable: false };
  }
  return { kind: "unavailable", retryable: false };
}

/**
 * Pole `status` odpowiedzi 2xx → wynik. Wszystko poza `completed` jest błędem, dopóki
 * nie poznamy znaczenia (plan 8.2.5, wniosek 4). Ponowień nie ma: to błąd semantyczny, nie HTTP.
 *
 * Źródła (rozbieżne, więc je rozdzielamy):
 *  - HTML-owa referencja Interactions (ai.google.dev/api/interactions-api, odczyt 25.10.2026)
 *    wymieniała: in_progress, requires_action, completed, failed, cancelled, incomplete;
 *  - oficjalne typy SDK Google (`InteractionStatus`) i specyfikacja OpenAPI (wg zgłoszenia
 *    BerriAI/litellm#35346) dodatkowo zawierają `budget_exceeded` oraz `queued`; przegląd
 *    kodu (25.10.2026) wskazuje, że aktualna dokumentacja Interactions wymienia oba jako
 *    możliwe statusy — mapowanie jest więc uzasadnione;
 *  - dokumentacja Vertex opisuje je tak: BUDGET_EXCEEDED — „zatrzymano, bo przekroczono budżet
 *    tokenów”, QUEUED — „czeka na przetworzenie (np. na pojemność poza szczytem)”.
 * Zachowanie `budget_exceeded` i `queued` w prawdziwym wywołaniu SYNCHRONICZNYM nie zostało
 * sprawdzone.
 *
 *  incomplete       → truncated   (referencja: wynik niepełny, np. osiągnięto max_output_tokens)
 *  budget_exceeded  → truncated   (zatrzymanie z powodu budżetu tokenów — wynik nie jest
 *                                  kompletny; `providerCode` odróżnia go od `incomplete`)
 *  queued           → unavailable (usługa nie przetwarza teraz; nie używamy `service_tier`
 *                                  ani `background`, więc to sytuacja wyjątkowa. BEZ ponowień:
 *                                  porzucona interakcja mogłaby zostać przetworzona później,
 *                                  a anulować można tylko interakcje w tle; bez odpytywania —
 *                                  8.8 nie ma trybu tła, a przy `store: false` nie ma czego pobrać)
 *  failed, cancelled→ unavailable (przyczyna nieznana: bez ponowień, bez zgadywania blokady)
 *  in_progress, requires_action → bad_output (nie używamy tła ani narzędzi)
 *  każdy inny / brak→ bad_output  (bezpieczne zachowanie dla statusu nieznanego: błąd, bez
 *                         ponowień, treść odpowiedzi nie jest używana; `providerCode` zawiera
 *                         nazwę statusu, jeśli ma bezpieczny zapis, więc jest widoczny w dzienniku)
 */
function classifyInteractionStatus(status) {
  switch (status) {
    case "incomplete":
    case "budget_exceeded":
      return { kind: "truncated", finishReason: "truncated" };
    case "failed":
    case "cancelled":
    case "queued":
      return { kind: "unavailable", finishReason: "other" };
    default:
      return { kind: "bad_output", finishReason: "other" };
  }
}

/* ─────────────────────────── schemat odpowiedzi ──────────────────────────── */

// Podzbiór JSON Schema wskazany w dokumentacji structured output (plan 3.3).
const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
]);
const SCHEMA_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);
const MAX_SCHEMA_DEPTH = 20;

/**
 * Neutralny opis kontraktu (podzbiór JSON Schema) → schemat w formie Google.
 * Forma Google dla `response_format.schema` to ten sam podzbiór JSON Schema, więc
 * tłumaczenie = walidacja + głęboka kopia z białej listy słów kluczowych. Słowo
 * spoza listy (np. `pattern`, `anyOf`, `$ref`) → TypeError, zamiast cichego
 * pominięcia ograniczenia. Treść wartości zawsze i tak sprawdza `validateAiResponse`.
 */
export function translateSchema(schema, depth = 0, path = "responseSchema") {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new TypeError(`${path}: schemat zagnieżdżony zbyt głęboko`);
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(`${path}: schemat musi być obiektem`);
  }

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new TypeError(`${path}: nieobsługiwane słowo kluczowe "${key}"`);
    }
    switch (key) {
      case "type":
        if (typeof value !== "string" || !SCHEMA_TYPES.has(value)) {
          throw new TypeError(`${path}.type: niedozwolony typ`);
        }
        out.type = value;
        break;
      case "properties": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError(`${path}.properties: oczekiwano obiektu`);
        }
        out.properties = {};
        for (const [name, sub] of Object.entries(value)) {
          out.properties[name] = translateSchema(
            sub,
            depth + 1,
            `${path}.properties.${name}`,
          );
        }
        break;
      }
      case "items":
        out.items = translateSchema(value, depth + 1, `${path}.items`);
        break;
      case "required":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          throw new TypeError(`${path}.required: oczekiwano tablicy tekstów`);
        }
        out.required = [...value];
        break;
      case "enum":
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          !value.every((v) => ["string", "number", "boolean"].includes(typeof v))
        ) {
          throw new TypeError(`${path}.enum: oczekiwano niepustej tablicy wartości prostych`);
        }
        out.enum = [...value];
        break;
      case "additionalProperties":
        if (typeof value !== "boolean") {
          throw new TypeError(`${path}.additionalProperties: oczekiwano wartości logicznej`);
        }
        out.additionalProperties = value;
        break;
      case "description":
      case "format":
        if (typeof value !== "string") {
          throw new TypeError(`${path}.${key}: oczekiwano tekstu`);
        }
        out[key] = value;
        break;
      default: // minimum, maximum, minItems, maxItems
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new TypeError(`${path}.${key}: oczekiwano liczby`);
        }
        out[key] = value;
    }
  }
  if (!("type" in out)) {
    throw new TypeError(`${path}: brak pola "type"`);
  }
  return out;
}

/* ───────────────────────────── walidacja wejścia ──────────────────────────── */

function positiveInt(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new TypeError(`limits.${name}: oczekiwano liczby całkowitej 1–${max}`);
  }
  return value;
}

function validateRequest(request, config) {
  if (request === null || typeof request !== "object") {
    throw new TypeError("generateStructured: oczekiwano obiektu żądania");
  }
  const { model, systemInstruction, userContent, responseSchema } = request;
  const limits = request.limits === undefined ? {} : request.limits;

  if (request.data !== undefined) {
    throw new TypeError(
      "data: pole nie jest już obsługiwane — klient przyjmuje gotowy `userContent` z Etapu 8.7",
    );
  }
  if (typeof systemInstruction !== "string" || systemInstruction.trim() === "") {
    throw new TypeError("systemInstruction: oczekiwano niepustego tekstu");
  }
  if (typeof userContent !== "string" || userContent.trim() === "") {
    throw new TypeError("userContent: oczekiwano niepustego tekstu (gotowa treść z 8.7)");
  }
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("limits: oczekiwano obiektu");
  }

  const timeoutMs = positiveInt(
    limits.timeoutMs ?? config.requestTimeoutMs,
    "timeoutMs",
    600_000,
  );
  const maxOutputTokens = positiveInt(
    limits.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    "maxOutputTokens",
    1_048_576,
  );
  const totalTimeoutMs = positiveInt(
    limits.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    "totalTimeoutMs",
    1_800_000,
  );

  const schema = translateSchema(responseSchema);

  // `userContent` idzie do `input` dokładnie w takiej postaci, w jakiej je przygotowało 8.7.
  return { model, systemInstruction, input: userContent, schema, timeoutMs, maxOutputTokens, totalTimeoutMs };
}

/* ─────────────────────────── parsowanie odpowiedzi ────────────────────────── */

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Zużycie tokenów; pola, których dostawca nie podał, są null. */
export function normalizeUsage(usage) {
  const u = usage !== null && typeof usage === "object" ? usage : {};
  return {
    input: tokenCount(u.total_input_tokens),
    output: tokenCount(u.total_output_tokens),
    reasoning: tokenCount(u.total_thought_tokens),
    total: tokenCount(u.total_tokens),
  };
}

function safeProviderCode(value) {
  return typeof value === "string" && PROVIDER_CODE_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Kod błędu z treści odpowiedzi błędu.
 *
 * Interactions API zwraca `{error:{code, message}}`, gdzie `code` jest TEKSTEM w snake_case
 * (np. `invalid_request`, `rate_limit_exceeded`, `safety`) — strona „API errors”, 23.10.2026.
 * Pole `error.status` (ogólny format błędów Google, np. `RESOURCE_EXHAUSTED`) nie jest tam
 * opisane; czytamy je tylko jako zapasowe, gdy `code` nie jest tekstem (np. liczba), bo błąd
 * może pochodzić z warstwy pośredniej. Komunikatu (`message`) nigdy nie czytamy.
 */
function readProviderErrorCode(text) {
  try {
    const error = JSON.parse(text)?.error;
    // `status` tylko wtedy, gdy `code` NIE jest tekstem. Tekst nieprzechodzący walidacji (zły
    // format, zbyt długi) kończy odczyt wynikiem null — nie sięgamy wtedy po inne pole.
    if (typeof error?.code === "string") return safeProviderCode(error.code);
    return safeProviderCode(error?.status);
  } catch {
    return null;
  }
}

function collectModelText(steps) {
  if (!Array.isArray(steps)) return null;
  let text = "";
  let found = false;
  for (const step of steps) {
    if (step === null || typeof step !== "object" || step.type !== "model_output") continue;
    if (!Array.isArray(step.content)) continue;
    for (const part of step.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        text += part.text;
        found = true;
      }
    }
  }
  return found ? text : null;
}

/** Odpowiedź 2xx → {ok:true,...} albo {ok:false, kind, providerCode, finishReason, usage}. */
function parseSuccessBody(text, requestedModel) {
  const bad = (providerCode = null, usage = normalizeUsage(null)) => ({
    ok: false,
    kind: "bad_output",
    providerCode,
    finishReason: "other",
    usage,
  });

  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_RESPONSE_CHARS) {
    return bad();
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return bad();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return bad();

  const usage = normalizeUsage(body.usage);
  const status = typeof body.status === "string" ? body.status : null;
  const statusCode = safeProviderCode(status);

  if (status !== "completed") {
    // Referencja zasobu Interaction opisuje tablicę `errors` (diagnostyka platformy, `code` to
    // URI), ale nie wiąże jej z blokadą; kodów blokad szukamy tylko w odpowiedzi błędu HTTP.
    const mapped = classifyInteractionStatus(status);
    return { ok: false, kind: mapped.kind, providerCode: statusCode, finishReason: mapped.finishReason, usage };
  }

  const modelText = collectModelText(body.steps);
  if (modelText === null || modelText.trim() === "") return bad(statusCode, usage);

  let value;
  try {
    value = JSON.parse(modelText);
  } catch {
    return bad(statusCode, usage);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return bad(statusCode, usage);
  }

  // Interactions zwraca tylko `model` (nazwa jak w żądaniu); „wersją” jest dopiero nazwa RÓŻNA od zleconej.
  const reported = typeof body.model === "string" ? body.model : null;
  const modelVersion = reported && reported !== requestedModel ? reported : null;

  return { ok: true, value, usage, modelVersion, finishReason: "stop" };
}

/* ───────────────────────────── jedna próba HTTP ───────────────────────────── */

/**
 * Jedna próba z własnym limitem czasu. Zwraca {type:"response", status, text},
 * {type:"timeout"} albo {type:"network"}; nie rzuca.
 */
async function sendOnce({ fetchImpl, init, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ type: "timeout" });
    }, timeoutMs);
  });

  const work = (async () => {
    try {
      const res = await fetchImpl(GEMINI_ENDPOINT, { ...init, signal: controller.signal });
      const text = await res.text(); // odczyt treści też podlega limitowi czasu próby
      return { type: "response", status: res.status, text };
    } catch {
      return timedOut ? { type: "timeout" } : { type: "network" };
    }
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describeAttempt(attempt, result, durationMs) {
  return {
    attempt,
    ok: result.ok === true,
    errorKind: result.ok ? null : result.error.kind,
    httpStatus: result.ok ? null : result.error.httpStatus,
    providerCode: result.ok ? null : result.error.providerCode,
    durationMs,
    usage: result.usage ?? normalizeUsage(null),
    finishReason: result.finishReason ?? "other",
    endpointKind: GEMINI_ENDPOINT_KIND,
  };
}

/* ───────────────────────────────── klient ────────────────────────────────── */

const failure = (kind, httpStatus = null, providerCode = null) => ({
  ok: false,
  error: { kind, httpStatus, providerCode },
});

/**
 * Fabryka klienta. Wszystkie zależności są wstrzykiwalne (testy bez sieci, zegara i losowości);
 * produkcyjnie używane są wartości domyślne.
 */
export function createGeminiClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getApiKey = getGeminiApiKey,
  getConfig = getAiConfig,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = Date.now,
  log = () => {},
} = {}) {
  async function generateStructured(request) {
    const config = getConfig();
    const prepared = validateRequest(request, config);

    // Konfiguracja środowiska: bez żądania sieciowego.
    const key = getApiKey();
    if (typeof key !== "string" || !API_KEY_PATTERN.test(key)) {
      return { ...failure("config"), attempts: [], requestSettings: null };
    }
    if (typeof prepared.model !== "string" || !MODEL_PATTERN.test(prepared.model)) {
      return { ...failure("config"), attempts: [], requestSettings: null };
    }

    const init = {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
        "Api-Revision": GEMINI_API_REVISION,
      },
      // Brak `tools` i `thinking_level` (8.2, 6.7); `store: false` jawnie (patrz nagłówek modułu).
      body: JSON.stringify({
        model: prepared.model,
        input: prepared.input,
        system_instruction: prepared.systemInstruction,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: prepared.schema,
        },
        generation_config: { max_output_tokens: prepared.maxOutputTokens },
        store: false,
      }),
    };
    const requestSettings = {
      maxOutputTokens: prepared.maxOutputTokens,
      thinkingLevel: null,
      store: false,
      apiRevision: GEMINI_API_REVISION,
    };

    const maxRetries = Math.min(
      Number.isInteger(config.maxRetries) && config.maxRetries >= 0
        ? config.maxRetries
        : HARD_MAX_RETRIES,
      HARD_MAX_RETRIES,
    );
    const maxAttempts = maxRetries + 1;
    const startedAt = now();
    const deadline = startedAt + prepared.totalTimeoutMs;
    const attempts = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptStartedAt = now();
      const remaining = deadline - attemptStartedAt;
      const timeoutMs = Math.min(prepared.timeoutMs, Math.max(1, remaining));

      const raw = await sendOnce({ fetchImpl, init, timeoutMs });
      let retryable = false;
      let result;

      if (raw.type === "timeout") {
        result = failure("timeout");
        retryable = true;
      } else if (raw.type === "network") {
        result = failure("unavailable");
        retryable = true;
      } else if (raw.status >= 200 && raw.status < 300) {
        const parsed = parseSuccessBody(raw.text, prepared.model);
        result = parsed.ok
          ? parsed
          : {
              ...failure(parsed.kind, raw.status, parsed.providerCode),
              usage: parsed.usage,
              finishReason: parsed.finishReason,
            };
      } else {
        const providerCode = readProviderErrorCode(raw.text);
        const mapped = classifyHttpError(raw.status, providerCode);
        retryable = mapped.retryable;
        result = {
          ...failure(mapped.kind, raw.status, providerCode),
          finishReason: mapped.kind === "blocked" ? "blocked" : "other",
        };
      }

      const info = describeAttempt(attempt, result, Math.max(0, now() - attemptStartedAt));
      attempts.push(info);

      if (result.ok) {
        return {
          ok: true,
          value: result.value,
          usage: result.usage,
          modelVersion: result.modelVersion,
          finishReason: result.finishReason,
          attempts,
          requestSettings,
        };
      }

      const last = attempt === maxAttempts;
      const delayMs = Math.round(
        RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + 0.5 * random()),
      );
      const budgetLeft = deadline - now() - delayMs >= MIN_ATTEMPT_MS;

      if (!retryable || last || !budgetLeft) {
        return { ok: false, error: result.error, attempts, requestSettings };
      }

      log({
        event: "gemini_retry",
        attempt,
        kind: result.error.kind,
        httpStatus: result.error.httpStatus,
        delayMs,
      });
      await sleep(delayMs);
    }

    // Nieosiągalne (pętla zawsze zwraca), zostawione jako zabezpieczenie.
    return { ...failure("unavailable"), attempts, requestSettings };
  }

  return { generateStructured };
}

export const geminiClient = createGeminiClient();
export const generateStructured = geminiClient.generateStructured;
