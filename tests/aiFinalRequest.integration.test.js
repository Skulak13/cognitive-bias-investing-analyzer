import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPositionHarness } from "./helpers/positionHarness.js";
import {
  createKit,
  validAnalysis,
  deferred,
  MINUTE,
} from "./helpers/aiServiceKit.js";
import { AUTO_FINAL_RUN_PREFIX } from "../services/aiAnalysisService.js";

/* Etap 8.6.4–8.6.5 (D8-27, przypadek B; testy T4, T5, T7 w części).
 * Tryb "mongo" = prawdziwa baza testowa (MONGODB_TEST_URI); "fake" = atrapa. */

const h = await createPositionHarness();
const tag = `[${h.backend}]`;
let kit;

const MARKER = new Date("2026-10-20T11:00:00Z");
const closedWithMarker = (extra = {}) =>
  h.insert({ status: "closed", finalAnalysisRequestedAt: MARKER, ...extra });

beforeEach(() => {
  kit = createKit(h);
});
afterEach(async () => {
  const stray = (await h.all()).filter(
    (d) => d.lastAnalysisStatus === "pending",
  );
  assert.equal(stray.length, 0, "test zostawił pozycję w pending");
  await h.reset();
});
after(() => h.close());

const startFinal = (id) => kit.service.tryStartFinalAnalysis(id);

test(`${tag} (1) znacznik + trwające pending → po jego zakończeniu startuje DOKŁADNIE jedna analiza końcowa`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker();
  const userId = await kit.owner(id);

  // Trwająca analiza okresowa (zarezerwowana przed `close`): pending bez znacznika
  // w rezerwacji — ustawiamy ją ręcznie, żeby znacznik z `close` został nietknięty.
  const runId = "run-interim-1";
  await h.setFields(id, {
    lastAnalysisStatus: "pending",
    lastAnalysisRunId: runId,
    lastAnalysisStartedAt: new Date(kit.clock.t),
  });
  const interim = { runId, positionId: id, userId, analysisType: "interim" };

  // 5 równoległych prób startu przy trwającej analizie: żadna nie startuje, znacznik czeka.
  const early = await Promise.all(
    Array.from({ length: 5 }, () => startFinal(id)),
  );
  assert.equal(early.filter((r) => r.started).length, 0);
  assert.notEqual((await h.get(id)).finalAnalysisRequestedAt, null);

  // Trwająca analiza kończy się; po niej (executeReservation) startuje końcowa.
  await kit.service.finishSuccess(interim, validAnalysis(interim));
  const late = await Promise.all(
    Array.from({ length: 5 }, () => startFinal(id)),
  );
  const started = late.filter((r) => r.started);
  assert.equal(started.length, 1);
  await started[0].done;

  assert.equal(kit.calls.length, 1);
  assert.equal(kit.calls[0].analysisType, "final");
  const doc = await h.get(id);
  assert.equal(doc.finalAnalysisRequestedAt ?? null, null);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.analyses.length, 2); // okresowa + końcowa
  assert.equal(doc.finalAnalysisAttempts, 0); // wyzerowany po sukcesie
});

test(`${tag} (1b) koniec trwającej analizy sam uruchamia końcową (hak na końcu uruchomienia)`, async () => {
  const gate = deferred();
  kit.useExecutor(async (run, controls) => {
    if (run.analysisType === "interim") await gate.promise;
    return controls.finishSuccess(validAnalysis(run));
  });
  const id = await h.insert();
  const manual = (
    await kit.service.reserveAnalysis({
      positionId: id,
      userId: await kit.owner(id),
    })
  ).reservation;
  const running = kit.service.executeReservation(manual); // trwa, czeka na bramkę

  // `close` w trakcie analizy (zapis jak w transakcji zamknięcia — 8.10.3).
  await h.setFields(id, { status: "closed", finalAnalysisRequestedAt: MARKER });
  assert.equal((await startFinal(id)).reason, "busy_or_changed");

  gate.resolve();
  await running; // executeReservation czeka też na końcową uruchomioną z haka
  assert.deepEqual(
    kit.calls.map((c) => c.analysisType),
    ["interim", "final"],
  );
  const doc = await h.get(id);
  assert.equal(doc.analyses.length, 2);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(doc.finalAnalysisRequestedAt ?? null, null);
});

