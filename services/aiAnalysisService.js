/**
 * Serwis analizy AI — część stanowa (Etap 8.6, D8-09, D8-10, D8-19, D8-27).
 *
 * Ten plik zarządza WYŁĄCZNIE stanem analiz w dokumencie `Position`:
 *   - rezerwacja analizy (jeden atomowy zapis; 8.6.1),
 *   - zakończenie uruchomienia: success / failed / skipped (8.6.2),
 *   - pominięcie analizy po `close` (8.6.3),
 *   - odzyskiwanie po restarcie i przegląd cykliczny (8.6.4),
 *   - trwałe żądanie analizy końcowej po `close` (8.6.5).
 * NIE zna Gemini, nie składa danych wejściowych ani promptu (to 8.7–8.9).
 * Faktyczną pracę wykonuje WSTRZYKNIĘTY `executor` (w 8.9 orkiestrator,
 * w testach atrapa). AUTOMATYCZNY start analizy końcowej (`tryStartFinalAnalysis`)
 * bez executora niczego nie rezerwuje — inaczej pozycja zostałaby w `pending`
 * bez uruchomienia (D8-09). RĘCZNA rezerwacja (`reserveAnalysis`) nie sprawdza
 * executora: warstwa HTTP (8.10) rezerwuje i od razu wywołuje `executeReservation`,
 * a ten bez executora zamyka uruchomienie jako `failed`/`internal_error`, więc
 * `pending` nigdy nie zostaje bez wykonawcy.
 *
 * ZAŁOŻENIE: jedna instancja serwera (plan 6.1.1, sekcja 9). Odzyskiwanie przy
 * starcie zamienia KAŻDE `pending` na `failed` — przy kilku instancjach
 * zerwałoby to analizy trwające w innych procesach. Przy skalowaniu poziomym
 * ten mechanizm trzeba zmienić.
 *
 * Ochrona przed starszym uruchomieniem (D8-10): każdy zapis końcowy ma w filtrze
 * `lastAnalysisRunId` własnego uruchomienia ORAZ `lastAnalysisStatus: "pending"`.
 * Uruchomienie przejęte, przeterminowane lub zerwane restartem nie zmieni więc
 * ani statusu, ani wyniku nowszego uruchomienia.
 *
 * Bez treści użytkownika w logu: zdarzenia zawierają tylko identyfikatory,
 * powody i liczby.
 */
import crypto from "node:crypto";
import mongoose from "mongoose";
import Position from "../models/Position.js";
import User from "../models/User.js";
import { getAiConfig } from "../config/aiConfig.js";
import { aiSafeguards } from "./aiSafeguards.js";
import { hasValidAiConsent } from "../utils/aiConsent.js";

export const STATUS_PENDING = "pending";
export const STATUS_SUCCESS = "success";
export const STATUS_FAILED = "failed";
export const STATUS_SKIPPED = "skipped";

/** Powody `failed` (plan 6.3). */
export const FAILED_REASONS = Object.freeze([
  "provider_unavailable",
  "provider_rate_limited",
  "timeout",
  "invalid_response",
  "truncated_output",
  "blocked_by_provider",
  "provider_config_error",
  "server_restart",
  "stale_timeout",
  "internal_error",
]);

/** Powody `skipped` (plan 6.3) — żadne wywołanie Gemini nie zostało wykonane. */
export const SKIPPED_REASONS = Object.freeze([
  "ai_disabled",
  "ai_paused",
  "ai_not_configured",
  "consent_missing",
]);

/**
 * Powody `failed`, po których analiza końcowa przerwana infrastrukturalnie może
 * dostać kolejną automatyczną próbę (zatwierdzony wariant A, D8-27). Błąd
 * dostawcy i inne powody NIE wznawiają zadania automatycznie.
 */
export const RESUMABLE_FAILED_REASONS = Object.freeze([
  "server_restart",
  "stale_timeout",
]);

const DEFAULT_RECOVERY_BATCH = 20;

