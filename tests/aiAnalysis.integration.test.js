import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPositionHarness } from "./helpers/positionHarness.js";
import {
  createOrchestratorKit,
  createFakeSend,
  okResult,
  failResult,
  validFull,
  extractSentData,
  stringify,
  usage,
  REQUEST_SETTINGS,
  SECRET_ANSWER,
  T0,
} from "./helpers/aiOrchestratorKit.js";
import { deferred } from "./helpers/aiServiceKit.js";
import { TEXT } from "./helpers/aiInputKit.js";
import { createAiAnalysisService } from "../services/aiAnalysisService.js";
import { PROMPT_VERSION } from "../utils/aiPrompt.js";
import { DEFAULT_GEMINI_MODEL } from "../config/aiConfig.js";

/* Etap 8.9.2–8.9.3 — orkiestrator pełnej analizy z fałszywym Gemini.
 * Stan analiz: tryb "mongo" (MONGODB_TEST_URI) albo "fake" (atrapa w pamięci, jak w 8.6).
 * Dane wejściowe: prawdziwy builder 8.7 na atrapach modeli; dziennik zużycia: atrapa
 * modelu (zgodność ze schematem sprawdza tests/aiUsageLogger.test.js). Gemini NIE jest wołany. */

const h = await createPositionHarness();
const tag = `[${h.backend}]`;

before(() => {
  // Żaden test nie może sięgnąć do sieci: prawdziwy klient nigdy nie jest używany.
  globalThis.__realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Test wywołał globalny fetch — zakaz sieci w testach 8.9");
  };
});
afterEach(async () => {
  const stray = (await h.all()).filter((d) => d.lastAnalysisStatus === "pending");
  assert.equal(stray.length, 0, "test zostawił pozycję w pending");
  await h.reset();
});
after(async () => {
  globalThis.fetch = globalThis.__realFetch;
  await h.close();
});

/** Serwis stanu (8.6) z wykonawcą = orkiestrator; wspólne zabezpieczenia, konfiguracja i zegar. */
function setup(options = {}) {
  const k = createOrchestratorKit(options);
  // Dane syntetyczne builder ma pod własnymi identyfikatorami (fixture 8.7), a stan analizy
  // leży na pozycji z harnessu — przekierowanie jest jawne i dotyczy tylko tego pliku.
  k.hooks.mapIds = (args) => ({ ...args, positionId: k.ids.position, userId: k.ids.userA });
  let counter = 0;
  const serviceLogs = [];
  const service = createAiAnalysisService({
    PositionModel: h.Position,
    loadUser: async () => k.userState.user,
    safeguards: k.safeguards,
    getConfig: k.getConfig,
    now: () => k.clock.t,
    generateRunId: () => `svc-${++counter}`,
    log: (event, fields) => serviceLogs.push({ event, ...fields }),
  });
  service.setExecutor(k.orchestrator.executeFullAnalysis);
  return { k, service, serviceLogs };
}

/** Rezerwacja ręczna + wykonanie; zwraca dokument pozycji po zakończeniu. */
async function runManual(s, overrides = {}) {
  const id = await h.insert(overrides);
  const userId = String((await h.get(id)).userId);
  const reserved = await s.service.reserveAnalysis({ positionId: id, userId });
  assert.equal(reserved.ok, true);
  await s.service.executeReservation(reserved.reservation);
  return { id, run: reserved.reservation, doc: await h.get(id) };
}

