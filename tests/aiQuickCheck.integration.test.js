import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
  createOrchestratorKit,
  okResult,
  failResult,
  validQuick,
  extractSentData,
  stringify,
  REQUEST_SETTINGS,
  SECRET_ANSWER,
  KNOWN_BIAS,
  T0,
} from "./helpers/aiOrchestratorKit.js";
import { deferred } from "./helpers/aiServiceKit.js";
import { IDS, TEXT } from "./helpers/aiInputKit.js";
import { validateEarlyAiCheckEntry } from "../services/aiOrchestrator.js";
import { PROMPT_VERSION } from "../utils/aiPrompt.js";
import { DEFAULT_GEMINI_MODEL } from "../config/aiConfig.js";
import { QUICK_CHECK_TOTAL_TIMEOUT_MS } from "../services/aiOrchestrator.js";

/* Etap 8.9.4 — synchroniczny quick-check. Atrapy kolekcji w pamięci (tryb "fake"):
 * logika orkiestratora, strażnik właściciela, blokada „w toku” i warunkowy zapis.
 * Atomowość zapisu w prawdziwym MongoDB tym testem NIE jest dowiedziona. */

const tag = "[fake]";

before(() => {
  globalThis.__realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Test wywołał globalny fetch — zakaz sieci w testach 8.9");
  };
});
after(() => {
  globalThis.fetch = globalThis.__realFetch;
});

/** Czeka, aż uruchomienie dojdzie do wywołania modelu (trwa „w toku”). */
async function untilModelCalled(k, count = 1) {
  const deadline = Date.now() + 5_000;
  while (k.calls.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(k.calls.length >= count, "uruchomienie nie doszło do wywołania modelu");
}

const doc = (k, id) => k.actions._docs.find((d) => String(d._id) === String(id));
const foreignActionId = (k) =>
  k.actions._docs.find((d) => d.reasoning === "OBCY-UZYTKOWNIK-W-TEJ-POZYCJI")._id;

test(`${tag} sukces: wynik zapisany w Action.earlyAiCheck z identyfikatorem, czasem startu i migawką`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  const before = doc(k, IDS.action2).earlyAiCheck;
  assert.equal(before.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU"); // starszy wpis bez runStartedAt

  const result = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(result.ok, true);
  assert.equal(result.analysisRunId, "run-1");
  assert.equal(result.earlyAiCheck.inputSnapshot, undefined);

  const saved = doc(k, IDS.action2).earlyAiCheck;
  assert.equal(saved.summary, validQuick().summary);
  assert.deepEqual(saved.possibleBiases, [KNOWN_BIAS]);
  assert.deepEqual(saved.proposedBiasLabels, []);
  assert.equal(saved.limitations, "Krótka ocena.");
  assert.equal(saved.aiModelVersion, DEFAULT_GEMINI_MODEL);
  assert.equal(saved.promptVersion, PROMPT_VERSION);
  assert.equal(saved.analysisRunId, "run-1");
  assert.equal(saved.runStartedAt.getTime(), T0);
  assert.ok(saved.analyzedAt instanceof Date);
  assert.deepEqual(saved.inputSnapshot.modelInput, extractSentData(k.calls[0]));
  assert.deepEqual(saved.inputSnapshot.meta.requestSettings, REQUEST_SETTINGS);
  assert.equal(saved.inputSnapshot.meta.requestedModel, DEFAULT_GEMINI_MODEL);
  assert.equal((await validateEarlyAiCheckEntry(saved)).ok, true);

  // Dziennik: jedna próba quick-checka z identyfikatorem akcji.
  assert.equal(k.usageDocs.length, 1);
  const u = k.usageDocs[0];
  assert.equal(u.kind, "quickCheck");
  assert.equal(u.trigger, "manual");
  assert.equal(String(u.actionId), String(IDS.action2));
  assert.equal(String(u.positionId), String(IDS.position));
  assert.equal(u.outcome, "success");
  assert.equal(u.maxFieldLengths.possibleBiasName, KNOWN_BIAS.length);

  // Pozostałe akcje nietknięte.
  assert.equal(doc(k, IDS.action1).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
});

test(`${tag} zakres danych: tylko ta akcja i wcześniejsze, bez cudzych danych, dane rynkowe do ostatniej zakończonej sesji`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  await k.orchestrator.runQuickCheck(k.qc(IDS.action2));

  const sent = extractSentData(k.calls[0]);
  assert.deepEqual(sent.actions.map((a) => a.sequenceNo), [1, 2]);
  assert.equal(sent.positionStatus, "open"); // pozycja zamknięta później nie jest ujawniana
  const dump = stringify(k.calls[0]);
  for (const forbidden of [TEXT.r3, "OBCY-UZYTKOWNIK", "CUDZE-UZASADNIENIE", "WCZESNA-ANALIZA"]) {
    assert.equal(dump.includes(forbidden), false, forbidden);
  }
  assert.ok(dump.includes("UZASADNIENIE-2"));
  assert.ok(k.marketCalls[0].upTo, "zapytanie o dane rynkowe jest ograniczone czasowo");
  assert.ok(sent.marketContext.bars.every((b) => b.date <= k.marketCalls[0].upTo));
  assert.equal(extractSentData(k.calls[0]).dataCoverage.analysisMoment, "2026-10-15T15:30:00.000Z");

  // Limit czasu quick-checka jest mniejszy niż domyślny dla pełnej analizy.
  assert.equal(k.calls[0].kind, "quickCheck");
  assert.equal(k.calls[0].limits.totalTimeoutMs, 45_000);
  assert.ok(k.calls[0].limits.timeoutMs <= 30_000);
});

test(`${tag} dwa równoległe quick-checki tej samej akcji → jeden wykonany, drugi busy; blokada zwalniana po końcu`, async () => {
  const gate = deferred();
  const k = createOrchestratorKit({
    script: [async () => { await gate.promise; return okResult(validQuick()); }, okResult(validQuick({ summary: "Drugi." }))],
  });
  const first = k.orchestrator.runQuickCheck(k.qc());
  await untilModelCalled(k);
  const second = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([second.ok, second.kind], [false, "busy"]);
  assert.equal(k.calls.length, 1);

  gate.resolve();
  assert.equal((await first).ok, true);

  k.advance(5_000); // kolejne uruchomienie startuje później niż poprzednie (runStartedAt rośnie)
  const third = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(third.ok, true);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "Drugi.");
});

