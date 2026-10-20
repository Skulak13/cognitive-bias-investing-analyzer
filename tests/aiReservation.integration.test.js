import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPositionHarness } from "./helpers/positionHarness.js";
import { createKit, validAnalysis, MINUTE } from "./helpers/aiServiceKit.js";

/* Etap 8.6.1–8.6.3 — rezerwacja, zakończenie uruchomienia, pominięcie.
 * Tryb "mongo" (MONGODB_TEST_URI) = prawdziwa baza testowa; tryb "fake" =
 * atrapa w pamięci (tylko logika, bez gwarancji atomowości Mongo). */

const h = await createPositionHarness();
const tag = `[${h.backend}]`;
let kit;

beforeEach(() => {
  kit = createKit(h);
});
afterEach(async () => {
  // Żaden test nie może zostawić pozycji w `pending` bez uruchomienia.
  const stray = (await h.all()).filter(
    (d) => d.lastAnalysisStatus === "pending",
  );
  assert.equal(stray.length, 0, "test zostawił pozycję w pending");
  await h.reset();
});
after(() => h.close());

const reserve = async (id) =>
  kit.service.reserveAnalysis({ positionId: id, userId: await kit.owner(id) });

test(`${tag} 20 równoległych rezerwacji → dokładnie 1 sukces, 19 × busy`, async () => {
  const id = await h.insert();
  const userId = await kit.owner(id);
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      kit.service.reserveAnalysis({ positionId: id, userId }),
    ),
  );
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1);
  assert.equal(results.filter((r) => r.kind === "busy").length, 19);

  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisStatus, "pending");
  assert.equal(doc.lastAnalysisRunId, ok[0].reservation.runId);
  assert.ok(doc.lastAnalysisStartedAt);
  assert.equal(ok[0].reservation.analysisType, "interim");

  await kit.service.finishFailed(ok[0].reservation, "internal_error");
});

test(`${tag} nieprzeterminowane pending → busy; przeterminowane można przejąć`, async () => {
  const id = await h.insert();
  const first = (await reserve(id)).reservation;

  kit.advance(5 * MINUTE); // < AI_STALE_PENDING_MS (10 min)
  assert.equal((await reserve(id)).kind, "busy");

  kit.advance(6 * MINUTE); // łącznie 11 min > 10 min
  const second = await reserve(id);
  assert.equal(second.ok, true);
  assert.notEqual(second.reservation.runId, first.runId);

  // Starsze uruchomienie (przejęte) nie może zmienić statusu ani wyniku nowszego.
  assert.equal(
    (await kit.service.finishFailed(first, "timeout")).reason,
    "write_rejected",
  );
  assert.equal(
    (await kit.service.finishSuccess(first, validAnalysis(first))).reason,
    "write_rejected",
  );
  let doc = await h.get(id);
  assert.equal(doc.lastAnalysisRunId, second.reservation.runId);
  assert.equal(doc.lastAnalysisStatus, "pending");
  assert.equal(doc.analyses.length, 0);

  assert.equal(
    (
      await kit.service.finishSuccess(
        second.reservation,
        validAnalysis(second.reservation),
      )
    ).ok,
    true,
  );
  doc = await h.get(id);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses.length, 1);
  assert.equal(doc.analyses[0].analysisRunId, second.reservation.runId);
});

test(`${tag} cudza, usunięta i błędna pozycja → not_found, bez zmian`, async () => {
  const id = await h.insert();
  const before = await h.get(id);
  const foreign = await kit.service.reserveAnalysis({
    positionId: id,
    userId: "64b000000000000000000001",
  });
  assert.equal(foreign.kind, "not_found");
  assert.equal(
    (await kit.service.reserveAnalysis({ positionId: "nie-id", userId: "x" }))
      .kind,
    "not_found",
  );

  await h.setFields(id, { deletedAt: new Date() });
  assert.equal((await reserve(id)).kind, "not_found");

  const after = await h.get(id);
  assert.equal(after.lastAnalysisStatus, before.lastAnalysisStatus);
  assert.equal(after.lastAnalysisRunId ?? null, null);
});

test(`${tag} warunki niespełnione → unavailable i status pozycji bez zmian`, async () => {
  const id = await h.insert({ lastAnalysisStatus: "success" });
  kit.cfg.enabled = false;
  const r = await reserve(id);
  assert.deepEqual(
    [r.ok, r.kind, r.reason],
    [false, "unavailable", "ai_disabled"],
  );
  kit.cfg.enabled = true;
  kit.cfg.hasApiKey = false;
  assert.equal((await reserve(id)).reason, "ai_not_configured");
  kit.cfg.hasApiKey = true;
  kit.safeguards.reportRateLimited();
  assert.equal((await reserve(id)).reason, "ai_paused");
  assert.equal((await h.get(id)).lastAnalysisStatus, "success");
});

test(`${tag} rezerwacja zamkniętej pozycji = analiza końcowa i zużycie znacznika`, async () => {
  const id = await h.insert({
    status: "closed",
    finalAnalysisRequestedAt: new Date("2026-10-20T11:00:00Z"),
  });
  const r = await reserve(id);
  assert.equal(r.reservation.analysisType, "final");
  assert.equal((await h.get(id)).finalAnalysisRequestedAt ?? null, null);
  await kit.service.finishFailed(r.reservation, "internal_error");
});

