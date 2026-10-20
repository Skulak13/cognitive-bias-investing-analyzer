import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import AiUsageLog, { AI_USAGE_OUTCOMES } from "../models/AiUsageLog.js";
import {
  createAiUsageLogger,
  measureFieldLengths,
  measureOutputChars,
  outcomeForAttempt,
  toUsageTrigger,
  uniqueCodes,
  FIELD_LENGTH_NAMES,
  mapUsage,
} from "../services/aiUsageLogger.js";
import { createFakeUsageModel } from "./helpers/aiOrchestratorKit.js";

/* Etap 8.9.1 — dziennik zużycia: mapowanie prób, brak treści, odporność na błąd zapisu. */

const oid = () => new mongoose.Types.ObjectId();

const attempt = (over = {}) => ({
  attempt: 1,
  ok: true,
  errorKind: null,
  httpStatus: null,
  providerCode: null,
  durationMs: 812,
  usage: { input: 1200, output: 300, reasoning: 20, total: 1520 },
  finishReason: "stop",
  ...over,
});

function setup() {
  const model = createFakeUsageModel();
  const logs = [];
  const logger = createAiUsageLogger({
    UsageLogModel: model,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  const meta = {
    runId: "run-1",
    kind: "full",
    trigger: "manual",
    userId: oid(),
    positionId: oid(),
    requestedModel: "model-x",
    promptVersion: "prompt-v",
    inputChars: 4321,
  };
  return { model, logs, rec: logger.forRun(meta), meta };
}

test("rekord próby: tokeny, czas, kod HTTP i identyfikacja z kontraktu klienta", async () => {
  const { model, rec, meta } = setup();
  const startedAt = new Date("2026-10-21T21:00:00Z");

  assert.equal(
    await rec.record(attempt({ endpointKind: "interactions" }), {
      startedAt,
      modelVersion: "model-x-001",
      outputChars: 77,
    }),
    true,
  );

  const [doc] = model.docs;
  assert.equal(doc.analysisRunId, "run-1");
  assert.equal(doc.attempt, 1);
  assert.equal(doc.kind, "full");
  assert.equal(doc.trigger, "manual");
  assert.equal(String(doc.userId), String(meta.userId));
  assert.equal(doc.provider, "gemini");
  assert.equal(doc.endpointKind, "interactions"); // podaje klient, logger tylko zapisuje
  assert.equal(doc.requestedModel, "model-x");
  assert.equal(doc.modelVersion, "model-x-001");
  assert.equal(doc.promptVersion, "prompt-v");
  assert.equal(doc.startedAt.getTime(), startedAt.getTime());
  assert.equal(doc.durationMs, 812);
  assert.equal(doc.outcome, "success");
  assert.equal(doc.inputTokens, 1200);
  assert.equal(doc.outputTokens, 300);
  assert.equal(doc.reasoningTokens, 20);
  assert.equal(doc.totalTokens, 1520);
  assert.equal(doc.cachedTokens, null);
  assert.equal(doc.inputChars, 4321);
  assert.equal(doc.outputChars, 77);
  assert.equal(doc.finishReason, "stop");
});

test("brak danych o tokenach → null (nie zgadujemy); wartości niecałkowite też → null", async () => {
  const { model, rec } = setup();
  await rec.record(attempt({ usage: { input: null, output: undefined, reasoning: 1.5, total: -3 } }));
  await rec.record(attempt({ usage: undefined }));

  for (const doc of model.docs) {
    assert.equal(doc.inputTokens, null);
    assert.equal(doc.outputTokens, null);
    assert.equal(doc.reasoningTokens, null);
    assert.equal(doc.totalTokens, null);
  }
});

test("outcome: tabela rodzajów błędu klienta (enumeracja modelu bez zmian)", () => {
  const cases = [
    [attempt(), "success"],
    [attempt({ ok: false, errorKind: "rate_limited", httpStatus: 429 }), "http_error"],
    [attempt({ ok: false, errorKind: "timeout" }), "timeout"],
    [attempt({ ok: false, errorKind: "unavailable", httpStatus: null }), "network_error"],
    [attempt({ ok: false, errorKind: "unavailable", httpStatus: 503 }), "http_error"],
    [attempt({ ok: false, errorKind: "config", httpStatus: 403 }), "http_error"],
    [attempt({ ok: false, errorKind: "blocked", httpStatus: 400 }), "blocked"],
    [attempt({ ok: false, errorKind: "truncated", httpStatus: 200 }), "truncated_output"],
    [attempt({ ok: false, errorKind: "bad_output", httpStatus: 200 }), "invalid_response"],
    [attempt({ ok: false, errorKind: "cos_nowego", httpStatus: 500 }), "http_error"],
  ];
  for (const [entry, expected] of cases) {
    const outcome = outcomeForAttempt(entry);
    assert.equal(outcome, expected, entry.errorKind ?? "ok");
    assert.ok(AI_USAGE_OUTCOMES.includes(outcome));
  }
});

test("numery prób rosną w obrębie uruchomienia, także po ponowieniach; outcome można nadpisać", async () => {
  const { model, rec } = setup();
  await rec.record(attempt({ ok: false, errorKind: "timeout" }));
  await rec.record(attempt({ ok: false, errorKind: "unavailable", httpStatus: 503 }));
  await rec.record(attempt(), { outcome: "invalid_response", errorCodes: ["empty_value"] });
  await rec.record(attempt(), { outcome: "write_rejected" });

  assert.deepEqual(model.docs.map((d) => d.attempt), [1, 2, 3, 4]);
  assert.deepEqual(
    model.docs.map((d) => d.outcome),
    ["timeout", "http_error", "invalid_response", "write_rejected"],
  );
  assert.deepEqual(model.docs[2].errorCodes, ["empty_value"]);
  assert.equal(rec.attemptsRecorded(), 4);
});

test("trigger z serwisu stanu → wartość z enumeracji dziennika", () => {
  assert.equal(toUsageTrigger("manual"), "manual");
  assert.equal(toUsageTrigger("auto"), "auto_after_close");
  assert.equal(toUsageTrigger("technical_test"), "technical_test");
  assert.equal(toUsageTrigger("cokolwiek"), "manual");
});

test("błąd zapisu dziennika nie wychodzi na zewnątrz: false + log bez treści", async () => {
  const { model, logs, rec } = setup();
  model.failWith = Object.assign(new Error("TAJNY-KOMUNIKAT-BAZY"), { name: "MongoServerError" });

  assert.equal(await rec.record(attempt()), false);
  const failure = logs.find((l) => l.event === "usage_log_write_failed");
  assert.ok(failure);
  assert.equal(failure.name, "MongoServerError");
  assert.equal(JSON.stringify(logs).includes("TAJNY-KOMUNIKAT-BAZY"), false);

  // kolejne próby nadal działają, a numeracja nie cofa się
  model.failWith = null;
  assert.equal(await rec.record(attempt()), true);
  assert.equal(model.docs[0].attempt, 2);
});

test("błąd w logu procesu też nie przerywa zapisu", async () => {
  const model = createFakeUsageModel();
  const logger = createAiUsageLogger({
    UsageLogModel: model,
    log: () => {
      throw new Error("log nie działa");
    },
  });
  const rec = logger.forRun({
    runId: "r",
    kind: "full",
    trigger: "manual",
    userId: oid(),
    requestedModel: "m",
  });
  assert.equal(await rec.record(attempt()), true);
  assert.equal(model.docs.length, 1);
});

test("rekord przechodzi walidację PRAWDZIWEGO schematu AiUsageLog (z mapą długości pól)", async () => {
  const { model, rec } = setup();
  const value = {
    summary: "abc",
    limitations: "",
    outcomeNote: "xy",
    observedPatterns: ["a", "abcd"],
    alternativeExplanations: ["abcdef"],
    possibleBiases: [{ supportingEvidence: "12345", contradictingEvidence: "1" }],
  };
  await rec.record(attempt(), {
    outcome: "success",
    warningCodes: ["bias_unmapped", "confidence_normalized"],
    maxFieldLengths: measureFieldLengths("full", value),
    outputChars: measureOutputChars(value),
  });

  const doc = new AiUsageLog(model.docs[0]);
  await doc.validate();
  assert.equal(doc.maxFieldLengths.get("supportingEvidence"), 5);
});

test("długości pól: stałe nazwy, same liczby; quick-check ma własny zestaw", () => {
  const full = measureFieldLengths("full", {
    summary: "abc",
    limitations: "",
    outcomeNote: "xy",
    observedPatterns: ["a", "abcd"],
    alternativeExplanations: ["abcdef"],
    possibleBiases: [
      { supportingEvidence: "12345", contradictingEvidence: "1" },
      { supportingEvidence: "123", contradictingEvidence: "123456" },
    ],
  });
  assert.deepEqual(Object.keys(full).sort(), [...FIELD_LENGTH_NAMES.full].sort());
  assert.deepEqual(full, {
    summary: 3,
    limitations: 0,
    outcomeNote: 2,
    observedPattern: 4,
    alternativeExplanation: 6,
    supportingEvidence: 5,
    contradictingEvidence: 6,
  });

  const quick = measureFieldLengths("quickCheck", {
    summary: "abcd",
    possibleBiases: ["ab", "abcdef"],
    limitations: "x",
  });
  assert.deepEqual(quick, { summary: 4, limitations: 1, possibleBiasName: 6 });
  assert.deepEqual(Object.keys(quick).sort(), [...FIELD_LENGTH_NAMES.quickCheck].sort());
  assert.equal(measureFieldLengths("full", null), undefined);
});

test("kody walidatora: unikalne, krótkie identyfikatory; treść i dziwne napisy są odrzucane", () => {
  assert.deepEqual(
    uniqueCodes([
      { code: "bias_unmapped", path: "x" },
      { code: "bias_unmapped" },
      "confidence_normalized",
      { code: "to jest treść uzasadnienia użytkownika" },
      { code: 5 },
      null,
    ]),
    ["bias_unmapped", "confidence_normalized"],
  );
  assert.deepEqual(uniqueCodes(undefined), []);
});

test("rekord i linia logu nie zawierają treści: obce pola próby są ignorowane", async () => {
  const { model, logs, rec } = setup();
  const sneaky = {
    ...attempt(),
    value: { summary: "TAJNE-UZASADNIENIE" },
    message: "TAJNY-KOMUNIKAT-DOSTAWCY",
    userContent: "TAJNE-DANE-UZYTKOWNIKA",
  };
  await rec.record(sneaky, { warningCodes: ["bias_unmapped"] });

  const dump = JSON.stringify([model.docs, logs]);
  for (const secret of ["TAJNE-UZASADNIENIE", "TAJNY-KOMUNIKAT-DOSTAWCY", "TAJNE-DANE-UZYTKOWNIKA"]) {
    assert.equal(dump.includes(secret), false, secret);
  }
  const line = logs.find((l) => l.event === "ai_usage");
  assert.ok(line);
  assert.equal(line.outcome, "success");
  assert.equal(line.inputTokens, 1200);
  assert.deepEqual(line.warningCodes, ["bias_unmapped"]);
});


test("mapowanie tokenów obsługuje też surowy kształt Interactions API", () => {
  assert.deepEqual(mapUsage({
    total_input_tokens: 10,
    total_output_tokens: 20,
    total_thought_tokens: 3,
    total_tokens: 33,
    total_cached_tokens: 2,
  }), {
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 3,
    totalTokens: 33,
    cachedTokens: 2,
  });
  assert.deepEqual(mapUsage({ input: 1.5, output: -1, total: "33" }), {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cachedTokens: null,
  });
});

test("timeout zapisu dziennika kończy oczekiwanie i nie ujawnia komunikatu błędu", async () => {
  const logs = [];
  const logger = createAiUsageLogger({
    UsageLogModel: { create: () => new Promise(() => {}) },
    writeTimeoutMs: 10,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  const rec = logger.forRun({
    runId: "timeout-run",
    kind: "full",
    trigger: "manual",
    userId: oid(),
    requestedModel: "model-x",
  });

  assert.equal(await rec.record(attempt()), false);
  const failure = logs.find((line) => line.event === "usage_log_write_failed");
  assert.equal(failure?.name, "UsageLogTimeout");
  assert.equal(JSON.stringify(logs).includes("usage_log_timeout"), false);
});

test("metadane dostawcy o niebezpiecznym kształcie są pomijane", async () => {
  const { model, rec, logs } = setup();
  await rec.record(attempt({
    providerCode: "sekret user@example.com",
    finishReason: "tekst prywatnej odpowiedzi",
  }), { modelVersion: "niebezpieczna wersja z treścią" });

  assert.equal(model.docs[0].providerErrorCode, null);
  assert.equal(model.docs[0].finishReason, null);
  assert.equal(model.docs[0].modelVersion, null);
  assert.equal(JSON.stringify(logs).includes("user@example.com"), false);
});

test("endpointKind: tylko z opisu próby (od klienta); brak lub niebezpieczny kształt → null", async () => {
  const { model, rec } = setup();
  await rec.record(attempt()); // brak pola
  await rec.record(attempt({ endpointKind: "https://example.com/v1?key=sekret" }));
  await rec.record(attempt({ endpointKind: "interactions" }));
  assert.deepEqual(model.docs.map((d) => d.endpointKind), [null, null, "interactions"]);
});

test("jedna jednostka długości: `.length` (UTF-16), jak limity w schematach i inputChars/outputChars", () => {
  const emoji = "😀"; // 1 punkt kodowy, ale 2 jednostki UTF-16
  assert.equal(emoji.length, 2);
  assert.equal(measureFieldLengths("quickCheck", { summary: emoji, possibleBiases: [emoji + "a"], limitations: "" }).summary, 2);
  assert.equal(measureFieldLengths("quickCheck", { summary: emoji, possibleBiases: [emoji + "a"], limitations: "" }).possibleBiasName, 3);
  assert.equal(measureOutputChars("😀"), JSON.stringify("😀").length);
});

test("kody limitu czasu aplikacji przechodzą filtr kodów, a rekord zachowuje tokeny", async () => {
  const { model, rec } = setup();
  await rec.record(attempt(), { outcome: "timeout", errorCodes: ["deadline_exceeded", "save_timeout", "write_unconfirmed"] });
  assert.equal(model.docs[0].outcome, "timeout");
  assert.deepEqual(model.docs[0].errorCodes, ["deadline_exceeded", "save_timeout", "write_unconfirmed"]);
  assert.equal(model.docs[0].totalTokens, 1520);
});

test("wspólny budżet zapisów uruchomienia: wolna baza nie odnawia limitu przy każdym rekordzie", async () => {
  const hung = { create: () => new Promise(() => {}) }; // baza, która nigdy nie odpowiada
  const logs = [];
  const logger = createAiUsageLogger({
    UsageLogModel: hung,
    log: (event, fields) => logs.push({ event, ...fields }),
    writeTimeoutMs: 60,
    runWriteBudgetMs: 100,
  });
  const rec = logger.forRun({ runId: "r", kind: "full", trigger: "manual", userId: oid(), requestedModel: "m" });

  const t0 = Date.now();
  assert.equal(await rec.record(attempt()), false); // czeka ok. 60 ms (limit rekordu)
  assert.equal(await rec.record(attempt()), false); // zostaje ok. 40 ms budżetu
  assert.equal(await rec.record(attempt()), false); // budżet wyczerpany: pomijany od razu
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 250, `łączne oczekiwanie ${elapsed} ms powinno mieścić się w budżecie ~100 ms`);
  assert.ok(logs.some((l) => l.event === "usage_log_budget_exhausted" && l.attempt === 3));
  assert.equal(rec.attemptsRecorded(), 3); // numeracja prób nie cofa się
});

test("wspólny budżet: sprawna baza zapisuje wszystkie rekordy; nowe uruchomienie dostaje własny budżet", async () => {
  const model = createFakeUsageModel();
  const logger = createAiUsageLogger({ UsageLogModel: model, runWriteBudgetMs: 50 });
  const rec = logger.forRun({ runId: "a", kind: "full", trigger: "manual", userId: oid(), requestedModel: "m" });
  for (let i = 0; i < 10; i += 1) assert.equal(await rec.record(attempt()), true);
  assert.equal(model.docs.length, 10);

  // budżet jednego uruchomienia nie wpływa na kolejne
  const hung = { create: () => new Promise(() => {}) };
  const slow = createAiUsageLogger({ UsageLogModel: hung, writeTimeoutMs: 30, runWriteBudgetMs: 30, log: () => {} });
  const first = slow.forRun({ runId: "x", kind: "full", trigger: "manual", userId: oid(), requestedModel: "m" });
  await first.record(attempt());
  const t0 = Date.now();
  await first.record(attempt()); // wyczerpany → natychmiast
  assert.ok(Date.now() - t0 < 20);
  const second = slow.forRun({ runId: "y", kind: "full", trigger: "manual", userId: oid(), requestedModel: "m" });
  const t1 = Date.now();
  await second.record(attempt()); // własny budżet → czeka do limitu
  assert.ok(Date.now() - t1 >= 25);
});