test(`${tag} równoległe quick-checki RÓŻNYCH akcji nie blokują się`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick()), okResult(validQuick())] });
  const [a, b] = await Promise.all([
    k.orchestrator.runQuickCheck(k.qc(IDS.action1)),
    k.orchestrator.runQuickCheck(k.qc(IDS.action2)),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test(`${tag} blokada jest zwalniana także po błędzie`, async () => {
  const k = createOrchestratorKit({
    script: [failResult("unavailable", { httpStatus: 503 }), okResult(validQuick())],
  });
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).kind, "model_failed");
  assert.equal(k.safeguards.isQuickCheckRunning(`${IDS.userA}:${IDS.action2}`), false);
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).ok, true);
});

test(`${tag} starsza odpowiedź nie nadpisuje nowszej (warunek runStartedAt)`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick({ summary: "STARSZA" }))] });
  // „Nowsze uruchomienie” zdążyło zapisać wynik, zanim moje (starsze) doszło do zapisu.
  k.actions.beforeUpdate = async () => {
    doc(k, IDS.action2).earlyAiCheck = {
      analyzedAt: new Date(T0 + 90_000),
      summary: "NOWSZA",
      possibleBiases: [],
      limitations: "",
      aiModelVersion: "m",
      analysisRunId: "newer-run",
      runStartedAt: new Date(T0 + 60_000),
    };
  };

  const result = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([result.ok, result.kind], [false, "write_rejected"]);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "NOWSZA");
  assert.equal(doc(k, IDS.action2).earlyAiCheck.analysisRunId, "newer-run");
  assert.equal(k.usageDocs.length, 1);
  assert.equal(k.usageDocs[0].outcome, "write_rejected");
});

test(`${tag} nowsze uruchomienie zastępuje starszy wynik z Etapu 8 (runStartedAt wcześniejsze)`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick({ summary: "NOWA" }))] });
  doc(k, IDS.action2).earlyAiCheck = {
    analyzedAt: new Date(T0 - 100_000),
    summary: "STARA",
    possibleBiases: [],
    limitations: "",
    aiModelVersion: "m",
    analysisRunId: "old-run",
    runStartedAt: new Date(T0 - 60_000),
  };
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).ok, true);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "NOWA");
});