/**
 * Przedrostek identyfikatora uruchomienia, które wystartowała AUTOMATYCZNA
 * analiza końcowa (`tryStartFinalAnalysis`). To trwały ślad rodzaju uruchomienia
 * bez zmiany schematu: odzyskiwanie wznawia (przywraca znacznik) wyłącznie
 * przerwane uruchomienia z tym przedrostkiem — nigdy ręczne `analyze`.
 */
export const AUTO_FINAL_RUN_PREFIX = "final-auto:";
export const isAutoFinalRunId = (runId) =>
  typeof runId === "string" && runId.startsWith(AUTO_FINAL_RUN_PREFIX);

const isId = (value) =>
  (typeof value === "string" || value instanceof mongoose.Types.ObjectId) &&
  mongoose.isValidObjectId(value);

const defaultLoadUser = (userId) =>
  User.findById(userId)
    .select("emailVerifiedAt disclaimerAcceptedAt disclaimerVersion")
    .lean();

const defaultLog = (event, fields = {}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      scope: "ai",
      event,
      ...fields,
    }),
  );
};

/**
 * Sprawdza wpis `analyses[]` schematem Mongoose BEZ zapisu do bazy.
 * Zapis przez `findOneAndUpdate` + `$push` nie uruchamia walidatorów schematu,
 * więc bez tego kroku niepoprawny dokument mógłby trafić do bazy (plan 6.4).
 */
export async function validateAnalysisEntry(entry) {
  try {
    const probe = new Position();
    probe.analyses.push(entry);
    await probe.validate(["analyses"]);
    return { ok: true };
  } catch (error) {
    const paths = error?.errors ? Object.keys(error.errors) : [];
    return { ok: false, paths };
  }
}

