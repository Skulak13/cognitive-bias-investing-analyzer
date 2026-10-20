/**
 * Konfiguracja AI (Etap 8.3.1, D8-02/03/04) i opis stanu konfiguracji przy starcie (8.3.5).
 *
 * Zasady:
 *  - NIC nie jest buforowane: każde wywołanie czyta zmienne środowiskowe od nowa
 *    (testy i zmiana konfiguracji nie wymagają restartu modułu).
 *  - AI jest włączone WYŁĄCZNIE, gdy AI_ENABLED === "true" (dokładnie, małymi
 *    literami). Brak zmiennej, "TRUE", "1", "yes", " true" itd. = wyłączone.
 *  - Brak GEMINI_API_KEY nie zatrzymuje serwera — AI jest wtedy po prostu niedostępne.
 *  - Niepoprawne wartości liczbowe NIE zatrzymują serwera: wracamy do wartości
 *    domyślnej i zgłaszamy ostrzeżenie (z nazwą zmiennej, bez wartości).
 *  - Klucz API nie jest częścią obiektu konfiguracji (żeby nie wyciekł przez
 *    console.log / JSON.stringify) — odczytuje go osobno getGeminiApiKey().
 */

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

// [pole, zmienna środowiskowa, domyślna, min, max]
const NUMERIC_SETTINGS = [
  ["requestTimeoutMs", "AI_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000],
  ["maxRetries", "AI_MAX_RETRIES", 2, 0, 5],
  ["pauseBaseMs", "AI_PAUSE_BASE_MS", 60_000, 1_000, 3_600_000],
  ["pauseMaxMs", "AI_PAUSE_MAX_MS", 1_800_000, 1_000, 86_400_000],
  ["pauseFactor", "AI_PAUSE_FACTOR", 5, 1, 10],
  ["stalePendingMs", "AI_STALE_PENDING_MS", 600_000, 10_000, 86_400_000],
  ["recoveryIntervalMs", "AI_RECOVERY_INTERVAL_MS", 60_000, 1_000, 3_600_000],
  // Łączna liczba AUTOMATYCZNYCH startów analizy końcowej, wraz z pierwszym
  // (D8-27, zatwierdzone 20.10.2026: 1 próba początkowa + maks. 2 dodatkowe = 3).
  ["finalMaxAutoAttempts", "AI_FINAL_MAX_AUTO_ATTEMPTS", 3, 0, 10],
];

const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const DEFAULT_CONSENT_VERSION = "1";

function readInteger(env, name, def, min, max, warnings) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return def;
  const text = String(raw).trim();
  // tylko zwykłe nieujemne liczby całkowite (bez "1e3", "0x10", "12.5", "-1")
  if (!/^\d{1,15}$/.test(text)) {
    warnings.push({ name, reason: "invalid" });
    return def;
  }
  const value = Number(text);
  if (value < min || value > max) {
    warnings.push({ name, reason: "out_of_range" });
    return def;
  }
  return value;
}

function readPattern(env, name, def, pattern, warnings) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return def;
  const text = String(raw).trim();
  if (!pattern.test(text)) {
    warnings.push({ name, reason: "invalid" });
    return def;
  }
  return text;
}

/** Zamknięta rejestracja (D8-04): tylko dokładnie "true". */
export function isRegistrationClosed(env = process.env) {
  return env.REGISTRATION_CLOSED === "true";
}

/** Klucz Gemini (lub null). Nigdy nie loguj tej wartości. */
export function getGeminiApiKey(env = process.env) {
  const key = env.GEMINI_API_KEY;
  if (typeof key !== "string") return null;
  return key.trim() === "" ? null : key.trim();
}

/**
 * Aktualna konfiguracja AI (czytana przy każdym wywołaniu).
 * Zwraca zwykły obiekt BEZ klucza API; `hasApiKey` mówi tylko, czy klucz jest ustawiony.
 */
export function getAiConfig(env = process.env) {
  const warnings = [];

  const config = {
    enabled: env.AI_ENABLED === "true",
    hasApiKey: getGeminiApiKey(env) !== null,
    model: readPattern(
      env,
      "GEMINI_MODEL",
      DEFAULT_GEMINI_MODEL,
      MODEL_PATTERN,
      warnings,
    ),
    consentVersion: readPattern(
      env,
      "AI_CONSENT_VERSION",
      DEFAULT_CONSENT_VERSION,
      CONSENT_VERSION_PATTERN,
      warnings,
    ),
  };

  for (const [field, name, def, min, max] of NUMERIC_SETTINGS) {
    config[field] = readInteger(env, name, def, min, max, warnings);
  }

  // Pauza maksymalna nie może być krótsza niż początkowa.
  if (config.pauseMaxMs < config.pauseBaseMs) {
    warnings.push({ name: "AI_PAUSE_MAX_MS", reason: "below_base" });
    config.pauseMaxMs = config.pauseBaseMs;
  }

  config.warnings = warnings;
  return config;
}

/**
 * Stan dostępności AI z konfiguracji (wyłącznik ma pierwszeństwo):
 *  "disabled"       — AI_ENABLED nie jest "true"
 *  "not_configured" — włączone, ale brak GEMINI_API_KEY
 *  "ready"          — włączone i skonfigurowane
 */
export function getAiStatus(config = getAiConfig()) {
  if (!config.enabled) return "disabled";
  if (!config.hasApiKey) return "not_configured";
  return "ready";
}

/**
 * Czysta funkcja opisująca stan konfiguracji do logu startowego (8.3.5).
 * Nie zależy od serwera ani bazy. Nie zawiera klucza API.
 */
export function describeStartupConfig(env = process.env) {
  const config = getAiConfig(env);
  const status = getAiStatus(config);
  const registrationClosed = isRegistrationClosed(env);

  const lines = [];
  if (status === "ready") {
    lines.push(`AI: włączone i skonfigurowane (model: ${config.model})`);
  } else if (status === "not_configured") {
    lines.push(
      "AI: niedostępne — AI_ENABLED=true, ale brak GEMINI_API_KEY (wywołania AI są blokowane)",
    );
  } else {
    lines.push(
      `AI: wyłączone (AI_ENABLED nie ma wartości "true"; klucz GEMINI_API_KEY: ${config.hasApiKey ? "ustawiony" : "brak"})`,
    );
  }
  lines.push(
    registrationClosed
      ? "Rejestracja: zamknięta (REGISTRATION_CLOSED=true) — logowanie istniejących kont działa"
      : "Rejestracja: otwarta",
  );

  const warningLines = config.warnings.map(
    (w) =>
      `Uwaga: niepoprawna wartość ${w.name} (${w.reason}) — użyto wartości bezpiecznej`,
  );

  return {
    ai: {
      status,
      enabled: config.enabled,
      hasApiKey: config.hasApiKey,
      model: config.model,
    },
    registrationClosed,
    warnings: config.warnings,
    lines,
    warningLines,
  };
}
