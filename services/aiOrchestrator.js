/**
 * Orkiestrator analiz AI (Etap 8.9.2–8.9.4; plan 6.1, 6.4, 6.5, 6.8, 6.14).
 *
 * Łączy gotowe elementy, niczego nie dublując:
 *   rezerwacja i zapis stanu  → services/aiAnalysisService.js (8.6) — tu tylko przez `controls`
 *   dane wejściowe i migawka  → services/aiInputBuilder.js (8.7)
 *   wywołanie modelu          → services/geminiClient.js (8.8) — JEDYNE miejsce znające API Google
 *   kontrola odpowiedzi       → utils/validateAiResponse.js (Etap 7)
 *   dziennik zużycia          → services/aiUsageLogger.js (8.9.1)
 *   pauza po HTTP 429         → services/aiSafeguards.js (8.3)
 *
 * Dwie ścieżki:
 *   1. `executeFullAnalysis(run, controls)` — EXECUTOR dla `aiAnalysisService.setExecutor()`.
 *      Rezerwację robi serwis (`reserveAnalysis` / `tryStartFinalAnalysis`), a `executeReservation`
 *      wywołuje ten executor i ZAWSZE po nim sprawdza, czy czeka analiza końcowa
 *      (`tryStartFinalAnalysis`) oraz zamyka ewentualne osierocone `pending`. Orkiestrator
 *      NIE wywołuje `tryStartFinalAnalysis` drugi raz — to byłby drugi, konkurujący mechanizm.
 *   2. `runQuickCheck({userId, positionId, actionId})` — synchroniczny quick-check (D8-20);
 *      wynik wraca do wywołującego (warstwa HTTP, 8.10), bo quick-check nie ma pola statusu.
 *
 * ── Mapowanie na ISTNIEJĄCE statusy i powody (bez nowych wartości) ───────────────
 *   builder: market_data_unavailable        → failed / market_data_unavailable (model niewywołany)
 *   builder: position_not_found, no_actions,
 *            action_not_found               → failed / internal_error (po rezerwacji to stan
 *                                             niespójny, np. pozycja usunięta w trakcie)
 *   klient:  unavailable → provider_unavailable      rate_limited → provider_rate_limited
 *            timeout → timeout                        config → provider_config_error
 *            blocked → blocked_by_provider            truncated → truncated_output
 *            bad_output → invalid_response
 *   walidator odrzucił (po jednym ponowieniu)         → failed / invalid_response
 *   wyjątek w orkiestratorze                          → failed / internal_error
 *   warunki zmieniły się między rezerwacją a PIERWSZYM wysłaniem → skipped / ai_disabled |
 *                                             ai_paused | ai_not_configured | consent_missing
 *                                             (model niewywołany)
 *   warunki zmieniły się dopiero przed PONOWIENIEM (model był już wywołany) → failed z powodem
 *                                             poprzedniej odpowiedzi (invalid_response); `skipped`
 *                                             znaczy wyłącznie „model niewywołany” (plan 6.3)
 *
 * ── Ponowienia ──────────────────────────────────────────────────────────────────
 * Klient sam ponawia błędy przejściowe (do 2 razy). Orkiestrator dodaje NAJWYŻEJ JEDNO
 * ponowne wywołanie po odpowiedzi odrzuconej przez walidator albo nie-JSON (`bad_output`)
 * — plan 6.8. Ucięcie, blokada, 429 i błędy konfiguracji nie są ponawiane. Przed KAŻDYM
 * wywołaniem, także ponowionym, sprawdzamy ponownie wyłącznik, pauzę ochronną i zgodę
 * (`beforeSend`); licznik wywołań rośnie tuż przed `send()`.
 *
 * ── Bezpieczeństwo ──────────────────────────────────────────────────────────────
 * Zapisujemy wyłącznie odpowiedź, która przeszła walidator; analiza jest tylko DOPISYWANA
 * (`analyses[]`), a przy quick-checku zapis jest warunkowy (nie nadpisuje nowszego wyniku).
 * Logi i dziennik zużycia: bez treści użytkownika i odpowiedzi modelu (D8-23); ostrzeżenia
 * walidatora trafiają do logu jako kody + ścieżki STRUKTURALNE (nazwy pól kontraktu, indeksy),
 * a nazwa pola spoza kontraktu jest zastępowana znakiem `?`.
 */
import crypto from "node:crypto";
import mongoose from "mongoose";
import Action from "../models/Action.js";
import Position from "../models/Position.js";
import User from "../models/User.js";
import { getAiConfig } from "../config/aiConfig.js";
import { hasValidAiConsent } from "../utils/aiConsent.js";
import {
  BACKEND_OWNED_FIELDS,
  DERIVED_FIELDS,
  validateAiResponse as defaultValidate,
} from "../utils/validateAiResponse.js";
import {
  aiInputBuilder,
  prepareAiRequest as defaultPrepare,
  withModelVersion as defaultWithModelVersion,
} from "./aiInputBuilder.js";
import { generateStructured as defaultSend } from "./geminiClient.js";
import { aiSafeguards } from "./aiSafeguards.js";
import {
  aiUsageLogger,
  measureFieldLengths,
  measureOutputChars,
  uniqueCodes,
} from "./aiUsageLogger.js";

/** Rodzaj błędu klienta (6.14) → powód `failed` (plan 6.3 / 8.8). JEDNO miejsce tej tabeli. */
export const ERROR_KIND_TO_FAILED_REASON = Object.freeze({
  unavailable: "provider_unavailable",
  rate_limited: "provider_rate_limited",
  timeout: "timeout",
  config: "provider_config_error",
  blocked: "blocked_by_provider",
  truncated: "truncated_output",
  bad_output: "invalid_response",
});

/** Powody z `buildModelInput` → powód `failed` po udanej rezerwacji. */
export const BUILDER_REASON_TO_FAILED_REASON = Object.freeze({
  market_data_unavailable: "market_data_unavailable",
  position_not_found: "internal_error",
  action_not_found: "internal_error",
  no_actions: "internal_error",
});

/** Maks. liczba wywołań modelu w jednym uruchomieniu: pierwsze + jedno po odrzuceniu (6.8). */
export const MAX_MODEL_CALLS = 2;