test(`${tag} sukces: analiza dopisana z polami backendu, migawką i parametrami żądania; dziennik 1 rekord`, async () => {
  const s = setup({ script: [okResult(validFull())] });
  const { doc, run } = await runManual(s);

  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.lastAnalysisReason, null);
  assert.equal(doc.analyses.length, 1);

  const a = doc.analyses[0];
  assert.equal(a.analysisRunId, run.runId);
  assert.equal(a.analysisType, "interim");
  assert.equal(a.promptVersion, PROMPT_VERSION);
  assert.equal(a.aiModelVersion, DEFAULT_GEMINI_MODEL); // brak wersji w odpowiedzi → nazwa zleconego modelu
  assert.equal(a.summary, validFull().summary);
  assert.equal(a.possibleBiases.length, 1);

  // Migawka = dokładnie to, co poszło do modelu (blok <DANE> z żądania).
  assert.equal(s.k.calls.length, 1);
  const sent = extractSentData(s.k.calls[0]);
  assert.deepEqual(a.inputSnapshot.modelInput, sent);
  assert.equal(a.inputSnapshot.meta.requestedModel, DEFAULT_GEMINI_MODEL);
  assert.equal(a.inputSnapshot.meta.promptVersion, PROMPT_VERSION);
  assert.equal(a.inputSnapshot.meta.modelVersion, null);
  assert.deepEqual(a.inputSnapshot.meta.requestSettings, REQUEST_SETTINGS);

  // Limity dokłada orkiestrator, osobno od treści żądania.
  assert.equal(s.k.calls[0].limits.timeoutMs, s.k.getConfig().requestTimeoutMs);
  assert.equal(s.k.calls[0].kind, "full");

  // Dziennik: jedna próba, tokeny z klienta, bez treści.
  assert.equal(s.k.usageDocs.length, 1);
  const u = s.k.usageDocs[0];
  assert.equal(u.analysisRunId, run.runId);
  assert.equal(u.attempt, 1);
  assert.equal(u.kind, "full");
  assert.equal(u.trigger, "manual");
  assert.equal(u.outcome, "success");
  assert.equal(u.requestedModel, DEFAULT_GEMINI_MODEL);
  assert.equal(u.promptVersion, PROMPT_VERSION);
  assert.equal(u.inputTokens, 1200);
  assert.equal(u.totalTokens, 1500);
  assert.equal(u.inputChars, s.k.calls[0].userContent.length);
  assert.ok(u.outputChars > 0);
  assert.equal(u.maxFieldLengths.summary, validFull().summary.length);
});

test(`${tag} wersja modelu z odpowiedzi trafia do analizy i do meta migawki`, async () => {
  const s = setup({ script: [okResult(validFull(), { modelVersion: "model-2026-10-rev3" })] });
  const { doc } = await runManual(s);
  assert.equal(doc.analyses[0].aiModelVersion, "model-2026-10-rev3");
  assert.equal(doc.analyses[0].inputSnapshot.meta.modelVersion, "model-2026-10-rev3");
  assert.equal(s.k.usageDocs[0].modelVersion, "model-2026-10-rev3");
});

test(`${tag} odpowiedź odrzucona przez walidator → jedno ponowienie; zapis tylko poprawnej, 2 rekordy dziennika`, async () => {
  const s = setup({
    script: [okResult(validFull({ summary: "" })), okResult(validFull({ summary: "Poprawne." }))],
  });
  const { doc } = await runManual(s);

  assert.equal(s.k.calls.length, 2);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses.length, 1);
  assert.equal(doc.analyses[0].summary, "Poprawne.");

  assert.deepEqual(s.k.usageDocs.map((d) => d.attempt), [1, 2]);
  assert.equal(s.k.usageDocs[0].outcome, "invalid_response");
  assert.deepEqual(s.k.usageDocs[0].errorCodes, ["empty_value"]);
  assert.equal(s.k.usageDocs[1].outcome, "success");
  assert.equal(s.k.usageDocs[1].maxFieldLengths.summary, "Poprawne.".length);
});