test(`${tag} (2) wcześniejsza analiza kończy się failed → końcowa i tak startuje`, async () => {
  kit.useExecutor(async (run, controls) =>
    run.analysisType === "interim"
      ? controls.finishFailed("provider_unavailable")
      : controls.finishSuccess(validAnalysis(run)),
  );
  const id = await h.insert();
  const manual = (
    await kit.service.reserveAnalysis({
      positionId: id,
      userId: await kit.owner(id),
    })
  ).reservation;
  await h.setFields(id, { status: "closed", finalAnalysisRequestedAt: MARKER });
  await kit.service.executeReservation(manual);

  assert.deepEqual(
    kit.calls.map((c) => c.analysisType),
    ["interim", "final"],
  );
  assert.equal((await h.get(id)).lastAnalysisStatus, "success");
});

test(`${tag} (3) „restart” z czekającym znacznikiem → start dokładnie raz`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker();

  await kit.service.recoverAfterRestart();
  const cycle1 = await kit.service.recoverStuckAnalyses();
  await Promise.all(cycle1.runs);
  const cycle2 = await kit.service.recoverStuckAnalyses();
  await Promise.all(cycle2.runs);

  assert.equal(cycle1.started, 1);
  assert.equal(cycle2.started, 0);
  assert.equal(kit.calls.length, 1);
  assert.equal((await h.get(id)).lastAnalysisStatus, "success");
});

test(`${tag} (4) restart w trakcie analizy końcowej → server_restart, znacznik wraca; po 3 próbach nie`, async () => {
  const hang = deferred();
  kit.useExecutor(async () => hang.promise); // „zawieszona” analiza — przerwie ją restart
  const id = await closedWithMarker();

  const dones = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await startFinal(id);
    assert.equal(r.started, true, `start #${attempt}`);
    dones.push(r.done);
    assert.equal(r.attempt, attempt);
    let doc = await h.get(id);
    assert.equal(doc.lastAnalysisStatus, "pending");
    assert.equal(doc.finalAnalysisRequestedAt ?? null, null);

    const rec = await kit.service.recoverAfterRestart(); // „restart serwera”
    doc = await h.get(id);
    assert.equal(doc.lastAnalysisStatus, "failed");
    assert.equal(doc.lastAnalysisReason, "server_restart");
    assert.equal(doc.finalAnalysisAttempts, attempt);
    if (attempt < 3) {
      assert.equal(
        rec.restoredMarkers,
        1,
        `znacznik wraca po próbie #${attempt}`,
      );
      assert.notEqual(doc.finalAnalysisRequestedAt, null);
    } else {
      assert.equal(rec.restoredMarkers, 0);
      assert.equal(doc.finalAnalysisRequestedAt ?? null, null);
    }
  }

  // Kolejne restarty i przeglądy niczego już nie wznawiają (limit 3 wyczerpany).
  const callsBefore = kit.calls.length;
  for (let i = 0; i < 3; i += 1) {
    await kit.service.recoverAfterRestart();
    const c = await kit.service.recoverStuckAnalyses();
    assert.equal(c.started, 0);
  }
  assert.equal(kit.calls.length, callsBefore);
  assert.equal((await h.get(id)).finalAnalysisRequestedAt ?? null, null);
  hang.resolve(); // zwalnia zawieszone obietnice executora (wyniki odrzucone)
  await Promise.all(dones);
});