test(`${tag} własność: cudza pozycja, cudza akcja, akcja z innej pozycji, złe identyfikatory → not_found, model niewywołany`, async () => {
  const k = createOrchestratorKit({ script: [] });
  const oid = () => new mongoose.Types.ObjectId();
  const cases = {
    "inny użytkownik, moja pozycja": { userId: IDS.userB, positionId: IDS.position, actionId: IDS.action2 },
    "moja pozycja, nieistniejąca akcja": { userId: IDS.userA, positionId: IDS.position, actionId: oid() },
    "cudza pozycja": { userId: IDS.userA, positionId: IDS.otherPosition, actionId: IDS.action2 },
    "akcja innego użytkownika w mojej pozycji": { userId: IDS.userA, positionId: IDS.position, actionId: foreignActionId(k) },
    "zły format identyfikatora": { userId: IDS.userA, positionId: "nie-id", actionId: IDS.action2 },
    "brak identyfikatora akcji": { userId: IDS.userA, positionId: IDS.position, actionId: undefined },
  };
  for (const [name, args] of Object.entries(cases)) {
    const result = await k.orchestrator.runQuickCheck(args);
    assert.deepEqual([result.ok, result.kind], [false, "not_found"], name);
  }
  assert.equal(k.calls.length, 0);
  assert.equal(k.usageDocs.length, 0);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
});

test(`${tag} cudzy identyfikator dostaje 404, a nie 409, nawet gdy właściciel ma quick-check w toku`, async () => {
  const gate = deferred();
  const k = createOrchestratorKit({ script: [async () => { await gate.promise; return okResult(validQuick()); }] });
  const running = k.orchestrator.runQuickCheck(k.qc());
  await untilModelCalled(k);
  const stranger = await k.orchestrator.runQuickCheck({ ...k.qc(), userId: IDS.userB });
  assert.equal(stranger.kind, "not_found");
  gate.resolve();
  await running;
});