test(`${tag} dwie niepoprawne odpowiedzi → failed/invalid_response, brak zapisu, poprzednie analizy nietknięte`, async () => {
  const s = setup({
    script: [okResult(validFull({ possibleBiases: "nie lista" })), okResult({ cos: 1 })],
  });
  const previous = {
    analyzedAt: new Date("2026-10-01T10:00:00Z"),
    analysisType: "interim",
    summary: "Wcześniejsza analiza",
    aiModelVersion: "m",
  };
  const { doc } = await runManual(s, { analyses: [previous] });

  assert.equal(s.k.calls.length, 2); // dokładnie jedno ponowienie, nie więcej
  assert.equal(doc.lastAnalysisStatus, "failed");
  assert.equal(doc.lastAnalysisReason, "invalid_response");
  assert.equal(doc.analyses.length, 1);
  assert.equal(doc.analyses[0].summary, "Wcześniejsza analiza");
  assert.equal(s.k.usageDocs.length, 2);
  assert.ok(s.k.usageDocs.every((d) => d.outcome === "invalid_response"));
  assert.ok(s.k.usageDocs[0].errorCodes.includes("invalid_type"));
});

test(`${tag} nie-JSON od klienta (bad_output) → jedno ponowienie; dwa razy → invalid_response`, async () => {
  const retried = setup({
    script: [failResult("bad_output", { httpStatus: 200 }), okResult(validFull())],
  });
  assert.equal((await runManual(retried)).doc.lastAnalysisStatus, "success");
  assert.equal(retried.k.calls.length, 2);
  assert.deepEqual(retried.k.usageDocs.map((d) => d.outcome), ["invalid_response", "success"]);

  await h.reset();
  const twice = setup({
    script: [failResult("bad_output", { httpStatus: 200 }), failResult("bad_output", { httpStatus: 200 })],
  });
  const { doc } = await runManual(twice);
  assert.equal(doc.lastAnalysisStatus, "failed");
  assert.equal(doc.lastAnalysisReason, "invalid_response");
  assert.equal(twice.k.calls.length, 2);
});

test(`${tag} mapowanie rodzaju błędu klienta na powód failed i outcome dziennika`, async () => {
  const table = [
    ["unavailable", 503, "provider_unavailable", "http_error", 1],
    ["unavailable", null, "provider_unavailable", "network_error", 1],
    ["rate_limited", 429, "provider_rate_limited", "http_error", 1],
    ["timeout", null, "timeout", "timeout", 3],
    ["config", 403, "provider_config_error", "http_error", 1],
    ["blocked", 400, "blocked_by_provider", "blocked", 1],
    ["truncated", 200, "truncated_output", "truncated_output", 1],
  ];
  for (const [kind, httpStatus, reason, outcome, tries] of table) {
    await h.reset();
    const s = setup({ script: [failResult(kind, { httpStatus, tries })] });
    const { doc } = await runManual(s);

    assert.equal(doc.lastAnalysisStatus, "failed", kind);
    assert.equal(doc.lastAnalysisReason, reason, kind);
    assert.equal(doc.analyses.length, 0, kind);
    assert.equal(s.k.calls.length, 1, `${kind}: orkiestrator nie ponawia (poza walidatorem)`);
    assert.equal(s.k.usageDocs.length, tries, kind);
    assert.ok(s.k.usageDocs.every((d) => d.outcome === outcome), kind);
    assert.deepEqual(
      s.k.usageDocs.map((d) => d.attempt),
      Array.from({ length: tries }, (_, i) => i + 1),
    );
  }
});

test(`${tag} wszystkie próby klienta (z ponowieniami) trafiają do dziennika; próba udana na końcu`, async () => {
  const failed = failResult("unavailable", { httpStatus: 503, tries: 2 }).attempts;
  const good = okResult(validFull());
  good.attempts = [...failed.map((a) => ({ ...a })), { ...good.attempts[0], attempt: 3 }];
  const s = setup({ script: [good] });
  await runManual(s);

  assert.equal(s.k.usageDocs.length, 3);
  assert.deepEqual(s.k.usageDocs.map((d) => d.outcome), ["http_error", "http_error", "success"]);
  assert.deepEqual(s.k.usageDocs.map((d) => d.httpStatus), [503, 503, null]);
  // czas startu kolejnych prób rośnie o czas poprzednich (bez przerw między ponowieniami)
  const starts = s.k.usageDocs.map((d) => d.startedAt.getTime());
  assert.deepEqual(starts, [T0, T0 + 500, T0 + 1000]);
});