test(`${tag} (4b) znacznik z wyczerpanym limitem jest zużywany bez startu`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker({ finalAnalysisAttempts: 3 });
  const r = await startFinal(id);
  assert.deepEqual([r.started, r.reason], [false, "attempts_exhausted"]);
  assert.equal(kit.calls.length, 0);
  assert.equal((await h.get(id)).finalAnalysisRequestedAt ?? null, null);
});

test(`${tag} (5) ręczny analyze na zamkniętej pozycji zużywa znacznik — druga analiza nie powstaje`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker();
  const manual = await kit.service.reserveAnalysis({
    positionId: id,
    userId: await kit.owner(id),
  });
  assert.equal(manual.reservation.analysisType, "final");
  assert.equal((await startFinal(id)).reason, "nothing_to_do");
  await kit.service.executeReservation(manual.reservation);
  assert.equal(kit.calls.length, 1);
  assert.equal((await h.get(id)).analyses.length, 1);
});

test(`${tag} (6) AI wyłączone → skipped/ai_disabled, znacznik zużyty, brak pending; późniejsze włączenie nie uruchamia`, async () => {
  kit.useExecutor();
  kit.cfg.enabled = false;
  const id = await closedWithMarker();
  const r = await startFinal(id);
  assert.deepEqual([r.started, r.skipReason], [false, "ai_disabled"]);
  let doc = await h.get(id);
  assert.deepEqual(
    [doc.lastAnalysisStatus, doc.lastAnalysisReason],
    ["skipped", "ai_disabled"],
  );
  assert.equal(doc.finalAnalysisRequestedAt ?? null, null);

  kit.cfg.enabled = true;
  const c = await kit.service.recoverStuckAnalyses();
  assert.equal(c.started, 0);
  assert.equal(kit.calls.length, 0);
});

test(`${tag} (6b) brak ważnej zgody → skipped/consent_missing, bez automatycznego ponawiania`, async () => {
  kit.useExecutor();
  for (const user of [
    null,
    { disclaimerAcceptedAt: new Date(), disclaimerVersion: null }, // zgoda sprzed wersjonowania
    { disclaimerAcceptedAt: new Date(), disclaimerVersion: "0" }, // stara wersja tekstu
  ]) {
    kit.state.user = user;
    const id = await closedWithMarker();
    const r = await startFinal(id);
    assert.deepEqual([r.started, r.skipReason], [false, "consent_missing"]);
    const doc = await h.get(id);
    assert.deepEqual(
      [doc.lastAnalysisStatus, doc.lastAnalysisReason],
      ["skipped", "consent_missing"],
    );
    assert.equal(doc.finalAnalysisRequestedAt ?? null, null);
    assert.equal(doc.finalAnalysisAttempts, 0);
  }

  // Użytkownik akceptuje zgodę później — to nie wznawia żadnej z pominiętych analiz.
  kit.state.user = { disclaimerAcceptedAt: new Date(), disclaimerVersion: "1" };
  await kit.service.recoverAfterRestart();
  const c = await kit.service.recoverStuckAnalyses();
  assert.equal(c.started, 0);
  assert.equal(kit.calls.length, 0);
});

test(`${tag} (7) przeterminowane pending → failed/stale_timeout przez przegląd; spóźniony zapis odrzucony`, async () => {
  const id = await h.insert();
  const run = (
    await kit.service.reserveAnalysis({
      positionId: id,
      userId: await kit.owner(id),
    })
  ).reservation;

  kit.advance(5 * MINUTE);
  assert.equal((await kit.service.recoverStuckAnalyses()).staleFailed, 0); // jeszcze aktywne

  kit.advance(6 * MINUTE);
  assert.equal((await kit.service.recoverStuckAnalyses()).staleFailed, 1);
  const doc = await h.get(id);
  assert.deepEqual(
    [doc.lastAnalysisStatus, doc.lastAnalysisReason],
    ["failed", "stale_timeout"],
  );

  assert.equal(
    (await kit.service.finishSuccess(run, validAnalysis(run))).reason,
    "write_rejected",
  );
  assert.equal((await h.get(id)).analyses.length, 0);
});