export function createAiAnalysisService({
  PositionModel = Position,
  loadUser = defaultLoadUser,
  safeguards = aiSafeguards,
  getConfig = getAiConfig,
  now = () => Date.now(),
  generateRunId = () => crypto.randomUUID(),
  executor = null,
  log = defaultLog,
  recoveryBatchSize = DEFAULT_RECOVERY_BATCH,
} = {}) {
  let currentExecutor = executor;
  // Moment utworzenia serwisu (= start procesu). Uruchomienia rozpoczęte PO nim
  // należą do tego procesu i odzyskiwanie startowe ich nie rusza (idempotencja
  // ponawianego odzyskiwania).
  const bootedAt = new Date(now());
  let startupRecovered = false;

  const nowDate = () => new Date(now());

  /** Filtr „brak AKTYWNEGO uruchomienia”: nie `pending` albo `pending` przeterminowane. */
  const notActiveFilter = () => {
    const staleBefore = new Date(now() - getConfig().stalePendingMs);
    return {
      $or: [
        { lastAnalysisStatus: { $ne: STATUS_PENDING } },
        { lastAnalysisStartedAt: null },
        { lastAnalysisStartedAt: { $lt: staleBefore } },
      ],
    };
  };

  const ownerFilter = (run) => ({
    _id: run.positionId,
    userId: run.userId,
    deletedAt: null,
    lastAnalysisRunId: run.runId,
    lastAnalysisStatus: STATUS_PENDING,
  });

  const safeLog = (event, fields) => {
    try {
      log(event, fields);
    } catch {
      /* log nigdy nie przerywa pracy */
    }
  };

  // ---------------------------------------------------------------- 8.6.1

  /**
   * Rezerwacja analizy na żądanie użytkownika (ręczne `analyze`).
   * Nie rzuca wyjątków domenowych — zwraca wynik, który warstwa HTTP (8.10)
   * zamieni na kody: not_found → 404, busy → 409 `analysis_in_progress`,
   * unavailable → 503 z powodem. Gdy warunki nie są spełnione, status pozycji
   * NIE jest zmieniany (plan 6.3, reguła 2).
   *
   * Jeden atomowy zapis: filtr zawiera „brak aktywnego pending”. Rezerwacja na
   * zamkniętej pozycji jest analizą końcową i zużywa znacznik (6.3.1);
   * znacznik jest ustawiany wyłącznie razem z zamknięciem, więc dla pozycji
   * otwartej czyszczenie go jest zapisem neutralnym.
   */
  async function reserveAnalysis({ positionId, userId }) {
    if (!isId(positionId) || !isId(userId)) {
      return { ok: false, kind: "not_found" };
    }

    const can = safeguards.canStartAnalysis();
    if (!can.ok) return { ok: false, kind: "unavailable", reason: can.reason };

    const runId = generateRunId();
    const startedAt = nowDate();

    const doc = await PositionModel.findOneAndUpdate(
      { _id: positionId, userId, deletedAt: null, ...notActiveFilter() },
      {
        $set: {
          lastAnalysisStatus: STATUS_PENDING,
          lastAnalysisRunId: runId,
          lastAnalysisStartedAt: startedAt,
          lastAnalysisReason: null,
          finalAnalysisRequestedAt: null,
        },
      },
      { returnDocument: "after" },
    )
      .select("status")
      .lean();

    if (!doc) {
      const exists = await PositionModel.exists({
        _id: positionId,
        userId,
        deletedAt: null,
      });
      return { ok: false, kind: exists ? "busy" : "not_found" };
    }

    return {
      ok: true,
      reservation: {
        runId,
        positionId: String(positionId),
        userId: String(userId),
        analysisType: doc.status === "closed" ? "final" : "interim",
        startedAt,
        trigger: "manual",
      },
    };
  }

  // ---------------------------------------------------------------- 8.6.2

  async function finishWith(run, set, kind) {
    const doc = await PositionModel.findOneAndUpdate(
      ownerFilter(run),
      { $set: set },
      { returnDocument: "after" },
    )
      .select("_id")
      .lean();
    if (!doc) {
      safeLog("write_rejected", {
        runId: run.runId,
        positionId: run.positionId,
        kind,
      });
      return { ok: false, reason: "write_rejected" };
    }
    return { ok: true };
  }

  /** Sukces: dopisanie analizy + `success` + `lastAnalyzedAt` jednym zapisem. */
  async function finishSuccess(run, analysis) {
    const entry = { ...analysis, analysisRunId: run.runId };
    const check = await validateAnalysisEntry(entry);
    if (!check.ok) {
      safeLog("invalid_analysis_document", {
        runId: run.runId,
        positionId: run.positionId,
        paths: check.paths,
      });
      await finishFailed(run, "internal_error");
      return { ok: false, reason: "invalid_document" };
    }

    const doc = await PositionModel.findOneAndUpdate(
      ownerFilter(run),
      {
        $push: { analyses: entry },
        $set: {
          lastAnalysisStatus: STATUS_SUCCESS,
          lastAnalysisReason: null,
          lastAnalyzedAt: nowDate(),
          finalAnalysisAttempts: 0,
        },
      },
      { returnDocument: "after" },
    )
      .select("_id")
      .lean();

    if (!doc) {
      safeLog("write_rejected", {
        runId: run.runId,
        positionId: run.positionId,
        kind: "success",
      });
      return { ok: false, reason: "write_rejected" };
    }
    return { ok: true };
  }

  /** Porażka uruchomienia, które jest właścicielem `pending`. */
  async function finishFailed(run, reason) {
    if (!FAILED_REASONS.includes(reason)) {
      throw new TypeError(`Nieznany powód failed: ${reason}`);
    }
    return finishWith(
      run,
      { lastAnalysisStatus: STATUS_FAILED, lastAnalysisReason: reason },
      "failed",
    );
  }

  /** Pominięcie PO rezerwacji (warunki zmieniły się, Gemini nie zostało wywołane). */
  async function finishSkipped(run, reason) {
    if (!SKIPPED_REASONS.includes(reason)) {
      throw new TypeError(`Nieznany powód skipped: ${reason}`);
    }
    return finishWith(
      run,
      { lastAnalysisStatus: STATUS_SKIPPED, lastAnalysisReason: reason },
      "skipped",
    );
  }

  // ---------------------------------------------------------------- 8.6.3

  /**
   * Pominięcie analizy BEZ rezerwacji (analiza po `close`, gdy warunki nie są
   * spełnione). Warunkowy zapis tylko wtedy, gdy pozycja nie ma aktywnego
   * `pending` — cudzej pracy nie nadpisujemy. Przy analizie końcowej zużywa
   * znacznik; wtedy filtr wymaga też zamkniętej pozycji z ustawionym znacznikiem.
   */
  async function skipWithoutRun({
    positionId,
    userId,
    reason,
    consumeMarker = false,
  }) {
    if (!SKIPPED_REASONS.includes(reason)) {
      throw new TypeError(`Nieznany powód skipped: ${reason}`);
    }
    if (!isId(positionId) || !isId(userId))
      return { ok: false, reason: "not_found" };

    const filter = {
      _id: positionId,
      userId,
      deletedAt: null,
      ...notActiveFilter(),
    };
    const set = {
      lastAnalysisStatus: STATUS_SKIPPED,
      lastAnalysisReason: reason,
    };
    if (consumeMarker) {
      filter.status = "closed";
      filter.finalAnalysisRequestedAt = { $ne: null };
      set.finalAnalysisRequestedAt = null;
    }

    const doc = await PositionModel.findOneAndUpdate(
      filter,
      { $set: set },
      { returnDocument: "after" },
    )
      .select("_id")
      .lean();
    return doc ? { ok: true } : { ok: false, reason: "not_applicable" };
  }

  // -------------------------------------------------------- wykonanie w tle

  /**
   * Wykonuje zarezerwowane uruchomienie przez wstrzyknięty executor i ZAWSZE na
   * końcu sprawdza, czy czeka analiza końcowa (plan 6.1, krok 8). Nigdy nie
   * rzuca wyjątku. Executor dostaje `controls` związane z tym uruchomieniem.
   * Jeśli executor skończy bez zapisu wyniku, uruchomienie jest zamykane jako
   * `failed`/`internal_error` — żadna pozycja nie zostaje w `pending`.
   */
  async function executeReservation(run) {
    const controls = {
      finishSuccess: (analysis) => finishSuccess(run, analysis),
      finishFailed: (reason) => finishFailed(run, reason),
      finishSkipped: (reason) => finishSkipped(run, reason),
    };
    try {
      if (!currentExecutor) {
        await finishFailed(run, "internal_error");
      } else {
        await currentExecutor(run, controls);
      }
    } catch (error) {
      safeLog("executor_error", {
        runId: run.runId,
        positionId: run.positionId,
        name: error?.name ?? "Error",
      });
    } finally {
      try {
        // Cichy bezpiecznik: dopasuje się tylko, gdy uruchomienie nadal jest pending.
        await PositionModel.findOneAndUpdate(
          ownerFilter(run),
          {
            $set: {
              lastAnalysisStatus: STATUS_FAILED,
              lastAnalysisReason: "internal_error",
            },
          },
          { returnDocument: "after" },
        )
          .select("_id")
          .lean();
      } catch (error) {
        safeLog("close_pending_error", {
          runId: run.runId,
          name: error?.name ?? "Error",
        });
      }
      try {
        const next = await tryStartFinalAnalysis(run.positionId);
        if (next.started) await next.done;
      } catch (error) {
        safeLog("final_check_error", {
          positionId: run.positionId,
          name: error?.name ?? "Error",
        });
      }
    }
  }

  // ---------------------------------------------------------------- 8.6.5

  /**
   * Próba startu analizy końcowej (D8-27). Wywoływana po zatwierdzeniu `close`
   * (8.10.3), na końcu każdego uruchomienia, przy starcie serwera i z przeglądu.
   * Nigdy nie rzuca. Zwraca `{started, reason?, runId?, done?}`; `done` to obietnica
   * zakończenia pracy w tle (nigdy nie jest odrzucana).
   */
  async function tryStartFinalAnalysis(positionId, { trigger = "auto" } = {}) {
    try {
      if (!isId(positionId)) return { started: false, reason: "nothing_to_do" };

      const pos = await PositionModel.findOne({
        _id: positionId,
        deletedAt: null,
        status: "closed",
        finalAnalysisRequestedAt: { $ne: null },
      })
        .select("userId finalAnalysisAttempts")
        .lean();
      if (!pos) return { started: false, reason: "nothing_to_do" };

      const config = getConfig();
      const max = config.finalMaxAutoAttempts;
      const attempts = pos.finalAnalysisAttempts ?? 0;
      const userId = pos.userId;

      // Limit wyczerpany: znacznik jest zużywany, zadanie nie wraca (wariant A).
      if (attempts >= max) {
        await PositionModel.findOneAndUpdate(
          {
            _id: positionId,
            userId,
            deletedAt: null,
            status: "closed",
            finalAnalysisRequestedAt: { $ne: null },
          },
          { $set: { finalAnalysisRequestedAt: null } },
          { returnDocument: "after" },
        )
          .select("_id")
          .lean();
        safeLog("final_attempts_exhausted", {
          positionId: String(positionId),
          attempts,
        });
        return { started: false, reason: "attempts_exhausted" };
      }

      // Bez executora niczego nie rezerwujemy (nie tworzymy pending bez uruchomienia).
      if (!currentExecutor) return { started: false, reason: "no_executor" };

      // Warunki: wyłącznik / konfiguracja / pauza, potem zgoda. Niespełnione →
      // skipped + zużycie znacznika (bez czekania na ponowne włączenie AI).
      let skipReason = null;
      const can = safeguards.canStartAnalysis();
      if (!can.ok) {
        skipReason = can.reason;
      } else {
        const user = await loadUser(userId);
        if (!hasValidAiConsent(user, config.consentVersion)) {
          skipReason = "consent_missing";
        }
      }
      if (skipReason) {
        const skipped = await skipWithoutRun({
          positionId,
          userId,
          reason: skipReason,
          consumeMarker: true,
        });
        return {
          started: false,
          reason: "skipped",
          skipReason,
          recorded: skipped.ok,
        };
      }

      // Atomowy start: kto wygra ten zapis, uruchamia analizę (żadnych duplikatów).
      const runId = AUTO_FINAL_RUN_PREFIX + generateRunId();
      const startedAt = nowDate();
      const doc = await PositionModel.findOneAndUpdate(
        {
          _id: positionId,
          userId,
          deletedAt: null,
          status: "closed",
          finalAnalysisRequestedAt: { $ne: null },
          $and: [
            notActiveFilter(),
            {
              $or: [
                { finalAnalysisAttempts: { $lt: max } },
                { finalAnalysisAttempts: null },
              ],
            },
          ],
        },
        {
          $set: {
            lastAnalysisStatus: STATUS_PENDING,
            lastAnalysisRunId: runId,
            lastAnalysisStartedAt: startedAt,
            lastAnalysisReason: null,
            finalAnalysisRequestedAt: null,
          },
          $inc: { finalAnalysisAttempts: 1 },
        },
        { returnDocument: "after" },
      )
        .select("finalAnalysisAttempts")
        .lean();

      // Nie pasuje: trwa analiza lub stan się zmienił — znacznik czeka w bazie.
      if (!doc) return { started: false, reason: "busy_or_changed" };

      const run = {
        runId,
        positionId: String(positionId),
        userId: String(userId),
        analysisType: "final",
        startedAt,
        trigger,
        attempt: doc.finalAnalysisAttempts,
      };
      safeLog("final_analysis_started", {
        runId,
        positionId: run.positionId,
        attempt: run.attempt,
      });
      return {
        started: true,
        runId,
        attempt: run.attempt,
        done: executeReservation(run),
      };
    } catch (error) {
      safeLog("try_start_final_error", { name: error?.name ?? "Error" });
      return { started: false, reason: "error" };
    }
  }

  // ---------------------------------------------------------------- 8.6.4

  /**
   * Odzyskiwanie po restarcie (jedna instancja!): każde `pending` rozpoczęte
   * przed startem tego procesu → `failed`/`server_restart`. Wcześniej, w osobnym
   * kroku, przywracany jest znacznik analizy końcowej przerwanej restartem.
   * Kryterium „to była AUTOMATYCZNA analiza końcowa”: identyfikator uruchomienia
   * z przedrostkiem AUTO_FINAL_RUN_PREFIX, pozycja zamknięta, znacznik zużyty i
   * `0 < finalAnalysisAttempts < limit`. Ręczne `analyze` nigdy nie jest wznawiane.
   * Pozycje po sukcesie mają licznik 0, a `failed`/`skipped` nie są `pending`;
   * po wyczerpaniu limitu zadanie nie wraca (wariant A).
   *
   * Idempotentne i bezpieczne do ponowienia: dotyka tylko uruchomień sprzed startu
   * procesu, więc powtórzenie (np. z przeglądu cyklicznego po nieudanym starcie)
   * nie zerwie analiz rozpoczętych już przez ten proces ani nie przywróci
   * znacznika dwa razy (filtr wymaga znacznika `null`, a po przywróceniu jest ustawiony).
   */
  async function recoverAfterRestart() {
    const max = getConfig().finalMaxAutoAttempts;
    const beforeBoot = {
      $or: [
        { lastAnalysisStartedAt: null },
        { lastAnalysisStartedAt: { $lte: bootedAt } },
      ],
    };
    const restored = await PositionModel.updateMany(
      {
        lastAnalysisStatus: STATUS_PENDING,
        lastAnalysisRunId: { $regex: `^${AUTO_FINAL_RUN_PREFIX}` },
        status: "closed",
        deletedAt: null,
        finalAnalysisRequestedAt: null,
        finalAnalysisAttempts: { $gt: 0, $lt: max },
        ...beforeBoot,
      },
      { $set: { finalAnalysisRequestedAt: nowDate() } },
    );
    const failed = await PositionModel.updateMany(
      { lastAnalysisStatus: STATUS_PENDING, ...beforeBoot },
      {
        $set: {
          lastAnalysisStatus: STATUS_FAILED,
          lastAnalysisReason: "server_restart",
        },
      },
    );
    startupRecovered = true;
    const result = {
      restoredMarkers: restored?.modifiedCount ?? 0,
      failedPending: failed?.modifiedCount ?? 0,
    };
    safeLog("recovery_after_restart", result);
    return result;
  }

  /**
   * Jeden obieg przeglądu cyklicznego (ograniczona liczba pozycji):
   *  1. `pending` starsze niż AI_STALE_PENDING_MS → `failed`/`stale_timeout`
   *     (zapis warunkowy po runId i startedAt; z przywróceniem znacznika, jak przy restarcie),
   *  2. pozycje ze znacznikiem i bez aktywnego pending → próba startu analizy końcowej.
   * Nie czeka na zakończenie startowanych analiz (zwraca ich obietnice w `runs`).
   */
  async function recoverStuckAnalyses() {
    const config = getConfig();
    const max = config.finalMaxAutoAttempts;
    const staleBefore = new Date(now() - config.stalePendingMs);
    let staleFailed = 0;
    let restoredMarkers = 0;

    const stale = await PositionModel.find({
      lastAnalysisStatus: STATUS_PENDING,
      $or: [
        { lastAnalysisStartedAt: null },
        { lastAnalysisStartedAt: { $lt: staleBefore } },
      ],
    })
      .select(
        "status deletedAt finalAnalysisRequestedAt finalAnalysisAttempts lastAnalysisRunId lastAnalysisStartedAt",
      )
      .limit(recoveryBatchSize)
      .lean();

    for (const p of stale) {
      const attempts = p.finalAnalysisAttempts ?? 0;
      const restore =
        isAutoFinalRunId(p.lastAnalysisRunId) &&
        p.status === "closed" &&
        !p.deletedAt &&
        !p.finalAnalysisRequestedAt &&
        attempts > 0 &&
        attempts < max;

      const filter = {
        _id: p._id,
        lastAnalysisStatus: STATUS_PENDING,
        lastAnalysisRunId: p.lastAnalysisRunId ?? null,
        lastAnalysisStartedAt: p.lastAnalysisStartedAt ?? null,
      };
      const set = {
        lastAnalysisStatus: STATUS_FAILED,
        lastAnalysisReason: "stale_timeout",
      };
      if (restore) {
        filter.finalAnalysisRequestedAt = null;
        filter.finalAnalysisAttempts = attempts;
        set.finalAnalysisRequestedAt = nowDate();
      }

      const doc = await PositionModel.findOneAndUpdate(
        filter,
        { $set: set },
        { returnDocument: "after" },
      )
        .select("_id")
        .lean();
      if (doc) {
        staleFailed += 1;
        if (restore) restoredMarkers += 1;
      }
    }

    const runs = [];
    let attempted = 0;
    const waiting = await PositionModel.find({
      finalAnalysisRequestedAt: { $ne: null },
      status: "closed",
      deletedAt: null,
      ...notActiveFilter(),
    })
      .sort({ finalAnalysisRequestedAt: 1 })
      .select("_id")
      .limit(recoveryBatchSize)
      .lean();

    for (const p of waiting) {
      attempted += 1;
      const r = await tryStartFinalAnalysis(p._id);
      if (r.started) runs.push(r.done);
    }

    const result = {
      staleFailed,
      restoredMarkers,
      attempted,
      started: runs.length,
    };
    if (staleFailed || runs.length) safeLog("recovery_cycle", result);
    return { ...result, runs };
  }

  /**
   * Przegląd cykliczny: `setInterval` z `unref` (nie blokuje zamknięcia procesu),
   * bez nakładania się obiegów, błędy tylko do logu. Pierwszy obieg od razu.
   */
  function startRecoveryScheduler({
    intervalMs = getConfig().recoveryIntervalMs,
    runImmediately = true,
  } = {}) {
    let running = false;
    // Zwraca wynik przeglądu (w tym obietnice `runs` wystartowanych analiz), żeby
    // wywołujący — zwłaszcza testy — mógł poczekać na ich zakończenie.
    const cycle = async () => {
      if (running) return null;
      running = true;
      try {
        // Nieudane odzyskiwanie startowe jest ponawiane w każdym obiegu, aż się
        // powiedzie (kolejne błędy trafiają do logu). Zwykły przegląd i tak działa.
        if (!startupRecovered) {
          try {
            await recoverAfterRestart();
          } catch (error) {
            safeLog("startup_recovery_retry_failed", {
              name: error?.name ?? "Error",
            });
          }
        }
        return await recoverStuckAnalyses();
      } catch (error) {
        safeLog("recovery_cycle_error", { name: error?.name ?? "Error" });
        return null;
      } finally {
        running = false;
      }
    };
    const timer = setInterval(cycle, intervalMs);
    timer.unref();
    if (runImmediately) setImmediate(cycle).unref?.();
    return { timer, stop: () => clearInterval(timer), runOnce: cycle };
  }

  return {
    reserveAnalysis,
    finishSuccess,
    finishFailed,
    finishSkipped,
    skipWithoutRun,
    executeReservation,
    tryStartFinalAnalysis,
    recoverAfterRestart,
    recoverStuckAnalyses,
    startRecoveryScheduler,
    setExecutor(fn) {
      currentExecutor = typeof fn === "function" ? fn : null;
    },
    hasExecutor: () => currentExecutor !== null,
    isStartupRecoveryDone: () => startupRecovered,
  };
}

/** Instancja produkcyjna. Executor zostanie podłączony przez orkiestrator (8.9). */
export const aiAnalysisService = createAiAnalysisService();