test(`${tag} sukces dopisuje analizę, nie rusza wcześniejszych i zeruje licznik`, async () => {
  const old = validAnalysis(
    { analysisType: "interim" },
    { summary: "Stara analiza", analysisRunId: "stary" },
  );
  const id = await h.insert({
    analyses: [old],
    finalAnalysisAttempts: 2,
    lastAnalysisStatus: "failed",
  });
  const run = (await reserve(id)).reservation;
  const res = await kit.service.finishSuccess(
    run,
    validAnalysis(run, { summary: "Nowa analiza" }),
  );
  assert.equal(res.ok, true);

  const doc = await h.get(id);
  assert.equal(doc.analyses.length, 2);
  assert.equal(doc.analyses[0].summary, "Stara analiza");
  assert.equal(doc.analyses[1].summary, "Nowa analiza");
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.lastAnalysisReason ?? null, null);
  assert.ok(doc.lastAnalyzedAt);
  assert.equal(doc.finalAnalysisAttempts, 0);
});

test(`${tag} pozycja usunięta w trakcie analizy → zapis odrzucony, brak analizy`, async () => {
  const id = await h.insert();
  const run = (await reserve(id)).reservation;
  await h.setFields(id, { deletedAt: new Date() });
  const res = await kit.service.finishSuccess(run, validAnalysis(run));
  assert.equal(res.reason, "write_rejected");
  const doc = await h.get(id);
  assert.equal(doc.analyses.length, 0);
  assert.equal(doc.lastAnalysisStatus, "pending");
  // sprzątanie po teście: pozycja usunięta nie ma już komu zostać w pending
  await h.setFields(id, {
    lastAnalysisStatus: "failed",
    lastAnalysisReason: "internal_error",
  });
});

test(`${tag} niepoprawny dokument analizy nie trafia do bazy (failed/internal_error)`, async () => {
  const id = await h.insert();
  const run = (await reserve(id)).reservation;
  const bad = validAnalysis(run);
  delete bad.summary; // pole wymagane w schemacie
  const res = await kit.service.finishSuccess(run, bad);
  assert.equal(res.reason, "invalid_document");
  const doc = await h.get(id);
  assert.equal(doc.analyses.length, 0);
  assert.equal(doc.lastAnalysisStatus, "failed");
  assert.equal(doc.lastAnalysisReason, "internal_error");
});

test(`${tag} failed i skipped po rezerwacji; nieznany powód → błąd programisty`, async () => {
  const id = await h.insert();
  let run = (await reserve(id)).reservation;
  assert.equal((await kit.service.finishFailed(run, "timeout")).ok, true);
  let doc = await h.get(id);
  assert.deepEqual(
    [doc.lastAnalysisStatus, doc.lastAnalysisReason],
    ["failed", "timeout"],
  );
  // drugi zapis tego samego uruchomienia (już nie pending) jest odrzucony
  assert.equal(
    (await kit.service.finishFailed(run, "internal_error")).reason,
    "write_rejected",
  );

  run = (await reserve(id)).reservation;
  assert.equal((await kit.service.finishSkipped(run, "ai_paused")).ok, true);
  doc = await h.get(id);
  assert.deepEqual(
    [doc.lastAnalysisStatus, doc.lastAnalysisReason],
    ["skipped", "ai_paused"],
  );

  run = (await reserve(id)).reservation;
  await assert.rejects(
    () => kit.service.finishFailed(run, "wymyślony"),
    TypeError,
  );
  await assert.rejects(
    () => kit.service.finishSkipped(run, "timeout"),
    TypeError,
  );
  await kit.service.finishFailed(run, "internal_error");
});

test(`${tag} skipWithoutRun: każdy powód, status ≠ pending; nie nadpisuje aktywnego pending`, async () => {
  for (const reason of [
    "ai_disabled",
    "ai_paused",
    "ai_not_configured",
    "consent_missing",
  ]) {
    const id = await h.insert({ lastAnalysisStatus: "failed" });
    const r = await kit.service.skipWithoutRun({
      positionId: id,
      userId: await kit.owner(id),
      reason,
    });
    assert.equal(r.ok, true, reason);
    const doc = await h.get(id);
    assert.deepEqual(
      [doc.lastAnalysisStatus, doc.lastAnalysisReason],
      ["skipped", reason],
    );
  }

  const id = await h.insert();
  const run = (await reserve(id)).reservation;
  const r = await kit.service.skipWithoutRun({
    positionId: id,
    userId: await kit.owner(id),
    reason: "ai_disabled",
  });
  assert.equal(r.ok, false);
  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisStatus, "pending");
  assert.equal(doc.lastAnalysisRunId, run.runId);
  await kit.service.finishFailed(run, "internal_error");
});

test(`${tag} skipWithoutRun z zużyciem znacznika: tylko zamknięta pozycja ze znacznikiem`, async () => {
  const closed = await h.insert({
    status: "closed",
    finalAnalysisRequestedAt: new Date("2026-10-20T11:00:00Z"),
  });
  const open = await h.insert();
  const call = async (id) =>
    kit.service.skipWithoutRun({
      positionId: id,
      userId: await kit.owner(id),
      reason: "consent_missing",
      consumeMarker: true,
    });
  assert.equal((await call(open)).ok, false);
  assert.equal((await call(closed)).ok, true);
  const doc = await h.get(closed);
  assert.equal(doc.finalAnalysisRequestedAt ?? null, null);
  assert.deepEqual(
    [doc.lastAnalysisStatus, doc.lastAnalysisReason],
    ["skipped", "consent_missing"],
  );
  assert.equal((await call(closed)).ok, false); // znacznika już nie ma
});