test(`${tag} (7b) przeterminowana analiza końcowa: znacznik wraca i końcowa startuje ponownie`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker();
  // pierwszy start „zawisł”: pending z licznikiem 1 i bez znacznika
  await h.setFields(id, {
    finalAnalysisRequestedAt: null,
    finalAnalysisAttempts: 1,
    lastAnalysisStatus: "pending",
    lastAnalysisRunId: `${AUTO_FINAL_RUN_PREFIX}zawieszona`,
    lastAnalysisStartedAt: new Date(kit.clock.t - 11 * MINUTE),
  });
  const cycle = await kit.service.recoverStuckAnalyses();
  await Promise.all(cycle.runs);
  assert.equal(cycle.staleFailed, 1);
  assert.equal(cycle.restoredMarkers, 1);
  assert.equal(cycle.started, 1);
  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisStatus, "success");
  assert.equal(kit.calls[0].attempt, 2);
});

test(`${tag} (8) usunięta pozycja ze znacznikiem → nic się nie uruchamia`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker({ deletedAt: new Date() });
  assert.equal((await startFinal(id)).reason, "nothing_to_do");
  const c = await kit.service.recoverStuckAnalyses();
  assert.equal(c.started, 0);
  assert.equal(kit.calls.length, 0);
});

test(`${tag} (8b) przegląd nie dotyka pozycji bez znacznika ani otwartych`, async () => {
  kit.useExecutor();
  const open = await h.insert();
  const closedNoMarker = await h.insert({ status: "closed" });
  const c = await kit.service.recoverStuckAnalyses();
  assert.equal(c.started, 0);
  assert.equal((await h.get(open)).lastAnalysisStatus ?? null, null);
  assert.equal((await h.get(closedNoMarker)).lastAnalysisStatus ?? null, null);
});