/**
 * Łączny limit czasu quick-checka (żądanie HTTP czeka na wynik) — wartość przyjęta dla
 * prototypu (plan mówi tylko „mniejszy niż dla pełnej analizy”, 6.8); do ponownej oceny
 * po pomiarach na prawdziwych danych.
 */
export const QUICK_CHECK_TOTAL_TIMEOUT_MS = 45_000;
/** Minimalny zapas, aby w ogóle rozpocząć wywołanie modelu. */
export const QUICK_CHECK_MIN_CALL_MS = 1_000;
/** Nie zaczynamy ponowienia quick-checka, gdy do końca limitu zostało mniej niż to. */
export const QUICK_CHECK_MIN_RETRY_MS = 5_000;
/**
 * Limit 45 s dotyczy przygotowania danych i odpowiedzi modelu. Zapłaconą, poprawną odpowiedź
 * zapisujemy jeszcze w osobnym, krótkim budżecie (liczonym od startu zapisu), który nie jest
 * odejmowany od 45 s. Zapis rozpoczynamy tylko przed upływem limitu. Przy wolnej bazie
 * odpowiedź może więc wrócić o kilka sekund później niż po 45 s (wartość przyjęta dla prototypu).
 */
export const QUICK_CHECK_SAVE_BUDGET_MS = 3_000;
/** Bezpiecznik po stronie aplikacji ponad `maxTimeMS` zapisu (zerwane połączenie z bazą). */
export const QUICK_CHECK_SAVE_SLACK_MS = 1_000;
/**
 * Najdłużej trzymamy blokadę „quick-check w toku” po tym, jak przestaliśmy czekać na
 * operację, która jeszcze trwa (zabezpieczenie na wypadek operacji, która nigdy się nie kończy).
 */
export const QUICK_CHECK_LOCK_MAX_HOLD_MS = 60_000;
/** Kody w `errorCodes` dziennika: odróżniają limit aplikacji od limitu dostawcy (outcome: timeout). */
export const USAGE_CODE_DEADLINE = "deadline_exceeded";
export const USAGE_CODE_SAVE_TIMEOUT = "save_timeout";
export const USAGE_CODE_WRITE_UNCONFIRMED = "write_unconfirmed";

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

const defaultLoadUser = (userId) =>
  User.findById(userId)
    .select("emailVerifiedAt disclaimerAcceptedAt disclaimerVersion")
    .lean();

const isId = (value) =>
  (typeof value === "string" || value instanceof mongoose.Types.ObjectId) &&
  mongoose.isValidObjectId(value);

/* ------------------------------------------------------------------ *
 * Ostrzeżenia walidatora (8.9.3): bezpieczne ścieżki
 * ------------------------------------------------------------------ */

// Nazwy pól kontraktu pełnej analizy i quick-checka oraz pola backendu/wyliczane
// (te ostatnie to stała lista z walidatora) — tylko takie segmenty ścieżki są jawne.
const KNOWN_PATH_SEGMENTS = new Set([
  "summary",
  "observedPatterns",
  "possibleBiases",
  "alternativeExplanations",
  "limitations",
  "outcomeNote",
  "bias",
  "confidence",
  "supportingEvidence",
  "contradictingEvidence",
  ...BACKEND_OWNED_FIELDS,
  ...DERIVED_FIELDS,
]);

/**
 * Ścieżka ostrzeżenia/błędu walidatora → ścieżka bez treści. Segment spoza listy
 * (np. nazwa pola wymyślona przez model, który walidator usunął jako
 * `unknown_field_removed`) zamieniamy na `?`; indeksy `[n]` zostają.
 */
export function safeWarningPath(path) {
  if (typeof path !== "string" || path.length > 200) return "?";
  if (path === "$") return "$";
  return path
    .split(".")
    .map((segment) => {
      const match = /^([^[\]]*)((?:\[\d{1,4}\])*)$/.exec(segment);
      if (!match) return "?";
      const [, name, indexes] = match;
      return `${KNOWN_PATH_SEGMENTS.has(name) ? name : "?"}${indexes}`;
    })
    .join(".");
}

/** Lista {path, code} bez komunikatów (komunikaty walidatora mogą zawierać nazwy z odpowiedzi). */
export function describeIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .filter((i) => i && typeof i.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(i.code))
    .slice(0, 50)
    .map((i) => ({ code: i.code, path: safeWarningPath(i.path) }));
}

/* ------------------------------------------------------------------ *
 * Walidacja dokumentu quick-checka przed zapisem (jak validateAnalysisEntry w 8.6)
 * ------------------------------------------------------------------ */

/**
 * Sprawdza `earlyAiCheck` schematem Mongoose BEZ zapisu do bazy. Zapis przez
 * `findOneAndUpdate` nie uruchamia walidatorów schematu, więc bez tego kroku
 * niepoprawny dokument mógłby trafić do bazy.
 */
