import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GEMINI_MODEL,
  getAiConfig,
  getAiStatus,
  getGeminiApiKey,
  isRegistrationClosed,
  describeStartupConfig,
} from "../config/aiConfig.js";

/* Testy czyste: konfiguracja jest czytana z przekazanego obiektu `env`,
 * więc nie dotykamy process.env i testy nie zależą od kolejności. */

const SECRET = "AIza-TEST-SECRET-KEY-do-not-leak-123456";

test('AI_ENABLED — tylko dokładnie "true" włącza AI', () => {
  assert.equal(getAiConfig({ AI_ENABLED: "true" }).enabled, true);

  for (const value of [
    undefined,
    "",
    "false",
    "TRUE",
    "True",
    "1",
    "yes",
    "on",
    " true",
    "true ",
    "tak",
    "0",
  ]) {
    const env = value === undefined ? {} : { AI_ENABLED: value };
    assert.equal(
      getAiConfig(env).enabled,
      false,
      `wartość ${JSON.stringify(value)} nie może włączać AI`,
    );
  }
});

test("brak klucza API — AI niedostępne (not_configured), a konfiguracja nie rzuca", () => {
  const config = getAiConfig({ AI_ENABLED: "true" });
  assert.equal(config.hasApiKey, false);
  assert.equal(getAiStatus(config), "not_configured");
  assert.equal(getGeminiApiKey({ AI_ENABLED: "true" }), null);
  assert.equal(getGeminiApiKey({ GEMINI_API_KEY: "   " }), null);
});

test("wyłącznik ma pierwszeństwo przed brakiem klucza; pełna konfiguracja = ready", () => {
  assert.equal(getAiStatus(getAiConfig({})), "disabled");
  assert.equal(
    getAiStatus(getAiConfig({ GEMINI_API_KEY: SECRET })),
    "disabled",
  );
  assert.equal(
    getAiStatus(getAiConfig({ AI_ENABLED: "true", GEMINI_API_KEY: SECRET })),
    "ready",
  );
});

test("wartości domyślne (pusta konfiguracja)", () => {
  const c = getAiConfig({});
  assert.equal(c.model, DEFAULT_GEMINI_MODEL);
  assert.equal(c.model, "gemini-3.5-flash-lite");
  assert.equal(c.requestTimeoutMs, 30_000);
  assert.equal(c.maxRetries, 2);
  assert.equal(c.pauseBaseMs, 60_000);
  assert.equal(c.pauseMaxMs, 1_800_000);
  assert.equal(c.pauseFactor, 5);
  assert.equal(c.stalePendingMs, 600_000);
  assert.equal(c.recoveryIntervalMs, 60_000);
  assert.equal(c.finalMaxAutoAttempts, 3);
  assert.equal(c.consentVersion, "1");
  assert.deepEqual(c.warnings, []);
});

test("poprawne wartości ze środowiska są używane (w tym model z GEMINI_MODEL)", () => {
  const c = getAiConfig({
    GEMINI_MODEL: "gemini-x-test",
    AI_REQUEST_TIMEOUT_MS: "5000",
    AI_MAX_RETRIES: "0",
    AI_PAUSE_BASE_MS: "2000",
    AI_PAUSE_MAX_MS: "9000",
    AI_PAUSE_FACTOR: "3",
    AI_STALE_PENDING_MS: "20000",
    AI_RECOVERY_INTERVAL_MS: "5000",
    AI_FINAL_MAX_AUTO_ATTEMPTS: "0",
    AI_CONSENT_VERSION: "2026-10",
  });
  assert.equal(c.model, "gemini-x-test");
  assert.equal(c.requestTimeoutMs, 5000);
  assert.equal(c.maxRetries, 0);
  assert.equal(c.pauseBaseMs, 2000);
  assert.equal(c.pauseMaxMs, 9000);
  assert.equal(c.pauseFactor, 3);
  assert.equal(c.stalePendingMs, 20000);
  assert.equal(c.recoveryIntervalMs, 5000);
  assert.equal(c.finalMaxAutoAttempts, 0);
  assert.equal(c.consentVersion, "2026-10");
  assert.deepEqual(c.warnings, []);
});

test("niepoprawne liczby i teksty — bezpieczne wartości domyślne + ostrzeżenie (bez rzucania)", () => {
  const c = getAiConfig({
    AI_REQUEST_TIMEOUT_MS: "abc",
    AI_MAX_RETRIES: "-1",
    AI_PAUSE_BASE_MS: "1e3",
    AI_PAUSE_FACTOR: "12.5",
    AI_STALE_PENDING_MS: "5", // poniżej minimum
    AI_RECOVERY_INTERVAL_MS: "99999999999",
    AI_FINAL_MAX_AUTO_ATTEMPTS: "100",
    GEMINI_MODEL: "model z/ukośnikiem?",
    AI_CONSENT_VERSION: "za długa wersja zgody ".repeat(5),
  });
  assert.equal(c.requestTimeoutMs, 30_000);
  assert.equal(c.maxRetries, 2);
  assert.equal(c.pauseBaseMs, 60_000);
  assert.equal(c.pauseFactor, 5);
  assert.equal(c.stalePendingMs, 600_000);
  assert.equal(c.recoveryIntervalMs, 60_000);
  assert.equal(c.finalMaxAutoAttempts, 3);
  assert.equal(c.model, DEFAULT_GEMINI_MODEL);
  assert.equal(c.consentVersion, "1");

  const names = c.warnings.map((w) => w.name).sort();
  assert.deepEqual(names, [
    "AI_CONSENT_VERSION",
    "AI_FINAL_MAX_AUTO_ATTEMPTS",
    "AI_MAX_RETRIES",
    "AI_PAUSE_BASE_MS",
    "AI_PAUSE_FACTOR",
    "AI_RECOVERY_INTERVAL_MS",
    "AI_REQUEST_TIMEOUT_MS",
    "AI_STALE_PENDING_MS",
    "GEMINI_MODEL",
  ]);
});

