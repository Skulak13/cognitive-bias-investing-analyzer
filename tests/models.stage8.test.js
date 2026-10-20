import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Position from "../models/Position.js";
import Action from "../models/Action.js";
import User from "../models/User.js";
import { resolveTestDb } from "./helpers/testDb.js";
import AiUsageLog, {
  AI_USAGE_LOG_TTL_SECONDS,
  AI_USAGE_OUTCOMES,
} from "../models/AiUsageLog.js";

/* Etap 8.4 — schematy danych. Testy NIE wymagają bazy (validateSync / hydrate
 * działają lokalnie). Część wymagająca bazy: tests/models.stage8.integration.test.js. */

const oid = () => new mongoose.Types.ObjectId();

function basePosition(extra = {}) {
  return new Position({
    userId: oid(),
    ticker: "TEST",
    openedAt: new Date("2026-08-04T14:10:00Z"),
    currentQuantity: 10,
    ...extra,
  });
}

function validAnalysis(extra = {}) {
  return {
    analysisType: "final",
    summary: "Podsumowanie.",
    aiModelVersion: "gemini-3.5-flash-lite",
    ...extra,
  };
}

/* ---------------- 8.4.1 Position ---------------- */

test("Position.lastAnalysisStatus — każda dozwolona wartość przechodzi, nieznana nie", () => {
  for (const value of ["pending", "success", "failed", "skipped", null]) {
    const doc = basePosition({ lastAnalysisStatus: value });
    assert.equal(doc.validateSync(), undefined, `wartość ${value}`);
    assert.equal(doc.lastAnalysisStatus, value);
  }
  const bad = basePosition({ lastAnalysisStatus: "running" }).validateSync();
  assert.ok(bad?.errors?.lastAnalysisStatus, "nieznany status musi być odrzucony");
});

test("Position — nowe pola mają bezpieczne wartości domyślne (stare dokumenty bez nich są poprawne)", () => {
  const doc = basePosition();
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.lastAnalysisStatus, null);
  assert.equal(doc.lastAnalysisReason, null);
  assert.equal(doc.lastAnalysisRunId, null);
  assert.equal(doc.lastAnalysisStartedAt, null);
  assert.equal(doc.finalAnalysisRequestedAt, null);
  assert.equal(doc.finalAnalysisAttempts, 0);

  assert.ok(basePosition({ finalAnalysisAttempts: -1 }).validateSync()?.errors?.finalAnalysisAttempts);
  const set = basePosition({
    lastAnalysisStatus: "skipped",
    lastAnalysisReason: "ai_disabled",
    lastAnalysisRunId: "run-1",
    lastAnalysisStartedAt: new Date("2026-10-18T10:00:00Z"),
    finalAnalysisRequestedAt: new Date("2026-10-18T10:00:00Z"),
    finalAnalysisAttempts: 1,
  });
  assert.equal(set.validateSync(), undefined);
  assert.equal(set.lastAnalysisReason, "ai_disabled");
  assert.equal(set.finalAnalysisAttempts, 1);
});

test("Position — starszy dokument (raw z bazy, bez nowych pól, stary inputSnapshot) wczytuje się i jest poprawny", () => {
  const capturedAt = new Date("2026-09-01T12:00:00Z");
  const raw = {
    _id: oid(),
    userId: oid(),
    ticker: "OLD",
    status: "closed",
    openedAt: new Date("2026-08-01T10:00:00Z"),
    closedAt: new Date("2026-09-01T10:00:00Z"),
    currentQuantity: 0,
    lastAnalyzedAt: capturedAt,
    lastAnalysisStatus: "success", // stary dokument: wartość z poprzedniego enuma
    analyses: [
      {
        _id: oid(),
        analyzedAt: capturedAt,
        analysisType: "final",
        inputSnapshot: { actions: [{ sequenceNo: 1, actionType: "open", reasoning: "tekst" }], capturedAt },
        summary: "Stara analiza",
        aiModelVersion: "stary-model",
      },
    ],
  };
  const doc = Position.hydrate(raw);
  assert.equal(doc.validateSync(), undefined);

  const snap = doc.analyses[0].inputSnapshot;
  assert.equal(snap.actions[0].reasoning, "tekst");
  assert.deepEqual(snap.capturedAt, capturedAt);
  assert.equal(doc.analyses[0].analysisRunId, undefined);
  assert.equal(doc.finalAnalysisAttempts, 0, "brakujące pole dostaje wartość domyślną przy odczycie");
  assert.equal(doc.finalAnalysisRequestedAt, null);
  assert.equal(doc.isModified(), false);
});