test(`${tag} pozycja usunięta: przed wywołaniem → not_found; w trakcie wywołania → not_found i brak zapisu`, async () => {
  const before = createOrchestratorKit({ script: [] });
  before.fixture.positions._docs.find((p) => String(p._id) === String(IDS.position)).deletedAt = new Date();
  assert.equal((await before.orchestrator.runQuickCheck(before.qc())).kind, "not_found");
  assert.equal(before.calls.length, 0);

  const during = createOrchestratorKit({
    script: [
      async () => {
        during.fixture.positions._docs.find((p) => String(p._id) === String(IDS.position)).deletedAt = new Date();
        return okResult(validQuick());
      },
    ],
  });
  const result = await during.orchestrator.runQuickCheck(during.qc());
  assert.equal(result.kind, "not_found");
  assert.equal(doc(during, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  assert.equal(during.usageDocs[0].outcome, "write_rejected"); // model był wywołany, wyniku nie zapisano
});

test(`${tag} brak danych rynkowych → market_data_unavailable, bez wywołania modelu i bez zapisu earlyAiCheck`, async () => {
  const k = createOrchestratorKit({
    script: [],
    fixtureOptions: { marketError: new Error("upstream down") },
  });
  const result = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([result.ok, result.kind], [false, "market_data_unavailable"]);
  assert.equal(k.calls.length, 0);
  assert.equal(k.usageDocs.length, 0);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  assert.equal(k.safeguards.isQuickCheckRunning(`${IDS.userA}:${IDS.action2}`), false);
});

test(`${tag} warunki: wyłączone AI, brak konfiguracji, pauza, brak zgody — przed i tuż przed wysłaniem`, async () => {
  const before = [
    ["ai_disabled", { cfg: { enabled: false } }],
    ["ai_not_configured", { cfg: { hasApiKey: false } }],
  ];
  for (const [reason, options] of before) {
    const k = createOrchestratorKit({ script: [], ...options });
    const r = await k.orchestrator.runQuickCheck(k.qc());
    assert.deepEqual([r.ok, r.kind, r.reason], [false, "unavailable", reason], reason);
    assert.equal(k.calls.length, 0);
  }

  const paused = createOrchestratorKit({ script: [] });
  paused.safeguards.reportRateLimited();
  const rp = await paused.orchestrator.runQuickCheck(paused.qc());
  assert.deepEqual([rp.kind, rp.reason], ["unavailable", "ai_paused"]);

  const noConsent = createOrchestratorKit({ script: [], user: { disclaimerAcceptedAt: null, disclaimerVersion: null } });
  assert.equal((await noConsent.orchestrator.runQuickCheck(noConsent.qc())).kind, "consent_missing");
  assert.equal(noConsent.calls.length, 0);

  // zmiana stanu między złożeniem danych a wysłaniem
  const late = createOrchestratorKit({ script: [] });
  late.hooks.afterBuild = () => {
    late.userState.user = { disclaimerAcceptedAt: null, disclaimerVersion: null };
  };
  assert.equal((await late.orchestrator.runQuickCheck(late.qc())).kind, "consent_missing");
  assert.equal(late.calls.length, 0);
  assert.equal(late.safeguards.isQuickCheckRunning(`${IDS.userA}:${IDS.action2}`), false);
});

test(`${tag} błędy modelu: powód z FAILED_REASONS, 429 włącza pauzę, bez zapisu earlyAiCheck`, async () => {
  const table = [
    ["unavailable", 503, "provider_unavailable", 1],
    ["rate_limited", 429, "provider_rate_limited", 1],
    ["timeout", null, "timeout", 3],
    ["config", 401, "provider_config_error", 1],
    ["blocked", 400, "blocked_by_provider", 1],
    ["truncated", 200, "truncated_output", 1],
  ];
  for (const [kind, httpStatus, reason, tries] of table) {
    const k = createOrchestratorKit({ script: [failResult(kind, { httpStatus, tries })] });
    const r = await k.orchestrator.runQuickCheck(k.qc());
    assert.deepEqual([r.ok, r.kind, r.reason], [false, "model_failed", reason], kind);
    assert.equal(k.calls.length, 1, kind);
    assert.equal(k.usageDocs.length, tries, kind);
    assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU", kind);
    if (kind === "rate_limited") {
      assert.deepEqual(k.safeguards.canStartAnalysis(), { ok: false, reason: "ai_paused" });
    }
  }
});

test(`${tag} odpowiedź odrzucona przez walidator: jedno ponowienie, potem invalid_response bez zapisu`, async () => {
  const retried = createOrchestratorKit({
    script: [okResult(validQuick({ summary: "  " })), okResult(validQuick({ summary: "Poprawne." }))],
  });
  const ok = await retried.orchestrator.runQuickCheck(retried.qc());
  assert.equal(ok.ok, true);
  assert.equal(retried.calls.length, 2);
  assert.deepEqual(retried.usageDocs.map((d) => [d.attempt, d.outcome]), [[1, "invalid_response"], [2, "success"]]);
  assert.deepEqual(retried.usageDocs[0].errorCodes, ["empty_value"]);

  const twice = createOrchestratorKit({
    script: [okResult({ summary: "x" }), okResult({ possibleBiases: [] })],
  });
  const bad = await twice.orchestrator.runQuickCheck(twice.qc());
  assert.deepEqual([bad.ok, bad.kind, bad.reason], [false, "model_failed", "invalid_response"]);
  assert.equal(twice.calls.length, 2);
  assert.equal(doc(twice, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
});

test(`${tag} ponowienie po walidatorze tylko w limicie czasu quick-checka`, async () => {
  const k = createOrchestratorKit({
    script: [
      async () => {
        k.advance(43_000); // zostaje 2 s < QUICK_CHECK_MIN_RETRY_MS
        return okResult({ summary: "x" });
      },
    ],
  });
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.kind, r.reason], ["model_failed", "invalid_response"]);
  assert.equal(k.calls.length, 1);
});

test(`${tag} pauza ustawiona w międzyczasie blokuje ponowienie po odrzuceniu przez walidator`, async () => {
  const k = createOrchestratorKit({
    script: [
      () => {
        k.safeguards.reportRateLimited(); // 429 u innego uruchomienia
        return okResult({ summary: "x" });
      },
    ],
  });
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(r.reason, "invalid_response");
  assert.equal(k.calls.length, 1);
});

test(`${tag} ostrzeżenia walidatora: nieznany bias → proposedBiasLabels i kod w dzienniku, bez treści w logach`, async () => {
  const k = createOrchestratorKit({
    script: [okResult(validQuick({ possibleBiases: [KNOWN_BIAS.toUpperCase(), "Mój własny bias SEKRET", KNOWN_BIAS], dodatkowe_pole: 1 }))],
  });
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(r.ok, true);

  const saved = doc(k, IDS.action2).earlyAiCheck;
  assert.deepEqual(saved.proposedBiasLabels, ["Mój własny bias SEKRET"]);
  const codes = k.usageDocs[0].warningCodes;
  for (const code of ["bias_unmapped", "duplicate_bias", "unknown_field_removed"]) {
    assert.ok(codes.includes(code), code);
  }
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), [...r.warnings.map((w) => w.code)].sort());

  const dump = stringify([k.logs, k.usageDocs]);
  assert.equal(dump.includes("SEKRET"), false);
  assert.equal(dump.includes("dodatkowe_pole"), false);
  assert.equal(dump.includes(SECRET_ANSWER), false);
  assert.equal(dump.includes(TEXT.r2), false);
});