test("pauza maksymalna krótsza niż początkowa jest podnoszona do początkowej + ostrzeżenie", () => {
  const c = getAiConfig({
    AI_PAUSE_BASE_MS: "100000",
    AI_PAUSE_MAX_MS: "5000",
  });
  assert.equal(c.pauseBaseMs, 100000);
  assert.equal(c.pauseMaxMs, 100000);
  assert.ok(
    c.warnings.some(
      (w) => w.name === "AI_PAUSE_MAX_MS" && w.reason === "below_base",
    ),
  );
});

test("konfiguracja jest czytana przy każdym wywołaniu (brak trwałego bufora)", () => {
  const env = {};
  assert.equal(getAiConfig(env).enabled, false);
  env.AI_ENABLED = "true";
  assert.equal(getAiConfig(env).enabled, true);
  env.AI_ENABLED = "false";
  assert.equal(getAiConfig(env).enabled, false);
  env.AI_MAX_RETRIES = "4";
  assert.equal(getAiConfig(env).maxRetries, 4);
});

test("domyślnie czyta process.env (i odzwierciedla jego zmiany)", () => {
  const before = process.env.AI_ENABLED;
  try {
    delete process.env.AI_ENABLED;
    assert.equal(getAiConfig().enabled, false);
    process.env.AI_ENABLED = "true";
    assert.equal(getAiConfig().enabled, true);
  } finally {
    if (before === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = before;
  }
});

test("klucz API nie występuje w obiekcie konfiguracji, w opisie startowym ani w ostrzeżeniach", () => {
  const env = {
    AI_ENABLED: "true",
    GEMINI_API_KEY: SECRET,
    AI_MAX_RETRIES: "zle",
  };
  const serialized = JSON.stringify([
    getAiConfig(env),
    describeStartupConfig(env),
  ]);
  assert.ok(
    !serialized.includes(SECRET),
    "klucz wyciekł do konfiguracji/opisu",
  );
  assert.ok(!serialized.includes("AIza"), "fragment klucza wyciekł");
  assert.equal(getGeminiApiKey(env), SECRET); // dostępny wyłącznie przez dedykowaną funkcję
});

test('REGISTRATION_CLOSED — tylko dokładnie "true" zamyka rejestrację', () => {
  assert.equal(isRegistrationClosed({ REGISTRATION_CLOSED: "true" }), true);
  for (const value of [undefined, "", "false", "TRUE", "1", " true"]) {
    const env = value === undefined ? {} : { REGISTRATION_CLOSED: value };
    assert.equal(isRegistrationClosed(env), false);
  }
});

test("describeStartupConfig — odróżnia AI włączone/skonfigurowane, wyłączone i niekompletne", () => {
  const ready = describeStartupConfig({
    AI_ENABLED: "true",
    GEMINI_API_KEY: SECRET,
  });
  assert.equal(ready.ai.status, "ready");
  assert.match(ready.lines[0], /włączone i skonfigurowane/);
  assert.match(ready.lines[0], /gemini-3\.5-flash-lite/);

  const incomplete = describeStartupConfig({ AI_ENABLED: "true" });
  assert.equal(incomplete.ai.status, "not_configured");
  assert.match(incomplete.lines[0], /niedostępne/);
  assert.match(incomplete.lines[0], /brak GEMINI_API_KEY/);

  const disabled = describeStartupConfig({});
  assert.equal(disabled.ai.status, "disabled");
  assert.match(disabled.lines[0], /wyłączone/);
  assert.match(disabled.lines[0], /brak/);

  const disabledWithKey = describeStartupConfig({ GEMINI_API_KEY: SECRET });
  assert.equal(disabledWithKey.ai.status, "disabled");
  assert.match(disabledWithKey.lines[0], /ustawiony/);
});

test("describeStartupConfig — informacja o rejestracji odpowiada faktycznemu zachowaniu", () => {
  const closed = describeStartupConfig({ REGISTRATION_CLOSED: "true" });
  assert.equal(closed.registrationClosed, true);
  assert.match(closed.lines[1], /zamknięta/);

  const open = describeStartupConfig({ REGISTRATION_CLOSED: "false" });
  assert.equal(open.registrationClosed, false);
  assert.match(open.lines[1], /otwarta/);
  assert.equal(describeStartupConfig({}).registrationClosed, false);
});

test("describeStartupConfig — ostrzeżenia o błędnych wartościach zawierają nazwy, nie wartości", () => {
  const info = describeStartupConfig({ AI_MAX_RETRIES: "tajne-zle-9" });
  assert.equal(info.warningLines.length, 1);
  assert.match(info.warningLines[0], /AI_MAX_RETRIES/);
  assert.ok(!info.warningLines[0].includes("tajne-zle-9"));
});