test("Position.analyses[].inputSnapshot — nowy kształt {modelInput, meta, capturedAt} przechodzi i nie jest obcinany", () => {
  const snapshot = {
    modelInput: { ticker: "X", positionStatus: "closed", actions: [{ sequenceNo: 1, reasoning: "r" }], news: [] },
    meta: { provider: "gemini", requestedModel: "gemini-3.5-flash-lite", modelVersion: null, promptVersion: "p1" },
    capturedAt: new Date("2026-10-18T10:00:00Z"),
  };
  const doc = basePosition({ analyses: [validAnalysis({ analysisRunId: "run-7", inputSnapshot: snapshot })] });
  assert.equal(doc.validateSync(), undefined);

  const saved = doc.toObject().analyses[0];
  assert.equal(saved.analysisRunId, "run-7");
  assert.deepEqual(saved.inputSnapshot.modelInput, snapshot.modelInput);
  assert.deepEqual(saved.inputSnapshot.meta, snapshot.meta);
  assert.deepEqual(saved.inputSnapshot.capturedAt, snapshot.capturedAt);
});

test("Position.analyses[] — stary kształt inputSnapshot przechodzi walidację także przez konstruktor", () => {
  const doc = basePosition({
    analyses: [validAnalysis({ inputSnapshot: { actions: [{ a: 1 }], capturedAt: new Date() } })],
  });
  assert.equal(doc.validateSync(), undefined);
  assert.deepEqual(doc.toObject().analyses[0].inputSnapshot.actions, [{ a: 1 }]);
});

/* ---------------- 8.4.2 Action.earlyAiCheck ---------------- */

function baseAction(earlyAiCheck) {
  return new Action({
    positionId: oid(),
    userId: oid(),
    actionType: "open",
    quantity: 1,
    executionPrice: 1,
    marketPriceAtDecision: 1,
    actionDate: new Date("2026-08-04T14:10:00Z"),
    tradingDateRef: "2026-08-04",
    sequenceNo: 1,
    ...(earlyAiCheck === undefined ? {} : { earlyAiCheck }),
  });
}

const OLD_EARLY = {
  analyzedAt: new Date("2026-09-01T10:00:00Z"),
  summary: "Krótko.",
  possibleBiases: ["zakotwiczenie"],
  aiModelVersion: "stary-model",
};

test("Action.earlyAiCheck — stary kształt (bez nowych pól) nadal poprawny", () => {
  const errors = baseAction(OLD_EARLY).validateSync();
  assert.ok(!errors?.errors?.["earlyAiCheck.summary"] && !Object.keys(errors?.errors ?? {}).some((k) => k.startsWith("earlyAiCheck")));
  const doc = baseAction(OLD_EARLY);
  assert.equal(doc.earlyAiCheck.analysisRunId, undefined);
  assert.equal(doc.earlyAiCheck.runStartedAt, undefined);
  assert.equal(doc.earlyAiCheck.inputSnapshot, undefined);
  assert.equal(baseAction(null).earlyAiCheck, null);
});

test("Action.earlyAiCheck — nowe pola (analysisRunId, runStartedAt, inputSnapshot) są zapisywane w całości; brak marketContextSnapshot", () => {
  const inputSnapshot = {
    modelInput: { ticker: "X", actions: [{ sequenceNo: 1 }] },
    meta: { provider: "gemini", requestedModel: "m" },
    capturedAt: new Date("2026-10-18T10:00:00Z"),
  };
  const doc = baseAction({
    ...OLD_EARLY,
    analysisRunId: "run-9",
    runStartedAt: new Date("2026-10-18T10:00:00Z"),
    inputSnapshot,
  });
  const early = doc.toObject().earlyAiCheck;
  assert.equal(early.analysisRunId, "run-9");
  assert.deepEqual(early.runStartedAt, new Date("2026-10-18T10:00:00Z"));
  assert.deepEqual(early.inputSnapshot, inputSnapshot);

  assert.equal(Action.schema.path("earlyAiCheck").schema.path("marketContextSnapshot"), undefined, "C14: bez marketContextSnapshot");
});

/* ---------------- 8.4.3 User ---------------- */