test(`${tag} (9) odzyskiwanie odróżnia analizę końcową oczekującą od zakończonej, nieudanej i pominiętej`, async () => {
  const cases = {
    // przerwana automatyczna analiza końcowa → wraca
    interruptedFinal: {
      status: "closed",
      lastAnalysisStatus: "pending",
      lastAnalysisRunId: `${AUTO_FINAL_RUN_PREFIX}x`,
      finalAnalysisAttempts: 1,
    },
    // po sukcesie licznik jest 0 → nic nie wraca
    succeeded: {
      status: "closed",
      lastAnalysisStatus: "success",
      finalAnalysisAttempts: 0,
    },
    // błąd dostawcy: nie wznawiamy automatycznie (wariant A), nawet z licznikiem > 0
    providerFailed: {
      status: "closed",
      lastAnalysisStatus: "failed",
      lastAnalysisReason: "provider_unavailable",
      finalAnalysisAttempts: 1,
    },
    // brak danych rynkowych: nie wznawiamy automatycznie (ręczne ponowienie)
    marketFailed: {
      status: "closed",
      lastAnalysisStatus: "failed",
      lastAnalysisReason: "market_data_unavailable",
      finalAnalysisAttempts: 1,
    },
    skipped: {
      status: "closed",
      lastAnalysisStatus: "skipped",
      lastAnalysisReason: "consent_missing",
      finalAnalysisAttempts: 0,
    },
    // limit wyczerpany
    exhausted: {
      status: "closed",
      lastAnalysisStatus: "pending",
      finalAnalysisAttempts: 3,
    },
    // pending ręcznej analizy końcowej (licznik 0) — użytkownik ponowi sam
    manualFinal: {
      status: "closed",
      lastAnalysisStatus: "pending",
      finalAnalysisAttempts: 0,
    },
    // ręczne analyze po nieudanej automatycznej (licznik 1): NIE jest wznawiane
    manualAfterAutoFailure: {
      status: "closed",
      lastAnalysisStatus: "pending",
      lastAnalysisRunId: "reczne-1",
      finalAnalysisAttempts: 1,
    },
    // okresowa analiza zarezerwowana przed `close`: znacznik z `close` już jest
    interimBeforeClose: {
      status: "closed",
      lastAnalysisStatus: "pending",
      finalAnalysisRequestedAt: MARKER,
      finalAnalysisAttempts: 0,
    },
    // otwarta pozycja w pending
    openPending: {
      status: "open",
      lastAnalysisStatus: "pending",
      finalAnalysisAttempts: 0,
    },
  };
  const ids = {};
  for (const [name, fields] of Object.entries(cases))
    ids[name] = await h.insert(fields);

  const res = await kit.service.recoverAfterRestart();
  assert.equal(res.restoredMarkers, 1);

  const marker = async (n) =>
    (await h.get(ids[n])).finalAnalysisRequestedAt ?? null;
  assert.notEqual(await marker("interruptedFinal"), null);
  for (const n of [
    "succeeded",
    "providerFailed",
    "marketFailed",
    "skipped",
    "exhausted",
    "manualFinal",
    "manualAfterAutoFailure",
    "openPending",
  ]) {
    assert.equal(await marker(n), null, n);
  }
  assert.equal(
    (await marker("interimBeforeClose")).getTime(),
    MARKER.getTime(),
  );

  // `pending` → failed/server_restart tylko tam, gdzie było pending; reszta bez zmian.
  const status = async (n) => (await h.get(ids[n])).lastAnalysisStatus;
  const reason = async (n) => (await h.get(ids[n])).lastAnalysisReason ?? null;
  for (const n of [
    "interruptedFinal",
    "exhausted",
    "manualFinal",
    "manualAfterAutoFailure",
    "interimBeforeClose",
    "openPending",
  ]) {
    assert.equal(await status(n), "failed", n);
    assert.equal(await reason(n), "server_restart", n);
  }
  assert.deepEqual(
    [await status("succeeded"), await reason("succeeded")],
    ["success", null],
  );
  assert.deepEqual(
    [await status("providerFailed"), await reason("providerFailed")],
    ["failed", "provider_unavailable"],
  );
  assert.deepEqual(
    [await status("marketFailed"), await reason("marketFailed")],
    ["failed", "market_data_unavailable"],
  );
  assert.deepEqual(
    [await status("skipped"), await reason("skipped")],
    ["skipped", "consent_missing"],
  );
});

test(`${tag} (10b) market_data_unavailable: analiza końcowa kończy się failed, znacznik zużyty, brak automatycznego wznowienia; ręczne ponowienie możliwe`, async () => {
  kit.useExecutor(async (run, controls) =>
    controls.finishFailed("market_data_unavailable"),
  );
  const id = await closedWithMarker();
  await (
    await startFinal(id)
  ).done;

  const failed = await h.get(id);
  assert.deepEqual(
    [failed.lastAnalysisStatus, failed.lastAnalysisReason],
    ["failed", "market_data_unavailable"],
  );
  assert.equal(failed.finalAnalysisRequestedAt ?? null, null);
  assert.equal(failed.analyses.length, 0);

  // przegląd cykliczny nie wznawia (powód nie jest wznawialny)
  const cycle = await kit.service.recoverStuckAnalyses();
  assert.equal(cycle.started, 0);
  assert.equal(kit.calls.length, 1);

  // ręczne ponowienie jest dozwolone (status ≠ pending)
  kit.useExecutor();
  const retry = await kit.service.reserveAnalysis({
    positionId: id,
    userId: await kit.owner(id),
  });
  assert.equal(retry.ok, true);
  await kit.service.executeReservation(retry.reservation);
  assert.equal((await h.get(id)).lastAnalysisStatus, "success");
});