test(`${tag} wyjątki: model i builder → wynik, nie wyjątek; blokada zwolniona`, async () => {
  const modelBoom = createOrchestratorKit({ script: [() => { throw new TypeError("zły argument"); }] });
  const r1 = await modelBoom.orchestrator.runQuickCheck(modelBoom.qc());
  assert.deepEqual([r1.ok, r1.kind, r1.reason], [false, "model_failed", "internal_error"]);

  const builderBoom = createOrchestratorKit({ script: [] });
  builderBoom.hooks.beforeBuild = async () => { throw new Error("awaria"); };
  const r2 = await builderBoom.orchestrator.runQuickCheck(builderBoom.qc());
  assert.deepEqual([r2.ok, r2.kind], [false, "internal_error"]);
  assert.equal(builderBoom.safeguards.isQuickCheckRunning(`${IDS.userA}:${IDS.action2}`), false);
});

test(`${tag} awaria dziennika zużycia nie zmienia wyniku quick-checka`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  k.usageModel.failWith = new Error("dziennik niedostępny");
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(r.ok, true);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, validQuick().summary);
});

test(`${tag} dokument niezgodny ze schematem nie trafia do bazy (internal_error)`, async () => {
  const bad = await validateEarlyAiCheckEntry({ summary: "x" }); // brak analyzedAt, aiModelVersion
  assert.equal(bad.ok, false);
  assert.ok(bad.paths.length > 0);
});


test(`${tag} deadline upływa podczas budowania danych → model nie jest wywoływany`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  k.hooks.beforeBuild = () => k.advance(QUICK_CHECK_TOTAL_TIMEOUT_MS + 1);

  // Limit czasu PRZED wywołaniem modelu to osobny rodzaj wyniku (nie awaria modelu).
  const result = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([result.ok, result.kind, result.phase], [false, "timeout", "preparation"]);
  assert.equal(result.reason, undefined);
  assert.equal(k.calls.length, 0);
  assert.equal(k.usageDocs.length, 0); // modelu nie wywołano, więc nie ma rekordu zużycia
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  assert.equal(k.safeguards.isQuickCheckRunning(`${IDS.userA}:${IDS.action2}`), false);
});

test(`${tag} odpowiedź modelu po deadline nie jest walidowana ani zapisywana`, async () => {
  const k = createOrchestratorKit({
    script: [async () => {
      k.advance(QUICK_CHECK_TOTAL_TIMEOUT_MS + 1);
      return okResult(validQuick());
    }],
  });

  const result = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([result.ok, result.kind, result.reason], [false, "model_failed", "timeout"]);
  assert.equal(k.calls.length, 1);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  assert.equal(k.usageDocs.at(-1).outcome, "timeout");
  // Tokeny zapisane, a kod odróżnia limit aplikacji od limitu dostawcy.
  assert.equal(k.usageDocs.at(-1).totalTokens, 1500);
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["deadline_exceeded"]);
});

test(`${tag} wycofanie zgody blokuje ponowienie tuż przed kolejnym wywołaniem`, async () => {
  const k = createOrchestratorKit({
    script: [async () => {
      k.userState.user = { disclaimerAcceptedAt: null, disclaimerVersion: null };
      return okResult({ summary: "x" });
    }],
  });

  const result = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([result.ok, result.kind], [false, "consent_missing"]);
  assert.equal(k.calls.length, 1);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  // Pierwsze wywołanie zostało zapłacone, więc zostaje w dzienniku.
  assert.deepEqual(k.usageDocs.map((d) => d.outcome), ["invalid_response"]);
});