test("User.disclaimerVersion — domyślnie null, przyjmuje tekst; disclaimerAcceptedAt bez wersji jest poprawne", () => {
  const user = new User({ email: "a@b.pl", passwordHash: "h" });
  assert.equal(user.validateSync(), undefined);
  assert.equal(user.disclaimerVersion, null);

  const old = new User({ email: "a@b.pl", passwordHash: "h", disclaimerAcceptedAt: new Date() });
  assert.equal(old.validateSync(), undefined);
  assert.equal(old.disclaimerVersion, null);

  const withVersion = new User({ email: "a@b.pl", passwordHash: "h", disclaimerAcceptedAt: new Date(), disclaimerVersion: "1" });
  assert.equal(withVersion.disclaimerVersion, "1");
});

/* ---------------- 8.4.4 AiUsageLog ---------------- */

function validLog(extra = {}) {
  return {
    analysisRunId: "run-1",
    attempt: 1,
    kind: "full",
    trigger: "manual",
    userId: oid(),
    requestedModel: "gemini-3.5-flash-lite",
    startedAt: new Date("2026-10-18T10:00:00Z"),
    outcome: "success",
    ...extra,
  };
}

test("AiUsageLog — poprawny rekord; brak tokenów to null (nie zgadujemy), dozwolone też 0", () => {
  const doc = new AiUsageLog(validLog());
  assert.equal(doc.validateSync(), undefined);
  for (const f of ["inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "cachedTokens"]) {
    assert.equal(doc[f], null, f);
  }
  assert.equal(doc.provider, "gemini");
  assert.equal(doc.modelVersion, null);
  assert.equal(doc.httpStatus, null);
  assert.deepEqual([...doc.warningCodes], []);

  const explicitNull = new AiUsageLog(validLog({ inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }));
  assert.equal(explicitNull.validateSync(), undefined);
  assert.equal(explicitNull.totalTokens, null);

  const withTokens = new AiUsageLog(validLog({ inputTokens: 1200, outputTokens: 300, reasoningTokens: 0, totalTokens: 1500 }));
  assert.equal(withTokens.validateSync(), undefined);
  assert.equal(withTokens.reasoningTokens, 0);
});

test("AiUsageLog — wymagane pola, enumy i minima są egzekwowane", () => {
  for (const field of ["analysisRunId", "attempt", "kind", "trigger", "userId", "requestedModel", "startedAt", "outcome"]) {
    const data = validLog();
    delete data[field];
    assert.ok(new AiUsageLog(data).validateSync()?.errors?.[field], `brak ${field} musi być odrzucony`);
  }
  assert.ok(new AiUsageLog(validLog({ kind: "other" })).validateSync()?.errors?.kind);
  assert.ok(new AiUsageLog(validLog({ trigger: "cron" })).validateSync()?.errors?.trigger);
  assert.ok(new AiUsageLog(validLog({ outcome: "ok" })).validateSync()?.errors?.outcome);
  assert.ok(new AiUsageLog(validLog({ attempt: 0 })).validateSync()?.errors?.attempt);
  assert.ok(new AiUsageLog(validLog({ inputTokens: -5 })).validateSync()?.errors?.inputTokens);
  for (const outcome of AI_USAGE_OUTCOMES) {
    assert.equal(new AiUsageLog(validLog({ outcome })).validateSync(), undefined, outcome);
  }
});

test("AiUsageLog — kody walidatora i długości pól przechodzą; schemat nie ma pól na treści (D8-23)", () => {
  const doc = new AiUsageLog(
    validLog({
      kind: "quickCheck",
      actionId: oid(),
      outcome: "invalid_response",
      warningCodes: ["w1"],
      errorCodes: ["e1", "e2"],
      inputChars: 5000,
      outputChars: 800,
      maxFieldLengths: { reasoning: 4800, summary: 300 },
    }),
  );
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.maxFieldLengths.get("reasoning"), 4800);

  const paths = Object.keys(AiUsageLog.schema.paths).join(" ");
  for (const forbidden of ["reasoning", "expectedOutcome", "summary", "headline", "email", "apiKey", "responseText", "prompt"]) {
    assert.ok(!new RegExp(`(^| )${forbidden}( |$)`, "i").test(paths), `schemat nie może mieć pola ${forbidden}`);
  }
});