test(`${tag} (10) wyjątek executora i brak zapisu wyniku → failed/internal_error, proces żyje`, async () => {
  kit.useExecutor(async () => {
    throw new Error("awaria testowa");
  });
  const id1 = await closedWithMarker();
  const r1 = await startFinal(id1);
  await r1.done; // nigdy nie odrzucone
  assert.deepEqual(
    [
      (await h.get(id1)).lastAnalysisStatus,
      (await h.get(id1)).lastAnalysisReason,
    ],
    ["failed", "internal_error"],
  );

  kit.useExecutor(async () => {}); // wraca bez zapisu wyniku
  const id2 = await closedWithMarker();
  await (
    await startFinal(id2)
  ).done;
  assert.deepEqual(
    [
      (await h.get(id2)).lastAnalysisStatus,
      (await h.get(id2)).lastAnalysisReason,
    ],
    ["failed", "internal_error"],
  );
  assert.ok(kit.events.some((e) => e.event === "executor_error"));
});

test(`${tag} (11) bez executora nic nie jest rezerwowane (brak pending bez uruchomienia)`, async () => {
  const id = await closedWithMarker();
  const r = await startFinal(id);
  assert.deepEqual([r.started, r.reason], [false, "no_executor"]);
  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisStatus ?? null, null);
  assert.notEqual(doc.finalAnalysisRequestedAt, null);
});

test(`${tag} (12) przegląd: pomijanie pozycji z aktywnym pending`, async () => {
  kit.useExecutor();
  const busy = await closedWithMarker();
  await h.setFields(busy, {
    lastAnalysisStatus: "pending",
    lastAnalysisRunId: "trwa",
    lastAnalysisStartedAt: new Date(kit.clock.t),
  });
  const waiting = [];
  for (let i = 0; i < 3; i += 1) waiting.push(await closedWithMarker());

  const c = await kit.service.recoverStuckAnalyses();
  await Promise.all(c.runs);
  assert.equal(c.started, 3);
  assert.equal((await h.get(busy)).lastAnalysisRunId, "trwa");
  assert.notEqual((await h.get(busy)).finalAnalysisRequestedAt, null);

  // sprzątanie: zamykamy „trwającą” analizę
  await kit.service.finishFailed(
    { runId: "trwa", positionId: busy, userId: await kit.owner(busy) },
    "internal_error",
  );
});

test(`${tag} (12b) przegląd obsługuje najwyżej tyle pozycji na obieg, ile wynosi limit`, async () => {
  kit = createKit(h, { batch: 2 });
  kit.useExecutor();
  for (let i = 0; i < 5; i += 1) await closedWithMarker();

  const sizes = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await kit.service.recoverStuckAnalyses();
    await Promise.all(c.runs);
    sizes.push(c.started);
  }
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(kit.calls.length, 5);
});

test(`${tag} (13) znacznik zużyty przez ręczną analizę między odczytem a startem → brak drugiej analizy`, async () => {
  kit.useExecutor();
  const id = await closedWithMarker();
  // „Równoległy” ręczny analyze (rezerwacja + zakończenie) w chwili, gdy tryStart
  // czeka na odczyt zgody — czyli po odczycie pozycji, a przed atomowym startem.
  kit.state.onLoadUser = async () => {
    kit.state.onLoadUser = null;
    const manual = await kit.service.reserveAnalysis({
      positionId: id,
      userId: await kit.owner(id),
    });
    await kit.service.executeReservation(manual.reservation);
  };
  const r = await startFinal(id);
  assert.deepEqual([r.started, r.reason], [false, "busy_or_changed"]);
  assert.equal(kit.calls.length, 1); // tylko ręczna
  assert.equal((await h.get(id)).analyses.length, 1);
});