/* ---------------------------------------------------------------------------
 * Poprawki po przeglądzie syntezy C+M (limit ponowień, czas, zapis, blokada)
 * ------------------------------------------------------------------------ */

const lockKeyOf = (k) => `${IDS.userA}:${IDS.action2}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms = 3_000) {
  const stop = Date.now() + ms;
  while (!predicate() && Date.now() < stop) await sleep(5);
  assert.ok(predicate(), "warunek nie został spełniony w czasie");
}

test(`${tag} limit ponowień: trzy niepoprawne odpowiedzi w skrypcie → model wywołany tylko dwa razy`, async () => {
  const k = createOrchestratorKit({
    script: [okResult({ summary: "x" }), okResult({ summary: "y" }), okResult(validQuick())],
  });
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.reason], [false, "model_failed", "invalid_response"]);
  assert.equal(k.calls.length, 2);
  assert.equal(k.usageDocs.length, 2);

  const bad = createOrchestratorKit({
    script: [failResult("bad_output", { httpStatus: 200 }), failResult("bad_output", { httpStatus: 200 }), okResult(validQuick())],
  });
  assert.equal((await bad.orchestrator.runQuickCheck(bad.qc())).reason, "invalid_response");
  assert.equal(bad.calls.length, 2);
});

test(`${tag} zgoda sprawdzana tuż przed wywołaniem bez zbędnych odczytów: start + przed wysłaniem`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).ok, true);
  assert.equal(k.userState.loads, 2);

  const retried = createOrchestratorKit({
    script: [okResult({ summary: "x" }), okResult(validQuick())],
  });
  assert.equal((await retried.orchestrator.runQuickCheck(retried.qc())).ok, true);
  assert.equal(retried.userState.loads, 3); // start + przed każdym z dwóch wywołań
});

test(`${tag} zapis potwierdzony przez bazę po terminie jest sukcesem (nie timeoutem)`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick({ summary: "ZAPISANE" }))] });
  // Zapis zaczyna się przed końcem limitu, a baza potwierdza go dopiero po jego upływie.
  k.actions.beforeUpdate = async () => k.advance(QUICK_CHECK_TOTAL_TIMEOUT_MS + 1_000);

  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(r.ok, true);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "ZAPISANE");
  assert.equal(k.usageDocs.at(-1).outcome, "success");
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, []);
});

test(`${tag} baza przerwała zapis (maxTimeMS, kod 50) → timeout/save, nic nie zapisano, powód w dzienniku`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  k.actions.beforeUpdate = async () => {
    throw Object.assign(new Error("operation exceeded time limit"), { code: 50, codeName: "MaxTimeMSExpired" });
  };
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.phase], [false, "timeout", "save"]);
  assert.equal(r.writeUnconfirmed, undefined);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  assert.equal(k.usageDocs.at(-1).outcome, "timeout");
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["save_timeout"]);
});

test(`${tag} zapis dostaje maxTimeMS z własnego budżetu, nie z reszty 45 s; budżet 0 → timeout bez zapytania do bazy`, async () => {
  let seen = null;
  const k = createOrchestratorKit({ script: [okResult(validQuick())], orchestratorOptions: { saveBudgetMs: 2_500 } });
  const original = k.actions.findOneAndUpdate;
  k.actions.findOneAndUpdate = function (filter, update, options) {
    seen = options.maxTimeMS;
    return original.call(this, filter, update, options);
  };
  k.hooks.afterBuild = () => k.advance(40_000); // do końca 45 s zostało tylko 5 s
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).ok, true);
  assert.equal(seen, 2_500);

  let updates = 0;
  const none = createOrchestratorKit({ script: [okResult(validQuick())], orchestratorOptions: { saveBudgetMs: 0 } });
  none.actions.beforeUpdate = async () => { updates += 1; };
  const r = await none.orchestrator.runQuickCheck(none.qc());
  assert.deepEqual([r.kind, r.phase], ["timeout", "save"]);
  assert.equal(updates, 0);
  assert.equal(doc(none, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
});

test(`${tag} brak odpowiedzi bazy po budżecie zapisu → timeout/save z writeUnconfirmed; blokada trzymana, potem zwolniona`, async () => {
  const k = createOrchestratorKit({
    script: [okResult(validQuick()), okResult(validQuick())],
    orchestratorOptions: { saveBudgetMs: 20, saveSlackMs: 20, lockMaxHoldMs: 200 },
  });
  k.actions.beforeUpdate = () => new Promise(() => {}); // baza nigdy nie odpowiada
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.phase, r.writeUnconfirmed], [false, "timeout", "save", true]);
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["save_timeout", "write_unconfirmed"]);

  // Operacja zapisu nadal trwa → drugi quick-check tej akcji jest odrzucony jako „w toku”.
  assert.equal(k.safeguards.isQuickCheckRunning(lockKeyOf(k)), true);
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).kind, "busy");
  assert.equal(k.calls.length, 1);

  // Zabezpieczenie: operacja, która nigdy się nie kończy, nie blokuje akcji na stałe.
  await until(() => k.safeguards.isQuickCheckRunning(lockKeyOf(k)) === false);
  assert.ok(k.logs.some((l) => l.event === "quick_check_lock_force_released"));
});

test(`${tag} zapis dziennika po upływie terminu dostaje własny budżet (rekord zużycia nie ginie)`, async () => {
  const k = createOrchestratorKit({
    script: [async () => {
      k.advance(QUICK_CHECK_TOTAL_TIMEOUT_MS + 1);
      return okResult(validQuick());
    }],
  });
  const create = k.usageModel.create;
  k.usageModel.create = async (d) => {
    await sleep(60); // baza odpowiada wolno, ale w zwykłym budżecie loggera
    return create(d);
  };
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.reason], [false, "model_failed", "timeout"]);
  assert.equal(k.usageDocs.length, 1);
  assert.equal(k.usageDocs[0].outcome, "timeout");
  assert.equal(k.usageDocs[0].totalTokens, 1500);
});

test(`${tag} zawieszone wywołanie modelu po limicie: blokada trzymana do końca operacji, drugie wywołanie nie startuje równolegle`, async () => {
  const gate = deferred();
  const k = createOrchestratorKit({
    script: [async () => { await gate.promise; return okResult(validQuick({ summary: "SPOZNIONA" })); }, okResult(validQuick({ summary: "TRZECIA" }))],
    orchestratorOptions: { quickCheckTimeoutMs: 1_200, lockMaxHoldMs: 10_000 },
  });
  const first = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([first.ok, first.kind, first.reason], [false, "model_failed", "timeout"]);
  assert.equal(k.usageDocs.at(-1).outcome, "timeout");
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["deadline_exceeded"]);

  // Pierwsze wywołanie nadal trwa: blokada zostaje, drugie uruchomienie dostaje „w toku”.
  assert.equal(k.safeguards.isQuickCheckRunning(lockKeyOf(k)), true);
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).kind, "busy");
  assert.equal(k.calls.length, 1);

  gate.resolve(); // operacja kończy się (jej wynik jest już nieużywany)
  await until(() => k.safeguards.isQuickCheckRunning(lockKeyOf(k)) === false);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");

  const third = await k.orchestrator.runQuickCheck(k.qc());
  assert.equal(third.ok, true);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "TRZECIA");
  assert.equal(k.calls.length, 2);
});

test(`${tag} spóźniony licznik blokady nie zwalnia blokady zajętej w międzyczasie przez nowsze uruchomienie`, async () => {
  const gate1 = deferred();
  const gate3 = deferred();
  const k = createOrchestratorKit({
    script: [
      async () => { await gate1.promise; return okResult(validQuick()); },
      async () => { await gate3.promise; return okResult(validQuick({ summary: "NOWSZE" })); },
    ],
    orchestratorOptions: { quickCheckTimeoutMs: 1_200, lockMaxHoldMs: 600 },
  });
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).reason, "timeout");
  gate1.resolve();
  await until(() => k.safeguards.isQuickCheckRunning(lockKeyOf(k)) === false);

  k.advance(5_000);
  const second = k.orchestrator.runQuickCheck(k.qc()); // nowe uruchomienie trzyma blokadę
  await untilModelCalled(k, 2);
  await sleep(800); // dłużej niż lockMaxHoldMs pierwszego uruchomienia
  assert.equal(k.safeguards.isQuickCheckRunning(lockKeyOf(k)), true);
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).kind, "busy");

  gate3.resolve();
  assert.equal((await second).ok, true);
});

test(`${tag} usunięcie zdublowanej kontroli nie osłabia ochrony: zgoda wycofana w trakcie składania danych blokuje wysłanie`, async () => {
  const k = createOrchestratorKit({ script: [] });
  k.hooks.afterBuild = () => {
    k.userState.user = { disclaimerAcceptedAt: null, disclaimerVersion: null };
  };
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).kind, "consent_missing");
  assert.equal(k.calls.length, 0);
  assert.equal(k.usageDocs.length, 0);
});

/* ---------------------------------------------------------------------------
 * Uwagi po przeglądzie poprawionej syntezy: kontrola zgody w limicie czasu,
 * ostatnia kontrola pauzy, rozróżnienie niepewnego zapisu
 * ------------------------------------------------------------------------ */

test(`${tag} zawieszony odczyt zgody tuż przed wysłaniem: timeout/preparation, model niewywołany, blokada trzymana do końca odczytu`, { timeout: 15_000 }, async () => {
  const gate = deferred();
  const k = createOrchestratorKit({
    script: [okResult(validQuick())],
    orchestratorOptions: { quickCheckTimeoutMs: 1_200, lockMaxHoldMs: 10_000 },
  });
  // odczyt nr 1 = kontrola na starcie, odczyt nr 2 = `beforeSend` tuż przed wysłaniem
  k.userState.onLoad = async (no) => { if (no === 2) await gate.promise; };

  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.phase], [false, "timeout", "preparation"]);
  assert.equal(k.calls.length, 0);
  assert.equal(k.usageDocs.length, 0);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");

  // Odczyt jeszcze trwa → blokada zostaje, drugie uruchomienie dostaje „w toku”.
  assert.equal(k.safeguards.isQuickCheckRunning(lockKeyOf(k)), true);
  assert.equal((await k.orchestrator.runQuickCheck(k.qc())).kind, "busy");

  gate.resolve();
  await until(() => k.safeguards.isQuickCheckRunning(lockKeyOf(k)) === false);
  assert.equal(k.calls.length, 0); // spóźniony odczyt niczego nie uruchomił
});

test(`${tag} pauza po 429 włączona w trakcie odczytu zgody → model niewywołany (ostatnia kontrola pauzy)`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  // pauza włącza się, gdy trwa odczyt użytkownika z `beforeSend` (odczyt nr 2)
  k.userState.onLoad = async (no) => {
    if (no === 2) {
      await sleep(5);
      k.safeguards.reportRateLimited();
    }
  };
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.reason], [false, "unavailable", "ai_paused"]);
  assert.equal(k.calls.length, 0);
  assert.equal(k.usageDocs.length, 0);
});

test(`${tag} niepewny zapis (wyjątek PO wysłaniu aktualizacji): internal_error + writeUnconfirmed, dziennik write_rejected z kodem write_unconfirmed`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  k.actions.beforeUpdate = async () => {
    throw Object.assign(new Error("connection reset"), { name: "MongoNetworkError" });
  };
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind, r.writeUnconfirmed], [false, "internal_error", true]);
  assert.equal(k.usageDocs.at(-1).outcome, "write_rejected");
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["write_unconfirmed"]);
  assert.ok(k.logs.some((l) => l.event === "early_check_write_unconfirmed" && l.name === "MongoNetworkError"));
  assert.equal(stringify(k.logs).includes("connection reset"), false);
});

test(`${tag} wyjątek PRZED aktualizacją (odczyt właściciela w zapisie): internal_error bez writeUnconfirmed — nic nie zapisano`, async () => {
  const k = createOrchestratorKit({ script: [okResult(validQuick())] });
  const original = k.fixture.positions.findOne;
  k.fixture.positions.findOne = function (...args) {
    // po wywołaniu modelu jedynym takim odczytem jest sprawdzenie właściciela w samym zapisie
    if (k.calls.length >= 1) throw new Error("odczyt właściciela nie działa");
    return original.apply(this, args);
  };
  const r = await k.orchestrator.runQuickCheck(k.qc());
  assert.deepEqual([r.ok, r.kind], [false, "internal_error"]);
  assert.equal(r.writeUnconfirmed, undefined);
  assert.equal(doc(k, IDS.action2).earlyAiCheck.summary, "WCZESNA-ANALIZA-NIE-DLA-MODELU");
  assert.equal(k.usageDocs.at(-1).outcome, "write_rejected");
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, []);
});