test(`${tag} błąd konfiguracji bez żądania sieciowego → failed, ale bez rekordu dziennika (nie było próby)`, async () => {
  const s = setup({ script: [failResult("config", { tries: 0 })] });
  const { doc } = await runManual(s);
  assert.equal(doc.lastAnalysisReason, "provider_config_error");
  assert.equal(s.k.usageDocs.length, 0);
});

test(`${tag} 429 → provider_rate_limited i pauza ochronna; kolejna rezerwacja jest wstrzymana`, async () => {
  const s = setup({ script: [failResult("rate_limited", { httpStatus: 429 })] });
  const { doc } = await runManual(s);
  assert.equal(doc.lastAnalysisReason, "provider_rate_limited");
  assert.deepEqual(s.k.safeguards.canStartAnalysis(), { ok: false, reason: "ai_paused" });

  const id = await h.insert();
  const again = await s.service.reserveAnalysis({
    positionId: id,
    userId: String((await h.get(id)).userId),
  });
  assert.deepEqual([again.ok, again.kind, again.reason], [false, "unavailable", "ai_paused"]);
});

test(`${tag} udane wywołanie zeruje licznik kolejnych pauz`, async () => {
  const s = setup({ script: [okResult(validFull())] });
  s.k.safeguards.reportRateLimited();
  s.k.advance(s.k.getConfig().pauseBaseMs + 1_000); // pauza wygasła, poziom = 1
  assert.equal(s.k.safeguards.getPauseState().level, 1);
  await runManual(s);
  assert.equal(s.k.safeguards.getPauseState().level, 0);
});

test(`${tag} brak danych rynkowych → failed/market_data_unavailable, model niewywołany, bez rekordu dziennika`, async () => {
  const s = setup({
    script: [],
    fixtureOptions: { marketError: Object.assign(new Error("TAJNY-ADRES?apikey=ABC"), { name: "UpstreamError" }) },
  });
  const { doc } = await runManual(s);

  assert.equal(doc.lastAnalysisStatus, "failed");
  assert.equal(doc.lastAnalysisReason, "market_data_unavailable");
  assert.equal(s.k.calls.length, 0);
  assert.equal(s.k.usageDocs.length, 0);
  assert.equal(stringify([s.k.logs, s.k.builderLogs]).includes("apikey"), false);
});

test(`${tag} brak wiadomości nie przerywa analizy (dataCoverage mówi modelowi o braku)`, async () => {
  const s = setup({
    script: [okResult(validFull())],
    fixtureOptions: { newsError: new Error("awaria newsów") },
  });
  const { doc } = await runManual(s);
  assert.equal(doc.lastAnalysisStatus, "success");
  const sent = extractSentData(s.k.calls[0]);
  assert.deepEqual(sent.news, []);
  assert.equal(sent.dataCoverage.newsAvailable, false);
});

test(`${tag} wynik buildera po rezerwacji: position_not_found/no_actions/action_not_found → failed/internal_error, model niewywołany`, async () => {
  for (const reason of ["position_not_found", "no_actions", "action_not_found"]) {
    await h.reset();
    const { doc, calls } = await createAiAnalysisServiceWithBuilderResult(reason)();
    assert.equal(doc.lastAnalysisStatus, "failed", reason);
    assert.equal(doc.lastAnalysisReason, "internal_error", reason);
    assert.equal(calls.length, 0, reason);
  }
});