test(`${tag} (14) przerwane RĘCZNE analyze po nieudanej automatycznej NIE jest wznawiane (restart)`, async () => {
  const hang = deferred();
  kit.useExecutor(async () => hang.promise);
  const id = await closedWithMarker();

  // automatyczna analiza końcowa #1 przerwana restartem → znacznik wraca, licznik 1
  const auto = await startFinal(id);
  assert.equal(auto.started, true);
  await kit.service.recoverAfterRestart();
  let doc = await h.get(id);
  assert.equal(doc.finalAnalysisAttempts, 1);
  assert.notEqual(doc.finalAnalysisRequestedAt, null);

  // użytkownik uruchamia analizę ręczną (zużywa znacznik); licznik zostaje 1
  const manual = await kit.service.reserveAnalysis({
    positionId: id,
    userId: await kit.owner(id),
  });
  assert.equal(manual.ok, true);
  assert.equal((await h.get(id)).finalAnalysisAttempts, 1);

  // restart przed końcem analizy ręcznej: failed/server_restart i ZERO wznowień
  kit.advance(1000);
  const rec = await kit.service.recoverAfterRestart();
  assert.equal(rec.restoredMarkers, 0);
  doc = await h.get(id);
  assert.deepEqual(
    [doc.lastAnalysisStatus, doc.lastAnalysisReason],
    ["failed", "server_restart"],
  );
  assert.equal(doc.finalAnalysisRequestedAt ?? null, null);
  const callsBefore = kit.calls.length;
  const cycle = await kit.service.recoverStuckAnalyses();
  assert.equal(cycle.started, 0);
  assert.equal(kit.calls.length, callsBefore);
  hang.resolve();
  await auto.done;
});

test(`${tag} (14b) to samo po stale_timeout: ręczne nie wraca, automatyczne wraca`, async () => {
  const hang = deferred();
  kit.useExecutor(async () => hang.promise);

  const manualId = await closedWithMarker({ finalAnalysisAttempts: 1 });
  await kit.service.reserveAnalysis({
    positionId: manualId,
    userId: await kit.owner(manualId),
  });

  const autoId = await closedWithMarker();
  const autoFirst = await startFinal(autoId);
  assert.equal(autoFirst.started, true);

  kit.advance(11 * MINUTE);
  const c = await kit.service.recoverStuckAnalyses();
  assert.equal(c.staleFailed, 2);
  assert.equal(c.restoredMarkers, 1, "tylko automatyczna");

  const manual = await h.get(manualId);
  assert.deepEqual(
    [manual.lastAnalysisStatus, manual.lastAnalysisReason],
    ["failed", "stale_timeout"],
  );
  assert.equal(manual.finalAnalysisRequestedAt ?? null, null);
  assert.equal(c.started, 1); // automatyczna wystartowała po przywróceniu znacznika
  assert.equal((await h.get(autoId)).finalAnalysisAttempts, 2);
  hang.resolve();
  await Promise.all([autoFirst.done, ...c.runs]);
});