test("AiUsageLog — indeks TTL na createdAt jest w definicji; są indeksy raportowe; brak kolidującego duplikatu {createdAt}", () => {
  const indexes = AiUsageLog.schema.indexes();
  const ttl = indexes.find(([keys]) => keys.createdAt === 1 && Object.keys(keys).length === 1);
  assert.ok(ttl, "indeks { createdAt: 1 } musi istnieć");
  assert.equal(ttl[1].expireAfterSeconds, AI_USAGE_LOG_TTL_SECONDS);
  assert.equal(AI_USAGE_LOG_TTL_SECONDS, 90 * 24 * 3600);

  assert.ok(indexes.some(([keys]) => keys.userId === 1 && keys.createdAt === 1 && Object.keys(keys).length === 2));
  assert.equal(indexes.filter(([keys]) => Object.keys(keys).length === 1 && keys.createdAt === 1).length, 1);
  assert.equal(AiUsageLog.schema.path("createdAt") !== undefined, true, "timestamps tworzą createdAt");
  assert.equal(AiUsageLog.schema.path("updatedAt"), undefined);
});

/* ---------------- uwagi z przeglądu: liczby całkowite i klucze maxFieldLengths ---------------- */

test("liczniki muszą być całkowite: finalAnalysisAttempts, attempt, tokeny, znaki", () => {
  assert.ok(basePosition({ finalAnalysisAttempts: 1.5 }).validateSync()?.errors?.finalAnalysisAttempts);
  assert.equal(basePosition({ finalAnalysisAttempts: 2 }).validateSync(), undefined);

  assert.ok(new AiUsageLog(validLog({ attempt: 1.5 })).validateSync()?.errors?.attempt);
  for (const f of ["inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "cachedTokens", "inputChars", "outputChars"]) {
    assert.ok(new AiUsageLog(validLog({ [f]: 10.5 })).validateSync()?.errors?.[f], `${f} ułamkowe musi być odrzucone`);
    assert.equal(new AiUsageLog(validLog({ [f]: 10 })).validateSync(), undefined, `${f} całkowite przechodzi`);
    assert.equal(new AiUsageLog(validLog({ [f]: null })).validateSync(), undefined, `${f} null przechodzi`);
  }
});

test("maxFieldLengths: tylko nazwy pól jako klucze i całkowite długości", () => {
  const ok = new AiUsageLog(validLog({ maxFieldLengths: { reasoning: 4800, expectedOutcome: 100, summary_2: 0 } }));
  assert.equal(ok.validateSync(), undefined);

  const bad = [
    { "Kupiłem akcje, bo plotka": 10 }, // tekst jako klucz
    { "a b": 1 },
    { "reasoning.text": 1 },
    { [`x${"a".repeat(40)}`]: 1 }, // za długi klucz
    { reasoning: 1.5 },
    { reasoning: -1 },
    Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 1])),
  ];
  for (const value of bad) {
    assert.ok(
      new AiUsageLog(validLog({ maxFieldLengths: value })).validateSync()?.errors?.maxFieldLengths,
      `powinno być odrzucone: ${JSON.stringify(value).slice(0, 60)}`,
    );
  }
});

test("zabezpieczenie bazy testowej: odmawia bez MONGODB_TEST_URI, dla bazy bez \"test\" w nazwie i dla adresu równego MONGODB_URI", () => {
  assert.equal(resolveTestDb({}).ok, false);
  assert.equal(resolveTestDb({ MONGODB_URI: "mongodb://h/dziennik" }).ok, false, "samo MONGODB_URI nie wystarcza");
  assert.equal(resolveTestDb({ MONGODB_TEST_URI: "mongodb://h/dziennik" }).ok, false, "nazwa bazy bez test");
  assert.equal(resolveTestDb({ MONGODB_TEST_URI: "mongodb://h" }).ok, false, "brak nazwy bazy");
  assert.equal(resolveTestDb({ MONGODB_TEST_URI: "mongodb://h/x_test", MONGODB_URI: "mongodb://h/x_test" }).ok, false, "identyczny z MONGODB_URI");
  assert.equal(resolveTestDb({ MONGODB_TEST_URI: "nie-adres" }).ok, false);

  const ok = resolveTestDb({ MONGODB_TEST_URI: "mongodb+srv://u:p@cluster.mongodb.net/dziennik_test?retryWrites=true", MONGODB_URI: "mongodb+srv://u:p@cluster.mongodb.net/dziennik" });
  assert.equal(ok.ok, true);
  assert.equal(resolveTestDb({ MONGODB_TEST_URI: "mongodb://localhost:27017/Test-DB" }).ok, true);
  assert.ok(!JSON.stringify(resolveTestDb({ MONGODB_TEST_URI: "mongodb://h/dziennik" })).includes("mongodb://"), "powód odmowy nie zawiera adresu (hasła)");
});