/** Pomocnik: orkiestrator, którego builder zwraca zadany powód. */
function createAiAnalysisServiceWithBuilderResult(reason) {
  return async () => {
    const k = createOrchestratorKit({ script: [] });
    let counter = 0;
    const service = createAiAnalysisService({
      PositionModel: h.Position,
      loadUser: async () => k.userState.user,
      safeguards: k.safeguards,
      getConfig: k.getConfig,
      now: () => k.clock.t,
      generateRunId: () => `forced-${++counter}`,
      log: () => {},
    });
    const { createAiOrchestrator } = await import("../services/aiOrchestrator.js");
    const orchestrator = createAiOrchestrator({
      buildModelInput: async () => ({ ok: false, reason }),
      send: k.calls.push.bind(k.calls),
      safeguards: k.safeguards,
      getConfig: k.getConfig,
      loadUser: async () => k.userState.user,
      now: () => k.clock.t,
      log: () => {},
    });
    service.setExecutor(orchestrator.executeFullAnalysis);
    const id = await h.insert();
    const reserved = await service.reserveAnalysis({ positionId: id, userId: String((await h.get(id)).userId) });
    await service.executeReservation(reserved.reservation);
    return { doc: await h.get(id), calls: k.calls };
  };
}

test(`${tag} wyjątki: model, builder → failed/internal_error; nic nie wychodzi poza zadanie w tle`, async () => {
  const boom = setup({ script: [() => { throw new TypeError("zły argument"); }] });
  const r1 = await runManual(boom);
  assert.equal(r1.doc.lastAnalysisStatus, "failed");
  assert.equal(r1.doc.lastAnalysisReason, "internal_error");
  assert.equal(r1.doc.analyses.length, 0);

  await h.reset();
  const badBuilder = setup({ script: [] });
  badBuilder.k.hooks.beforeBuild = async () => {
    throw new Error("awaria buildera");
  };
  const r2 = await runManual(badBuilder);
  assert.equal(r2.doc.lastAnalysisReason, "internal_error");
  assert.equal(badBuilder.k.calls.length, 0);
});

test(`${tag} awaria zapisu dziennika zużycia nie zmienia wyniku analizy`, async () => {
  const s = setup({ script: [okResult(validFull())] });
  s.k.usageModel.failWith = new Error("baza dziennika niedostępna");
  const { doc } = await runManual(s);

  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses.length, 1);
  assert.equal(s.k.usageDocs.length, 0);
  assert.ok(s.k.logs.some((l) => l.event === "usage_log_write_failed"));
});

test(`${tag} warunki zmieniły się po złożeniu danych, przed wysłaniem → skipped, model niewywołany`, async () => {
  const cases = [
    ["ai_disabled", (k) => { k.cfg.enabled = false; }],
    ["ai_not_configured", (k) => { k.cfg.hasApiKey = false; }],
    ["ai_paused", (k) => { k.safeguards.reportRateLimited(); }],
    ["consent_missing", (k) => { k.userState.user = { disclaimerAcceptedAt: null, disclaimerVersion: null }; }],
  ];
  for (const [reason, change] of cases) {
    await h.reset();
    const s = setup({ script: [] });
    s.k.hooks.afterBuild = () => change(s.k);
    const { doc } = await runManual(s);

    assert.equal(doc.lastAnalysisStatus, "skipped", reason);
    assert.equal(doc.lastAnalysisReason, reason, reason);
    assert.equal(s.k.calls.length, 0, reason);
    assert.equal(s.k.usageDocs.length, 0, reason);
    assert.equal(doc.analyses.length, 0, reason);
  }
});

test(`${tag} limit ponowień: trzy niepoprawne odpowiedzi w skrypcie → model wywołany tylko dwa razy`, async () => {
  const s = setup({
    script: [okResult({ cos: 1 }), okResult({ cos: 2 }), okResult(validFull())],
  });
  const { doc } = await runManual(s);
  assert.equal(s.k.calls.length, 2);
  assert.equal(doc.lastAnalysisStatus, "failed");
  assert.equal(doc.lastAnalysisReason, "invalid_response");
  assert.equal(doc.analyses.length, 0);
});