test(`${tag} (15) nieudane odzyskiwanie startowe jest ponawiane przez przegląd; powtórzenie jest idempotentne`, async () => {
  let failures = 2; // start + pierwszy obieg przeglądu zawodzą, drugi obieg się udaje
  let updateManyCalls = 0;
  const flaky = new Proxy(h.Position, {
    get(target, prop) {
      if (prop === "updateMany") {
        return (...args) => {
          updateManyCalls += 1;
          if (failures > 0) {
            failures -= 1;
            throw new Error("chwilowa awaria bazy");
          }
          return target.updateMany(...args);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  kit = createKit(h, { model: flaky });
  kit.useExecutor();

  // przerwana automatyczna analiza końcowa z poprzedniego procesu (licznik 1, bez znacznika)
  const id = await h.insert({
    status: "closed",
    lastAnalysisStatus: "pending",
    lastAnalysisRunId: `${AUTO_FINAL_RUN_PREFIX}stary`,
    lastAnalysisStartedAt: new Date(kit.clock.t - 1000),
    finalAnalysisAttempts: 1,
  });

  await assert.rejects(
    () => kit.service.recoverAfterRestart(),
    /chwilowa awaria/,
  );
  assert.equal(kit.service.isStartupRecoveryDone(), false);
  assert.equal((await h.get(id)).lastAnalysisStatus, "pending"); // nic nie zmieniono

  // przegląd cykliczny ponawia operację startową, a potem wznawia analizę końcową
  kit.advance(1000);
  const sched = kit.service.startRecoveryScheduler({
    intervalMs: 3_600_000,
    runImmediately: false,
  });
  await sched.runOnce(); // ponowienie nieudane — błąd trafia do logu, nic nie wraca
  assert.equal(kit.service.isStartupRecoveryDone(), false);
  assert.equal(
    kit.events.filter((e) => e.event === "startup_recovery_retry_failed")
      .length,
    1,
  );
  assert.equal(kit.calls.length, 0);
  assert.equal((await h.get(id)).lastAnalysisStatus, "pending");
  const retried = await sched.runOnce(); // ponowienie udane
  assert.equal(kit.service.isStartupRecoveryDone(), true);
  await Promise.all(retried.runs); // deterministycznie: czekamy na koniec wznowionej analizy
  assert.equal(kit.calls.length, 1, "dokładnie jedna wznowiona analiza");
  assert.equal(kit.calls[0].attempt, 2);
  assert.equal((await h.get(id)).lastAnalysisStatus, "success");

  // kolejny obieg nie powtarza operacji startowej (flaga) i nic nie duplikuje
  const callsAfterFirst = updateManyCalls;
  await sched.runOnce();
  sched.stop();
  assert.equal(updateManyCalls, callsAfterFirst);
  assert.equal(kit.calls.length, 1);
});

test(`${tag} (15b) ponowione odzyskiwanie nie rusza analiz rozpoczętych już przez ten proces`, async () => {
  kit.useExecutor();
  const old = await h.insert({
    lastAnalysisStatus: "pending",
    lastAnalysisRunId: "poprzedni-proces",
    lastAnalysisStartedAt: new Date(kit.clock.t - 5000),
  });
  kit.advance(1000); // od tej chwili uruchomienia należą do TEGO procesu
  const fresh = await h.insert();
  const run = (
    await kit.service.reserveAnalysis({
      positionId: fresh,
      userId: await kit.owner(fresh),
    })
  ).reservation;

  const r1 = await kit.service.recoverAfterRestart();
  assert.equal(r1.failedPending, 1);
  assert.equal((await h.get(old)).lastAnalysisReason, "server_restart");
  assert.equal((await h.get(fresh)).lastAnalysisStatus, "pending");

  const r2 = await kit.service.recoverAfterRestart(); // powtórzenie
  assert.deepEqual([r2.failedPending, r2.restoredMarkers], [0, 0]);
  assert.equal((await h.get(fresh)).lastAnalysisStatus, "pending");
  assert.equal(
    (await kit.service.finishSuccess(run, validAnalysis(run))).ok,
    true,
  );
});

test(`${tag} (15c) częściowo wykonane odzyskiwanie (znacznik przywrócony, pending zostało) nie przywraca znacznika drugi raz`, async () => {
  kit.useExecutor();
  const id = await h.insert({
    status: "closed",
    lastAnalysisStatus: "pending",
    lastAnalysisRunId: `${AUTO_FINAL_RUN_PREFIX}stary`,
    lastAnalysisStartedAt: new Date(kit.clock.t - 1000),
    finalAnalysisAttempts: 1,
    finalAnalysisRequestedAt: new Date(kit.clock.t - 500), // krok 1 już się wykonał
  });
  const r = await kit.service.recoverAfterRestart();
  assert.deepEqual([r.restoredMarkers, r.failedPending], [0, 1]);
  const doc = await h.get(id);
  assert.equal(doc.lastAnalysisReason, "server_restart");
  assert.equal(doc.finalAnalysisAttempts, 1);
  const c = await kit.service.recoverStuckAnalyses();
  await Promise.all(c.runs);
  assert.equal(c.started, 1); // dokładnie jedno wznowienie
  assert.equal(kit.calls.length, 1);
});