export async function validateEarlyAiCheckEntry(entry) {
  try {
    const probe = new Action();
    probe.earlyAiCheck = entry;
    await probe.validate(["earlyAiCheck"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, paths: error?.errors ? Object.keys(error.errors) : [] };
  }
}

/* ------------------------------------------------------------------ *
 * Fabryka
 * ------------------------------------------------------------------ */

/**
 * Wszystkie zależności są wstrzykiwalne (testy bez sieci, zegara i bazy).
 */
export function createAiOrchestrator({
  buildModelInput = (args) => aiInputBuilder.buildModelInput(args),
  prepareAiRequest = defaultPrepare,
  withModelVersion = defaultWithModelVersion,
  send = defaultSend,
  validate = defaultValidate,
  usageLogger = aiUsageLogger,
  safeguards = aiSafeguards,
  getConfig = getAiConfig,
  loadUser = defaultLoadUser,
  PositionModel = Position,
  ActionModel = Action,
  now = () => Date.now(),
  generateRunId = () => crypto.randomUUID(),
  log = defaultLog,
  quickCheckTimeoutMs = QUICK_CHECK_TOTAL_TIMEOUT_MS,
  saveBudgetMs = QUICK_CHECK_SAVE_BUDGET_MS,
  saveSlackMs = QUICK_CHECK_SAVE_SLACK_MS,
  lockMaxHoldMs = QUICK_CHECK_LOCK_MAX_HOLD_MS,
} = {}) {
  const safeLog = (event, fields) => {
    try {
      log(event, fields);
    } catch {
      /* log nigdy nie przerywa pracy */
    }
  };

  /**
   * Czy wolno wysłać dane do modelu TERAZ: wyłącznik / konfiguracja / pauza, potem zgoda.
   * Powody są wartościami `SKIPPED_REASONS`. Wywoływane tuż przed wysłaniem (dane były
   * składane dłuższą chwilę, a stan mógł się zmienić) — dane do Google bez zgody nie wychodzą.
   */
  async function checkConditions(userId) {
    const can = safeguards.canStartAnalysis();
    if (!can.ok) return { ok: false, reason: can.reason };
    const user = await loadUser(userId);
    if (!hasValidAiConsent(user, getConfig().consentVersion)) {
      return { ok: false, reason: "consent_missing" };
    }
    // Odczyt użytkownika trwał: w tym czasie inne żądanie mogło dostać 429 i włączyć pauzę
    // (albo ktoś wyłączył AI). Pauzę i wyłącznik sprawdzamy więc jeszcze raz, już po
    // ostatnim oczekiwaniu — to ma być NAJPÓŹNIEJSZA kontrola przed wysłaniem danych.
    const stillCan = safeguards.canStartAnalysis();
    if (!stillCan.ok) return { ok: false, reason: stillCan.reason };
    return { ok: true };
  }

  /**
   * Oczekiwanie ograniczone deadline quick-checka. Promise.race nie anuluje operacji
   * bazowej: gdy przestajemy czekać, operacja może jeszcze trwać. Taką operację wpisujemy do
   * `pending`, a blokada quick-checka jest zwalniana dopiero po jej zakończeniu
   * (`releaseQuickCheckLock`). Wynik modelu po terminie jest zawsze odrzucany. W testach
   * kontrolowany zegar pozwala sprawdzić granicę bez czekania.
   */
  async function awaitBeforeDeadline(operation, deadlineMs, pending = null) {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) return { timedOut: true };

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
    });
    const running = Promise.resolve().then(operation);
    try {
      const result = await Promise.race([
        running.then((value) => ({ timedOut: false, value })),
        timeout,
      ]);
      if (result.timedOut) {
        trackPending(pending, running);
        return { timedOut: true };
      }
      // Operacja zdążyła się zakończyć, ale po terminie: wynik oddajemy wywołującemu tylko po
      // to, by mógł zapisać realne zużycie (np. tokeny); nie wolno go użyć jako odpowiedzi.
      if (now() >= deadlineMs) return { timedOut: true, completed: true, value: result.value };
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Zapamiętuje operację, na którą już nie czekamy (jej błąd jest tu połknięty). */
  function trackPending(pending, operation) {
    if (!pending) return;
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    settled.then(() => pending.delete(settled));
  }

  /**
   * Zwalnia blokadę „quick-check w toku”. Gdy jakaś rozpoczęta operacja jeszcze trwa
   * (czekanie przerwał termin), blokada zostaje do jej końca, żeby nie dopuścić drugiego,
   * równoległego wywołania modelu dla tej samej akcji. Zabezpieczenie: po `lockMaxHoldMs`
   * blokada jest zwalniana mimo wszystko. Zwolnienie jest jednorazowe, więc spóźniony
   * licznik nie zwolni blokady, którą w międzyczasie zajęło nowsze uruchomienie.
   */
  function releaseQuickCheckLock(lockKey, pending) {
    if (pending.size === 0) {
      safeguards.endQuickCheck(lockKey);
      return;
    }
    let released = false;
    let timer = null;
    const release = (forced) => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      if (forced) safeLog("quick_check_lock_force_released", { holdMs: lockMaxHoldMs });
      safeguards.endQuickCheck(lockKey);
    };
    timer = setTimeout(() => release(true), lockMaxHoldMs);
    timer.unref?.();
    safeLog("quick_check_lock_held", { pendingOperations: pending.size });
    Promise.allSettled([...pending]).then(() => release(false));
  }

  /**
   * Opis prób do dziennika. Klient zwraca `attempts[]`; atrapa bez tego pola dostaje
   * jedną próbę wyliczoną z wyniku. Pusta tablica przy błędzie = klient nie wysłał żądania
   * (np. brak klucza) — nie było próby, więc nie ma rekordu.
   */
  function describeAttempts(result, startedMs, endedMs) {
    if (Array.isArray(result?.attempts)) {
      if (result.attempts.length === 0 && result.ok !== true) return [];
      if (result.attempts.length > 0) {
        let offset = 0;
        return result.attempts.map((a) => {
          const entry = {
            ...a,
            startedAt: startedMs + offset,
          };
          offset += Number.isFinite(a?.durationMs) ? a.durationMs : 0;
          return entry;
        });
      }
    }
    // Atrapa bez `attempts` (lub „sukces” bez prób): jedna próba z całego wywołania.
    const ok = result?.ok === true;
    return [
      {
        attempt: 1,
        ok,
        errorKind: ok ? null : (result?.error?.kind ?? null),
        httpStatus: ok ? null : (result?.error?.httpStatus ?? null),
        providerCode: ok ? null : (result?.error?.providerCode ?? null),
        durationMs: Math.max(0, endedMs - startedMs),
        usage: result?.usage ?? {},
        finishReason: result?.finishReason ?? "other",
        startedAt: startedMs,
      },
    ];
  }

  /**
   * Wspólny rdzeń: wywołanie modelu + walidacja + najwyżej jedno ponowienie.
   * Zapisuje do dziennika każdą próbę OPRÓCZ ostatniej udanej i zwalidowanej (jej wynik
   * zależy jeszcze od zapisu — robi to wywołujący przez `finalAttempt.record(outcome)`).
   *
   * `modelCalled` mówi, czy model został wywołany choć raz (licznik rośnie tuż przed `send()`).
   * `conditionsChanged` = powód (SKIPPED_REASONS), gdy warunki przestały być spełnione dopiero
   * przed PONOWIENIEM: model był już wywołany, więc to nie jest `skipped`, tylko niepowodzenie
   * z powodem poprzedniej odpowiedzi w `reason`.
   *
   * @returns {Promise<
   *   {ok:true, value, warnings, result, finalAttempt:{record:Function}} |
   *   {ok:false, reason:string, modelCalled:boolean, skipped?:true, conditionsChanged?:string}
   * >}
   */
  async function callAndValidate({
    kind,
    recorder,
    request,
    limitsFor,
    deadlineMs = null,
    beforeSend = null,
    canRetryExtra = () => true,
    pending = null,
  }) {
    let modelCalls = 0;
    // Powód niepowodzenia ostatniej odpowiedzi, na wypadek zatrzymania przed ponowieniem.
    let previousReason = "invalid_response";

    const stop = (fields) => ({ ok: false, modelCalled: modelCalls > 0, ...fields });

    // Dziennik zużycia ma własny, stały budżet czasu (domyślnie 5 s w loggerze) —
    // niezależny od 45 s quick-checka, bo to licznik kosztów zapłaconych wywołań.
    const record = (entry, extra = {}) => recorder.record(entry, extra);

    for (;;) {
      // Nie uruchamiamy żądania po deadline ani wtedy, gdy nie ma rozsądnego zapasu.
      if (
        deadlineMs !== null &&
        deadlineMs - now() < QUICK_CHECK_MIN_CALL_MS
      ) {
        return stop({ reason: "timeout" });
      }

      // Warunki sprawdzamy tuż przed KAŻDYM wywołaniem, również po ponowieniu.
      if (beforeSend) {
        let conditions;
        try {
          if (deadlineMs === null) {
            conditions = await beforeSend();
          } else {
            // Odczyt użytkownika (zgoda) też podlega limitowi quick-checka. Po terminie nie
            // wysyłamy danych do modelu; blokada czeka na zakończenie trwającego odczytu.
            const checked = await awaitBeforeDeadline(beforeSend, deadlineMs, pending);
            if (checked.timedOut) {
              safeLog("quick_check_deadline_exceeded", { phase: "preparation", step: "pre_send" });
              return stop({ reason: "timeout" });
            }
            conditions = checked.value;
          }
        } catch (error) {
          safeLog("pre_send_check_exception", {
            kind,
            name: error?.name ?? "Error",
          });
          return stop({ reason: "internal_error" });
        }
        if (!conditions?.ok) {
          const changed = conditions?.reason ?? "internal_error";
          if (modelCalls > 0) {
            // Model był już wywołany: nie wolno udawać, że analiza została pominięta.
            safeLog("conditions_changed_after_model_call", { kind, reason: changed });
            return stop({ reason: previousReason, conditionsChanged: changed });
          }
          return stop({ reason: changed, skipped: true });
        }
      }

      const startedMs = now();
      const remainingMs = deadlineMs === null ? null : deadlineMs - startedMs;
      if (remainingMs !== null && remainingMs < QUICK_CHECK_MIN_CALL_MS) {
        return stop({ reason: "timeout" });
      }

      let limits;
      try {
        limits = limitsFor(startedMs, remainingMs);
      } catch (error) {
        safeLog("model_limits_exception", {
          kind,
          name: error?.name ?? "Error",
        });
        return stop({ reason: "internal_error" });
      }

      // Ostatnia kontrola po wszystkich przygotowaniach, bez asynchronicznego kroku przed send().
      if (deadlineMs !== null && deadlineMs - now() < QUICK_CHECK_MIN_CALL_MS) {
        return stop({ reason: "timeout" });
      }

      // Licznik rośnie dokładnie raz, tuż przed rzeczywistym wysłaniem (limit z planu 6.8).
      modelCalls += 1;

      let result;
      try {
        if (deadlineMs === null) {
          result = await send({ ...request, limits });
        } else {
          const bounded = await awaitBeforeDeadline(
            () => send({ ...request, limits }),
            deadlineMs,
            pending,
          );
          if (bounded.timedOut && !bounded.completed) {
            // Przestaliśmy czekać, a wywołanie jeszcze trwa: jego zużycia nie znamy (tokeny
            // zostają `null`), a blokada czeka na jego koniec (`pending`).
            const endedMs = now();
            safeLog("quick_check_deadline_exceeded", { phase: "model" });
            await record(
              { ok: false, errorKind: "timeout", durationMs: Math.max(0, endedMs - startedMs) },
              { startedAt: startedMs, outcome: "timeout", errorCodes: [USAGE_CODE_DEADLINE] },
            );
            return stop({ reason: "timeout" });
          }
          result = bounded.value;
        }
      } catch (error) {
        // Błąd argumentów (TypeError z klienta) lub nieprzewidziany wyjątek.
        const endedMs = now();
        safeLog("model_call_exception", {
          kind,
          name: error?.name ?? "Error",
        });
        if (deadlineMs !== null && endedMs >= deadlineMs) {
          await record(
            { ok: false, errorKind: "timeout", durationMs: endedMs - startedMs },
            { startedAt: startedMs, outcome: "timeout", errorCodes: [USAGE_CODE_DEADLINE] },
          );
          return stop({ reason: "timeout" });
        }
        return stop({ reason: "internal_error" });
      }
      const endedMs = now();
      const attempts = describeAttempts(result, startedMs, endedMs);

      // Klient ma własne timeouty, ale opóźnienie pętli/serializacji również nie może
      // pozwolić zapisać odpowiedzi, która dotarła po łącznym limicie quick-checka.
      // Tokeny zostają w dzienniku; `outcome: timeout` + kod `deadline_exceeded` oznacza
      // „odpowiedź nieużyta z powodu limitu aplikacji”, a nie timeout dostawcy.
      if (deadlineMs !== null && endedMs >= deadlineMs) {
        safeLog("quick_check_deadline_exceeded", { phase: "model" });
        for (const [index, entry] of attempts.entries()) {
          await record(entry, {
            startedAt: entry.startedAt,
            ...(index === attempts.length - 1
              ? { outcome: "timeout", errorCodes: [USAGE_CODE_DEADLINE] }
              : {}),
          });
        }
        return stop({ reason: "timeout" });
      }

      if (!result || result.ok !== true) {
        for (const entry of attempts) {
          await record(entry, { startedAt: entry.startedAt });
        }
        const errorKind = result?.error?.kind;
        if (errorKind === "rate_limited") {
          const pause = safeguards.reportRateLimited();
          safeLog("rate_limited_pause", {
            level: pause.level,
            durationMs: pause.durationMs,
            extended: pause.extended,
          });
        }
        const reason = ERROR_KIND_TO_FAILED_REASON[errorKind] ?? "internal_error";

        // Nie-JSON / puste (`bad_output`) → najwyżej jedno ponowienie (6.8).
        if (
          errorKind === "bad_output" &&
          modelCalls < MAX_MODEL_CALLS &&
          safeguards.canStartAnalysis().ok &&
          canRetryExtra(endedMs)
        ) {
          safeLog("model_retry_after_bad_output", { kind });
          continue;
        }
        return stop({ reason });
      }

      // Udane wywołanie HTTP: zeruje licznik kolejnych pauz (niezależnie od walidatora).
      safeguards.reportSuccess();

      const last = attempts[attempts.length - 1];
      for (const entry of attempts.slice(0, -1)) {
        await record(entry, { startedAt: entry.startedAt });
      }

      let validation;
      try {
        validation = validate(result.value, { kind });
      } catch (error) {
        const pastDeadline = deadlineMs !== null && now() >= deadlineMs;
        await record(last, {
          startedAt: last.startedAt,
          outcome: pastDeadline ? "timeout" : "invalid_response",
          modelVersion: result.modelVersion,
          ...(pastDeadline ? { errorCodes: [USAGE_CODE_DEADLINE] } : {}),
        });
        if (pastDeadline) {
          safeLog("quick_check_deadline_exceeded", { phase: "model" });
          return stop({ reason: "timeout" });
        }
        safeLog("validator_exception", { kind, name: error?.name ?? "Error" });
        return stop({ reason: "internal_error" });
      }

      if (deadlineMs !== null && now() >= deadlineMs) {
        safeLog("quick_check_deadline_exceeded", { phase: "model" });
        await record(last, {
          startedAt: last.startedAt,
          outcome: "timeout",
          modelVersion: result.modelVersion,
          errorCodes: [USAGE_CODE_DEADLINE],
        });
        return stop({ reason: "timeout" });
      }

      if (!validation?.ok) {
        const issues = describeIssues(validation?.errors);
        await record(last, {
          startedAt: last.startedAt,
          outcome: "invalid_response",
          modelVersion: result.modelVersion,
          errorCodes: uniqueCodes(issues),
        });
        safeLog("validator_rejected", { kind, errors: issues });

        if (
          modelCalls < MAX_MODEL_CALLS &&
          safeguards.canStartAnalysis().ok &&
          canRetryExtra(endedMs)
        ) {
          safeLog("model_retry_after_validator", { kind });
          continue;
        }
        return stop({ reason: "invalid_response" });
      }

      const warnings = Array.isArray(validation.warnings)
        ? validation.warnings
        : [];
      const warningList = describeIssues(warnings);
      if (warningList.length > 0) {
        safeLog("validator_warnings", { kind, warnings: warningList });
      }

      return {
        ok: true,
        value: validation.value,
        warnings: warningList,
        result,
        finalAttempt: {
          /**
           * Dopisuje rekord ostatniej próby z wynikiem po zapisie (`success`/`write_rejected`/
           * `timeout`); `errorCodes` pozwala odróżnić limit aplikacji od limitu dostawcy.
           */
          record: (outcome, { errorCodes } = {}) =>
            record(last, {
              startedAt: last.startedAt,
              outcome,
              modelVersion: result.modelVersion,
              warningCodes: uniqueCodes(warningList),
              ...(errorCodes ? { errorCodes } : {}),
              outputChars: measureOutputChars(result.value),
              maxFieldLengths: measureFieldLengths(kind, validation.value),
            }),
        },
      };
    }
  }

  /** Migawka z wersją modelu i parametrami generowania faktycznie użytymi w żądaniu. */
  function finalizeSnapshot(snapshot, result) {
    const copy = withModelVersion(snapshot, result.modelVersion);
    copy.meta.requestSettings =
      result.requestSettings === null || result.requestSettings === undefined
        ? null
        : structuredClone(result.requestSettings);
    return copy;
  }

  /* ---------------------------------------------------------------- 8.9.2 */

  /**
   * EXECUTOR pełnej analizy dla `aiAnalysisService.setExecutor()`.
   * Nigdy nie rzuca; każde uruchomienie kończy się jednym z: success / failed / skipped.
   *
   * @param {{runId:string, positionId:string, userId:string, analysisType:"interim"|"final",
   *          startedAt:Date, trigger:string}} run
   * @param {{finishSuccess:Function, finishFailed:Function, finishSkipped:Function}} controls
   * @returns {Promise<{status:"success"|"failed"|"skipped", reason?:string}>}
   */
  async function executeFullAnalysis(run, controls) {
    const fail = async (reason) => {
      try {
        await controls.finishFailed(reason);
      } catch (error) {
        safeLog("finish_failed_error", {
          runId: run.runId,
          name: error?.name ?? "Error",
        });
      }
      return { status: "failed", reason };
    };

    try {
      const config = getConfig();

      // 1. Dane wejściowe (8.7). Dane rynkowe są składane przed wywołaniem modelu.
      const built = await buildModelInput({
        positionId: run.positionId,
        userId: run.userId,
        kind: "full",
      });
      if (!built.ok) {
        const reason =
          BUILDER_REASON_TO_FAILED_REASON[built.reason] ?? "internal_error";
        safeLog("input_unavailable", {
          runId: run.runId,
          builderReason: built.reason,
        });
        return await fail(reason);
      }

      const prepared = prepareAiRequest({
        kind: "full",
        built,
        requestedModel: config.model,
        now: new Date(now()),
      });

      // 2. Model + walidator (jedno ponowienie), dziennik zużycia. Warunki (wyłącznik, pauza,
      //    zgoda) sprawdza `beforeSend` tuż przed KAŻDYM wywołaniem — osobne, wcześniejsze
      //    sprawdzenie byłoby tylko drugim odczytem użytkownika bez żadnej pracy pomiędzy.
      const recorder = usageLogger.forRun({
        runId: run.runId,
        kind: "full",
        trigger: run.trigger,
        userId: run.userId,
        positionId: run.positionId,
        requestedModel: config.model,
        promptVersion: prepared.request.promptVersion,
        inputChars: prepared.request.userContent.length,
      });

      const outcome = await callAndValidate({
        kind: "full",
        recorder,
        request: prepared.request,
        limitsFor: () => ({ timeoutMs: config.requestTimeoutMs }),
        beforeSend: () => checkConditions(run.userId),
      });
      if (!outcome.ok) {
        // `skipped` tylko wtedy, gdy model nie został wywołany; po wywołaniu (zgoda wycofana
        // przed ponowieniem) wynik to `failed` z powodem poprzedniej odpowiedzi.
        if (outcome.skipped && !outcome.modelCalled) {
          safeLog("conditions_changed", { runId: run.runId, reason: outcome.reason });
          try {
            await controls.finishSkipped(outcome.reason);
          } catch (error) {
            safeLog("finish_skipped_error", {
              runId: run.runId,
              name: error?.name ?? "Error",
            });
          }
          return { status: "skipped", reason: outcome.reason };
        }
        return await fail(outcome.reason);
      }

      // 3. Pola backendu + zapis (8.6.2). Tylko zwalidowana odpowiedź.
      const { result } = outcome;
      const analysis = {
        ...outcome.value,
        analyzedAt: new Date(now()),
        analysisType: run.analysisType,
        // Interactions nie zwraca osobnej wersji; schemat wymaga pola, więc przy braku
        // wersji zapisujemy nazwę zleconego modelu (w `meta.modelVersion` zostaje null).
        aiModelVersion: result.modelVersion ?? config.model,
        promptVersion: prepared.request.promptVersion,
        inputSnapshot: finalizeSnapshot(prepared.snapshot, result),
      };

      let written = { ok: false };
      let status = { status: "failed", reason: "internal_error" };
      try {
        written = (await controls.finishSuccess(analysis)) ?? { ok: false };
        status = written.ok
          ? { status: "success" }
          : { status: "failed", reason: written.reason ?? "write_rejected" };
      } catch (error) {
        safeLog("finish_success_error", {
          runId: run.runId,
          name: error?.name ?? "Error",
        });
        try {
          await controls.finishFailed("internal_error");
        } catch {
          /* bezpiecznik w serwisie zamknie pending */
        }
      } finally {
        await outcome.finalAttempt.record(
          written.ok ? "success" : "write_rejected",
        );
      }
      return status;
    } catch (error) {
      safeLog("orchestrator_error", {
        runId: run.runId,
        name: error?.name ?? "Error",
      });
      return await fail("internal_error");
    }
  }

  /* ---------------------------------------------------------------- 8.9.4 */

  /**
   * Quick-check jednej akcji (synchroniczny; D8-20, plan 6.5). Nie rzuca — wynik jest obiektem:
   *   {ok:true, analysisRunId, earlyAiCheck, warnings}
   *   {ok:false, kind:"not_found"}                         → 404 (też cudza pozycja/akcja, usunięta pozycja)
   *   {ok:false, kind:"busy"}                              → 409 analysis_in_progress
   *   {ok:false, kind:"unavailable", reason}               → 503 ai_disabled | ai_paused | ai_not_configured
   *   {ok:false, kind:"consent_missing"}                   → 403 consent_required
   *   {ok:false, kind:"market_data_unavailable"}           → 503 market_data_unavailable (bez zapisu)
   *   {ok:false, kind:"model_failed", reason}              → reason z FAILED_REASONS (kod HTTP: 8.10);
   *                                                          także limit czasu PO wywołaniu modelu
   *   {ok:false, kind:"timeout", phase}                    → limit czasu poza modelem (kod HTTP: 8.10):
   *                                                          phase "preparation" = przed wywołaniem modelu
   *                                                          (kontrola, własność, dane); model niewywołany.
   *                                                          phase "save" = zapis wyniku nie zdążył; z
   *                                                          `writeUnconfirmed:true`, gdy aplikacja przestała
   *                                                          czekać, a bazy nie zapytano o wynik (zapis mógł
   *                                                          się udać)
   *   {ok:false, kind:"write_rejected"}                    → zapis odrzucony (nowszy wynik / akcja zmieniona)
   *   {ok:false, kind:"internal_error"}                    → 500; z `writeUnconfirmed:true`, gdy wyjątek
   *                                                          wystąpił po wysłaniu aktualizacji (zapis mógł
   *                                                          się udać)
   * Kody HTTP przypisuje warstwa 8.10 — tu ich nie ma (granica zakresu).
   *
   * ── Czas ──
   * 45 s (QUICK_CHECK_TOTAL_TIMEOUT_MS) obejmuje przygotowanie danych i odpowiedź modelu.
   * Zapis wyniku, rozpoczęty przed końcem tego limitu, dostaje własny krótki budżet
   * (`saveBudgetMs`); zapis dziennika zużycia — własny budżet loggera. Całe żądanie może więc
   * w wyjątkowych sytuacjach (wolna baza) potrwać o kilka sekund dłużej niż 45 s. Zapis, który
   * baza potwierdziła, jest zawsze sukcesem — także gdy potwierdzenie przyszło po terminie.
   */
  async function runQuickCheck({ userId, positionId, actionId, trigger = "manual" }) {
    if (!isId(userId) || !isId(positionId) || !isId(actionId)) {
      return { ok: false, kind: "not_found" };
    }

    let lockKey = null;
    const deadlineMs = now() + quickCheckTimeoutMs;
    // Operacje, na które przestaliśmy czekać, a które jeszcze trwają (blokada czeka na nie).
    const pending = new Set();
    const preparationTimeout = (step) => {
      safeLog("quick_check_deadline_exceeded", { phase: "preparation", step });
      return { ok: false, kind: "timeout", phase: "preparation" };
    };

    try {
      // Limit obejmuje także kontrolę zgody, sprawdzenie własności i budowę danych.
      const initialConditions = await awaitBeforeDeadline(
        () => checkConditions(userId),
        deadlineMs,
        pending,
      );
      if (initialConditions.timedOut) return preparationTimeout("conditions");
      // Warunki: wyłącznik / konfiguracja / pauza, potem zgoda. Tanie odrzucenie na starcie;
      // ostatnią kontrolę przed wysłaniem robi `beforeSend` w `callAndValidate`.
      const conditions = initialConditions.value;
      if (!conditions.ok) {
        return conditions.reason === "consent_missing"
          ? { ok: false, kind: "consent_missing" }
          : { ok: false, kind: "unavailable", reason: conditions.reason };
      }

      // Parent-Child Guard {_id, positionId, userId} i stan pozycji — przed blokadą,
      // żeby cudzy identyfikator dawał 404, a nie 409.
      const ownedResult = await awaitBeforeDeadline(
        () => ownedActionExists({ userId, positionId, actionId }),
        deadlineMs,
        pending,
      );
      if (ownedResult.timedOut) return preparationTimeout("ownership");
      if (!ownedResult.value) return { ok: false, kind: "not_found" };

      // Mapa „w toku”: jeden quick-check naraz dla tej akcji tego użytkownika.
      lockKey = `${userId}:${actionId}`;
      if (!safeguards.tryBeginQuickCheck(lockKey)) {
        lockKey = null;
        return { ok: false, kind: "busy" };
      }

      const runId = generateRunId();
      const startedMs = now();
      if (startedMs >= deadlineMs) return preparationTimeout("start");
      const runStartedAt = new Date(startedMs);
      const config = getConfig();

      // Dane TYLKO do tej akcji (wcześniejsze akcje jako kontekst, bez późniejszych).
      const builtResult = await awaitBeforeDeadline(
        () => buildModelInput({
          positionId,
          userId,
          kind: "quickCheck",
          actionId,
        }),
        deadlineMs,
        pending,
      );
      if (builtResult.timedOut) return preparationTimeout("input");
      const built = builtResult.value;
      if (!built.ok) {
        if (built.reason === "market_data_unavailable") {
          safeLog("input_unavailable", { runId, builderReason: built.reason });
          return { ok: false, kind: "market_data_unavailable" };
        }
        return { ok: false, kind: "not_found" };
      }

      const prepared = prepareAiRequest({
        kind: "quickCheck",
        built,
        requestedModel: config.model,
        now: runStartedAt,
      });

      const recorder = usageLogger.forRun({
        runId,
        kind: "quickCheck",
        trigger,
        userId,
        positionId,
        actionId,
        requestedModel: config.model,
        promptVersion: prepared.request.promptVersion,
        inputChars: prepared.request.userContent.length,
      });

      // Warunki (wyłącznik, pauza, zgoda) są sprawdzane w `beforeSend` tuż przed każdym
      // wywołaniem modelu; dane składały się dłuższą chwilę, więc to jest ta „druga” kontrola.
      const outcome = await callAndValidate({
        kind: "quickCheck",
        recorder,
        request: prepared.request,
        deadlineMs,
        pending,
        beforeSend: () => checkConditions(userId),
        limitsFor: (_callStartedMs, remainingMs) => ({
          timeoutMs: Math.min(config.requestTimeoutMs, remainingMs),
          totalTimeoutMs: remainingMs,
        }),
        canRetryExtra: (endedMs) =>
          deadlineMs - endedMs >= QUICK_CHECK_MIN_RETRY_MS,
      });
      if (!outcome.ok) {
        const changed = outcome.skipped ? outcome.reason : outcome.conditionsChanged;
        if (changed) {
          // Zgoda/dostępność zmieniły się przed wysłaniem (ponowieniem). Quick-check nie ma
          // zapisanego statusu, więc użytkownik dostaje prawdziwą przyczynę.
          return changed === "consent_missing"
            ? { ok: false, kind: "consent_missing" }
            : { ok: false, kind: "unavailable", reason: changed };
        }
        if (outcome.reason === "timeout" && !outcome.modelCalled) {
          return preparationTimeout("model");
        }
        return { ok: false, kind: "model_failed", reason: outcome.reason };
      }

      // Model ani walidator nie mogą oddać wyniku do zapisu po łącznym deadline.
      if (now() >= deadlineMs) {
        safeLog("quick_check_deadline_exceeded", { phase: "model" });
        await outcome.finalAttempt.record("timeout", { errorCodes: [USAGE_CODE_DEADLINE] });
        return { ok: false, kind: "model_failed", reason: "timeout" };
      }

      const { result } = outcome;
      const earlyAiCheck = {
        analyzedAt: new Date(now()),
        ...outcome.value,
        aiModelVersion: result.modelVersion ?? config.model,
        promptVersion: prepared.request.promptVersion,
        analysisRunId: runId,
        runStartedAt,
        inputSnapshot: finalizeSnapshot(prepared.snapshot, result),
      };

      // Zapis zaczynamy tylko przed końcem limitu (wtedy wynik jest na pewno niezapisany).
      if (now() >= deadlineMs) {
        safeLog("quick_check_deadline_exceeded", { phase: "model" });
        await outcome.finalAttempt.record("timeout", { errorCodes: [USAGE_CODE_DEADLINE] });
        return { ok: false, kind: "model_failed", reason: "timeout" };
      }

      // Trzy różne sytuacje: zapis potwierdzony (`ok`), zapis odrzucony przez warunek lub
      // znane „nic nie zapisano” (wyjątek PRZED aktualizacją), oraz zapis o nieznanym
      // wyniku (`writeUnconfirmed`, wyjątek lub brak odpowiedzi PO wysłaniu aktualizacji).
      let saved = { ok: false, kind: "write_rejected" };
      try {
        saved = await saveEarlyAiCheck({
          userId,
          positionId,
          actionId,
          runId,
          runStartedAt,
          earlyAiCheck,
          pending,
        });
      } finally {
        let usageOutcome = "write_rejected";
        let usageExtra;
        if (saved.ok) {
          usageOutcome = "success";
        } else if (saved.kind === "timeout") {
          usageOutcome = "timeout";
          usageExtra = {
            errorCodes: [
              USAGE_CODE_SAVE_TIMEOUT,
              ...(saved.writeUnconfirmed ? [USAGE_CODE_WRITE_UNCONFIRMED] : []),
            ],
          };
        } else if (saved.writeUnconfirmed) {
          // Enum `outcome` nie ma wartości „nieznany”: `write_rejected` + kod `write_unconfirmed`.
          usageExtra = { errorCodes: [USAGE_CODE_WRITE_UNCONFIRMED] };
        }
        await outcome.finalAttempt.record(usageOutcome, usageExtra);
      }
      if (!saved.ok) return saved;

      // Migawka pozostaje w bazie, ale nie jest wysyłana ponownie do klienta.
      const { inputSnapshot: _omitted, ...publicEntry } = earlyAiCheck;
      return {
        ok: true,
        analysisRunId: runId,
        earlyAiCheck: publicEntry,
        warnings: outcome.warnings,
      };
    } catch (error) {
      safeLog("quick_check_error", { name: error?.name ?? "Error" });
      return { ok: false, kind: "internal_error" };
    } finally {
      if (lockKey) releaseQuickCheckLock(lockKey, pending);
    }
  }

  /** Pozycja właściciela nieusunięta + akcja z `{_id, positionId, userId}` (Parent-Child Guard). */
  async function ownedActionExists({ userId, positionId, actionId }) {
    const position = await PositionModel.findOne({
      _id: positionId,
      userId,
      deletedAt: null,
    })
      .select("_id")
      .lean();
    if (!position) return false;

    const action = await ActionModel.findOne({
      _id: actionId,
      positionId,
      userId,
    })
      .select("_id")
      .lean();
    return Boolean(action);
  }

  /** Błąd MongoDB „przekroczono maxTimeMS” (kod 50): operacja przerwana po stronie bazy. */
  const isMaxTimeExpired = (error) =>
    error?.code === 50 || error?.codeName === "MaxTimeMSExpired";

  /**
   * Zapis `earlyAiCheck` z warunkiem „brak dotychczasowego wyniku albo jego `runStartedAt`
   * starsze niż moje” (plan 6.5). Starsze wpisy sprzed Etapu 8 (bez `runStartedAt`) wolno
   * zastąpić. Stan pozycji sprawdzamy jeszcze raz tuż przed zapisem (usunięta → 404);
   * zostaje krótkie, świadomie akceptowane okno między tym sprawdzeniem a zapisem (6.5).
   *
   * Budżet czasu (`saveBudgetMs`) liczymy od startu zapisu, niezależnie od 45 s quick-checka.
   * Zapis dostaje `maxTimeMS` równe pozostałemu budżetowi; wynik tej operacji jest rozstrzygający:
   *   baza potwierdziła zapis                  → sukces (także po terminie),
   *   baza przerwała z kodem 50 (maxTimeMS)    → timeout, nic nie zapisano,
   *   baza odrzuciła przez warunek             → write_rejected,
   *   zerwane połączenie / inny błąd po wysłaniu → internal_error z `writeUnconfirmed: true`,
   *   wyjątek przed aktualizacją (odczyt)      → wyjątek (nic nie zapisano) → internal_error,
   *   brak jakiejkolwiek odpowiedzi do budżet + zapas → timeout z `writeUnconfirmed: true`.
   * Warunek `runStartedAt` zostaje, więc spóźniony starszy zapis nie nadpisze nowszego.
   */
  async function saveEarlyAiCheck({
    userId,
    positionId,
    actionId,
    runId,
    runStartedAt,
    earlyAiCheck,
    pending = null,
  }) {
    const saveDeadlineMs = now() + saveBudgetMs;
    const remainingMs = () => saveDeadlineMs - now();

    const write = async () => {
      const stillThere = await ownedActionExists({ userId, positionId, actionId });
      if (!stillThere) return { ok: false, kind: "not_found" };

      const check = await validateEarlyAiCheckEntry(earlyAiCheck);
      if (!check.ok) {
        safeLog("invalid_early_check_document", { runId, paths: check.paths });
        return { ok: false, kind: "internal_error" };
      }

      // Nic jeszcze nie wysłano do bazy, więc timeout tutaj jest rozstrzygający.
      const maxTimeMS = Math.floor(remainingMs());
      if (maxTimeMS < 1) {
        safeLog("quick_check_deadline_exceeded", { phase: "save" });
        return { ok: false, kind: "timeout", phase: "save" };
      }

      let doc;
      try {
        doc = await ActionModel.findOneAndUpdate(
          {
            _id: actionId,
            positionId,
            userId,
            $or: [
              { earlyAiCheck: null },
              { "earlyAiCheck.runStartedAt": null },
              { "earlyAiCheck.runStartedAt": { $lt: runStartedAt } },
            ],
          },
          { $set: { earlyAiCheck } },
          { returnDocument: "after", maxTimeMS },
        )
          .select("_id")
          .lean();
      } catch (error) {
        if (isMaxTimeExpired(error)) {
          safeLog("quick_check_deadline_exceeded", { phase: "save" });
          return { ok: false, kind: "timeout", phase: "save" };
        }
        // Wyjątek PO wysłaniu aktualizacji (np. zerwane połączenie): baza mogła zatwierdzić
        // zapis. Nie zgadujemy — wynik jest oznaczony jako nieznany. Wyjątek z wcześniejszego
        // odczytu właściciela tu nie trafia (tam nic jeszcze nie zapisano).
        safeLog("early_check_write_unconfirmed", { runId, name: error?.name ?? "Error" });
        return { ok: false, kind: "internal_error", writeUnconfirmed: true };
      }

      if (!doc) {
        safeLog("write_rejected", { runId, positionId: String(positionId), kind: "quickCheck" });
        return { ok: false, kind: "write_rejected" };
      }
      return { ok: true };
    };

    // Bezpiecznik: baza nie odpowiedziała nawet po maxTimeMS + zapas (zerwane połączenie).
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ unconfirmed: true }),
        saveBudgetMs + saveSlackMs,
      );
    });
    const running = write();
    try {
      const raced = await Promise.race([running.then((value) => ({ value })), guard]);
      if (raced.unconfirmed) {
        trackPending(pending, running);
        safeLog("early_check_write_unconfirmed", { runId, name: "NoResponse" });
        return { ok: false, kind: "timeout", phase: "save", writeUnconfirmed: true };
      }
      return raced.value;
    } finally {
      clearTimeout(timer);
    }
  }

  return { executeFullAnalysis, runQuickCheck, checkConditions };
}

/** Instancja produkcyjna: `aiAnalysisService.setExecutor(aiOrchestrator.executeFullAnalysis)`. */
export const aiOrchestrator = createAiOrchestrator();