test(`${tag} zgoda wycofana między pierwszym a drugim wywołaniem → failed/invalid_response (NIE skipped), jedno wywołanie, dane nie wychodzą drugi raz`, async () => {
  const firstResults = [
    ["odpowiedź odrzucona przez walidator", () => okResult(validFull({ summary: "" }))],
    ["nie-JSON (bad_output)", () => failResult("bad_output", { httpStatus: 200 })],
  ];
  for (const [name, makeFirst] of firstResults) {
    await h.reset();
    let t = null;
    t = setup({
      script: [
        async () => {
          // użytkownik wycofuje zgodę, gdy pierwsza odpowiedź jest w drodze
          t.k.userState.user = { disclaimerAcceptedAt: null, disclaimerVersion: null };
          return makeFirst();
        },
        okResult(validFull()),
      ],
    });
    const { doc } = await runManual(t);

    assert.equal(doc.lastAnalysisStatus, "failed", name);
    assert.equal(doc.lastAnalysisReason, "invalid_response", name);
    assert.equal(t.k.calls.length, 1, name);
    assert.equal(doc.analyses.length, 0, name);
    // Wywołanie było zapłacone, więc jest w dzienniku (skipped znaczyłoby „modelu nie wywołano”).
    assert.equal(t.k.usageDocs.length, 1, name);
    assert.equal(t.k.usageDocs[0].outcome, "invalid_response", name);
  }
});

test(`${tag} zgoda sprawdzana raz przed każdym wywołaniem modelu (bez zdublowanego odczytu)`, async () => {
  const one = setup({ script: [okResult(validFull())] });
  await runManual(one);
  assert.equal(one.k.userState.loads, 1);

  await h.reset();
  const two = setup({ script: [okResult(validFull({ summary: "" })), okResult(validFull())] });
  await runManual(two);
  assert.equal(two.k.userState.loads, 2);
});

test(`${tag} spóźniony wynik: pozycja usunięta w trakcie → write_rejected, brak analizy, dziennik write_rejected`, async () => {
  const id = await h.insert();
  const s = setup({
    script: [
      async () => {
        await h.setFields(id, { deletedAt: new Date() });
        return okResult(validFull());
      },
    ],
  });
  const userId = String((await h.get(id)).userId);
  const reserved = await s.service.reserveAnalysis({ positionId: id, userId });
  await s.service.executeReservation(reserved.reservation);

  const doc = await h.get(id);
  assert.equal(doc.analyses.length, 0);
  assert.equal(s.k.usageDocs.length, 1);
  assert.equal(s.k.usageDocs[0].outcome, "write_rejected");
  assert.ok(s.serviceLogs.some((l) => l.event === "write_rejected"));

  // Pozycja jest ukryta — domykamy stan testu (zapis serwisu jej nie dotyka).
  await h.setFields(id, { lastAnalysisStatus: "failed" });
});

test(`${tag} starsze uruchomienie (przejęte przez nowsze) nie nadpisuje wyniku nowszego`, async () => {
  const id = await h.insert();
  const userId = String((await h.get(id)).userId);
  const gate = deferred();
  const s = setup({
    script: [async () => { await gate.promise; return okResult(validFull({ summary: "STARSZE" })); }, okResult(validFull({ summary: "NOWSZE" }))],
  });

  const first = (await s.service.reserveAnalysis({ positionId: id, userId })).reservation;
  const slow = s.service.executeReservation(first);

  // Minęło więcej niż AI_STALE_PENDING_MS → drugie uruchomienie przejmuje pozycję.
  s.k.advance(s.k.getConfig().stalePendingMs + 1_000);
  const second = (await s.service.reserveAnalysis({ positionId: id, userId })).reservation;
  await s.service.executeReservation(second);
  gate.resolve();
  await slow;

  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisRunId, second.runId);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses.length, 1);
  assert.equal(doc.analyses[0].summary, "NOWSZE");
  assert.ok(s.k.usageDocs.some((d) => d.analysisRunId === first.runId && d.outcome === "write_rejected"));
});

