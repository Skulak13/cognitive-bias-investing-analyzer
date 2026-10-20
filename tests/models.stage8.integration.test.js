import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Position from "../models/Position.js";
import AiUsageLog, { AI_USAGE_LOG_TTL_SECONDS } from "../models/AiUsageLog.js";
import { resolveTestDb } from "./helpers/testDb.js";

/* Etap 8.4 — weryfikacja na bazie TESTOWEJ.
 *
 * Zabezpieczenie przed pomyłką (testy tworzą dokumenty i indeksy, w tym TTL):
 *   - używana jest OSOBNA zmienna MONGODB_TEST_URI (nigdy MONGODB_URI),
 *   - nazwa bazy w adresie musi zawierać "test" (np. .../dziennik_test),
 *   - adres nie może być identyczny z MONGODB_URI.
 * Gdy którykolwiek warunek nie jest spełniony, testy są POMIJANE (skip)
 * z podaniem powodu — nic się nie łączy z bazą. Testy sprzątają po sobie
 * (kasują tylko własne dokumenty). */

const testDb = resolveTestDb();
const skip = testDb.ok ? false : testDb.reason;

const createdPositionIds = [];
const createdLogIds = [];

before(async () => {
  if (skip) return;
  await mongoose.connect(testDb.uri);
});

after(async () => {
  if (skip) return;
  await Position.collection.deleteMany({ _id: { $in: createdPositionIds } });
  await AiUsageLog.collection.deleteMany({ _id: { $in: createdLogIds } });
  await mongoose.disconnect();
});

test("stary dokument Position (zapisany surowo, bez nowych pól) wczytuje się i zapisuje bez utraty danych", { skip }, async () => {
  const _id = new mongoose.Types.ObjectId();
  const capturedAt = new Date("2026-09-01T12:00:00Z");
  await Position.collection.insertOne({
    _id,
    userId: new mongoose.Types.ObjectId(),
    ticker: "OLD",
    status: "closed",
    openedAt: new Date("2026-08-01T10:00:00Z"),
    closedAt: new Date("2026-09-01T10:00:00Z"),
    currentQuantity: 0,
    lastAnalysisStatus: "success",
    analyses: [
      {
        _id: new mongoose.Types.ObjectId(),
        analyzedAt: capturedAt,
        analysisType: "final",
        inputSnapshot: { actions: [{ sequenceNo: 1, reasoning: "tekst" }], capturedAt },
        summary: "Stara analiza",
        aiModelVersion: "stary-model",
      },
    ],
    postCloseOutcome: [],
    lastAnalyzedAt: capturedAt,
    deletedAt: null,
  });
  createdPositionIds.push(_id);

  const doc = await Position.findById(_id);
  assert.ok(doc);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.finalAnalysisAttempts, 0);
  assert.equal(doc.finalAnalysisRequestedAt, null);

  doc.lastAnalysisStatus = "skipped"; // nowa wartość enuma
  doc.lastAnalysisReason = "ai_disabled";
  await doc.save();

  const again = await Position.findById(_id).lean();
  assert.equal(again.lastAnalysisStatus, "skipped");
  assert.equal(again.lastAnalysisReason, "ai_disabled");
  assert.equal(again.analyses[0].summary, "Stara analiza");
  assert.equal(again.analyses[0].inputSnapshot.actions[0].reasoning, "tekst");
  assert.deepEqual(again.analyses[0].inputSnapshot.capturedAt, capturedAt);
});

test("nowy wpis analyses[] z {modelInput, meta, capturedAt} zapisuje się i odczytuje w całości", { skip }, async () => {
  const snapshot = {
    modelInput: { ticker: "NEW", actions: [{ sequenceNo: 1, reasoning: "r" }] },
    meta: { provider: "gemini", requestedModel: "gemini-3.5-flash-lite", modelVersion: null },
    capturedAt: new Date("2026-10-18T10:00:00Z"),
  };
  const doc = await Position.create({
    userId: new mongoose.Types.ObjectId(),
    ticker: "NEW",
    openedAt: new Date("2026-10-01T10:00:00Z"),
    currentQuantity: 1,
    analyses: [{ analysisType: "interim", summary: "s", aiModelVersion: "m", analysisRunId: "run-1", inputSnapshot: snapshot }],
  });
  createdPositionIds.push(doc._id);

  const lean = await Position.findById(doc._id).lean();
  assert.equal(lean.analyses[0].analysisRunId, "run-1");
  assert.deepEqual(lean.analyses[0].inputSnapshot.modelInput, snapshot.modelInput);
  assert.deepEqual(lean.analyses[0].inputSnapshot.meta, snapshot.meta);
});

test("AiUsageLog: po init() istnieje indeks TTL na createdAt oraz indeks {userId, createdAt}; zapis z tokenami null działa", { skip }, async () => {
  await AiUsageLog.init();
  const indexes = await AiUsageLog.collection.indexes();
  const ttl = indexes.find((i) => i.key.createdAt === 1 && Object.keys(i.key).length === 1);
  assert.ok(ttl, "brak indeksu { createdAt: 1 }");
  assert.equal(ttl.expireAfterSeconds, AI_USAGE_LOG_TTL_SECONDS);
  assert.ok(indexes.some((i) => i.key.userId === 1 && i.key.createdAt === 1));

  const log = await AiUsageLog.create({
    analysisRunId: "run-1",
    attempt: 1,
    kind: "full",
    trigger: "technical_test",
    userId: new mongoose.Types.ObjectId(),
    requestedModel: "gemini-3.5-flash-lite",
    startedAt: new Date(),
    outcome: "http_error",
    httpStatus: 429,
  });
  createdLogIds.push(log._id);
  const lean = await AiUsageLog.findById(log._id).lean();
  assert.equal(lean.inputTokens, null);
  assert.equal(lean.totalTokens, null);
  assert.ok(lean.createdAt instanceof Date);
});