test(`${tag} ostrzeżenia walidatora: kody w dzienniku, kody + bezpieczne ścieżki w logu, bez treści`, async () => {
  const response = validFull({
    possibleBiases: [
      { bias: "Całkiem nieznany bias użytkownika", confidence: "HIGH", supportingEvidence: "Dowód" },
    ],
    pole_wymyslone_przez_model_SEKRET: "x",
    analysisRunId: "podrobione",
  });
  const s = setup({ script: [okResult(response)] });
  const { doc } = await runManual(s);

  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses[0].possibleBiases[0].proposedLabel, "Całkiem nieznany bias użytkownika");
  assert.notEqual(doc.analyses[0].analysisRunId, "podrobione");

  const codes = s.k.usageDocs[0].warningCodes;
  for (const code of ["bias_unmapped", "confidence_normalized", "unknown_field_removed", "backend_field_removed"]) {
    assert.ok(codes.includes(code), code);
  }

  const line = s.k.logs.find((l) => l.event === "validator_warnings");
  assert.ok(line);
  const byCode = Object.fromEntries(line.warnings.map((w) => [w.code, w.path]));
  assert.equal(byCode.bias_unmapped, "possibleBiases[0].bias");
  assert.equal(byCode.confidence_normalized, "possibleBiases[0].confidence");
  assert.equal(byCode.backend_field_removed, "analysisRunId");
  assert.equal(byCode.unknown_field_removed, "?"); // nazwa pola wymyślona przez model nie trafia do logu
  const dump = stringify([s.k.logs, s.k.usageDocs]);
  assert.equal(dump.includes("SEKRET"), false);
  assert.equal(dump.includes("Całkiem nieznany bias"), false);
});

test(`${tag} dziennik i logi nie zawierają treści użytkownika, odpowiedzi modelu ani klucza API`, async () => {
  const s = setup({ script: [okResult(validFull())] });
  const { doc } = await runManual(s);
  const dump = stringify([s.k.usageDocs, s.k.logs, s.serviceLogs, s.k.builderLogs]);

  for (const secret of [TEXT.r1, TEXT.e1, TEXT.r2, TEXT.r3, SECRET_ANSWER, "test-key-not-real"]) {
    assert.equal(dump.includes(secret), false, secret);
  }
  // …a w samej analizie (miejscu docelowym) odpowiedź modelu jest.
  assert.ok(stringify(doc.analyses).includes(SECRET_ANSWER));
  assert.equal(stringify(doc).includes("test-key-not-real"), false);
});

test(`${tag} analiza po close: start automatyczny przez serwis → trigger auto_after_close, typ final`, async () => {
  const s = setup({ script: [okResult(validFull())] });
  const id = await h.insert({
    status: "closed",
    closedAt: new Date("2026-10-20T10:00:00Z"),
    currentQuantity: 0,
    finalAnalysisRequestedAt: new Date("2026-10-20T10:00:00Z"),
  });
  const started = await s.service.tryStartFinalAnalysis(id);
  assert.equal(started.started, true);
  await started.done;

  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses.length, 1);
  assert.equal(doc.analyses[0].analysisType, "final");
  assert.ok(doc.analyses[0].analysisRunId.startsWith("final-auto:"));
  assert.equal(doc.finalAnalysisRequestedAt, null);
  assert.equal(s.k.usageDocs[0].trigger, "auto_after_close");
});

test(`${tag} close w trakcie trwającej analizy: po jej końcu startuje dokładnie jedna analiza końcowa (jeden mechanizm)`, async () => {
  const gate = deferred();
  const s = setup({
    script: [
      async () => { await gate.promise; return okResult(validFull({ summary: "ŚRÓDROCZNA" })); },
      okResult(validFull({ summary: "KOŃCOWA" })),
    ],
  });
  const id = await h.insert();
  const userId = String((await h.get(id)).userId);
  const reserved = await s.service.reserveAnalysis({ positionId: id, userId });
  const running = s.service.executeReservation(reserved.reservation);

  // „close” w trakcie: pozycja zamknięta + znacznik (jak w transakcji 8.10.3)
  await h.setFields(id, { status: "closed", closedAt: new Date(), currentQuantity: 0, finalAnalysisRequestedAt: new Date() });
  const early = await s.service.tryStartFinalAnalysis(id);
  assert.equal(early.started, false); // zajęte — znacznik czeka w bazie

  gate.resolve();
  await running;

  const doc = await h.get(id);
  assert.equal(s.k.calls.length, 2);
  assert.deepEqual(doc.analyses.map((a) => a.analysisType), ["interim", "final"]);
  assert.deepEqual(doc.analyses.map((a) => a.summary), ["ŚRÓDROCZNA", "KOŃCOWA"]);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.finalAnalysisRequestedAt, null);
  assert.deepEqual(s.k.usageDocs.map((d) => d.trigger), ["manual", "auto_after_close"]);
});

test(`${tag} żadna ścieżka nie zostawia pending: sukces, błąd, skip i wyjątek kończą się statusem końcowym`, async () => {
  const scenarios = [
    [okResult(validFull()), "success"],
    [failResult("timeout", { tries: 3 }), "failed"],
    [() => { throw new Error("x"); }, "failed"],
  ];
  for (const [step, expected] of scenarios) {
    await h.reset();
    const s = setup({ script: [step] });
    const { doc } = await runManual(s);
    assert.equal(doc.lastAnalysisStatus, expected);
    assert.notEqual(doc.lastAnalysisStatus, "pending");
  }
});

test("server.js: wykonawca jest podłączany po połączeniu z bazą i przed odzyskiwaniem oraz przeglądem", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const connect = src.indexOf("await connectDB()");
  const wire = src.indexOf("aiAnalysisService.setExecutor(aiOrchestrator.executeFullAnalysis)");
  const recover = src.indexOf("aiAnalysisService.recoverAfterRestart()");
  const scheduler = src.indexOf("aiAnalysisService.startRecoveryScheduler(");
  assert.ok(connect > -1 && wire > connect, "setExecutor po connectDB");
  assert.ok(recover > wire, "odzyskiwanie po podłączeniu wykonawcy");
  assert.ok(scheduler > wire, "przegląd po podłączeniu wykonawcy");
});

test("usage() i okResult() zgodne z kontraktem klienta (pola, których używa orkiestrator)", () => {
  const r = okResult({});
  assert.deepEqual(Object.keys(usage()).sort(), ["input", "output", "reasoning", "total"]);
  for (const key of ["ok", "value", "usage", "modelVersion", "finishReason", "attempts", "requestSettings"]) {
    assert.ok(key in r, key);
  }
  assert.deepEqual(Object.keys(r.requestSettings).sort(), ["apiRevision", "maxOutputTokens", "store", "thinkingLevel"]);
  assert.equal(createFakeSend([]).calls.length, 0);
});

test(`${tag} pauza po 429 włączona w trakcie odczytu zgody → model niewywołany, analiza skipped/ai_paused`, async () => {
  const s = setup({ script: [okResult(validFull())] });
  s.k.userState.onLoad = async () => {
    await new Promise((r) => setTimeout(r, 5));
    s.k.safeguards.reportRateLimited(); // inne żądanie dostało 429, gdy trwał odczyt użytkownika
  };
  const { doc } = await runManual(s);
  assert.equal(doc.lastAnalysisStatus, "skipped");
  assert.equal(doc.lastAnalysisReason, "ai_paused");
  assert.equal(s.k.calls.length, 0);
  assert.equal(s.k.usageDocs.length, 0);
});
