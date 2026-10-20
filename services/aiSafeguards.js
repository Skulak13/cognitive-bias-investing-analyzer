/**
 * Proste zabezpieczenia AI w pamięci jednego procesu (Etap 8.3.2, D8-02/03/05).
 *
 *  - canStartAnalysis(): czy wolno uruchomić analizę (wyłącznik > brak konfiguracji > pauza)
 *  - reportRateLimited() / reportSuccess(): pauza po HTTP 429 (bez zgadywania czasu odnowienia limitu)
 *  - tryBeginQuickCheck()/endQuickCheck()/runExclusiveQuickCheck(): jeden quick-check naraz na klucz
 *
 * Stan jest w pamięci procesu (jedna instancja) — po restarcie znika (plan 6.2.2, R1).
 * Nie ma tu kolejki, rozproszonych blokad ani obsługi wielu procesów.
 * Zegar i konfiguracja są wstrzykiwane, więc testy nie czekają w rzeczywistym czasie.
 */
import { getAiConfig, getAiStatus } from "../config/aiConfig.js";
import { appError } from "../utils/appError.js";

export const REASON_AI_DISABLED = "ai_disabled";
export const REASON_AI_NOT_CONFIGURED = "ai_not_configured";
export const REASON_AI_PAUSED = "ai_paused";

export function createAiSafeguards({
  getConfig = getAiConfig,
  now = () => Date.now(),
} = {}) {
  let pausedUntil = 0; // ms od epoki; 0 = brak pauzy
  let level = 0; // ile kolejnych pauz z rzędu (0 = brak), zerowane po sukcesie
  const quickChecksInFlight = new Set();

  function isPaused() {
    return pausedUntil > now();
  }

  /** Czy wolno wystartować analizę. Kolejność powodów: wyłącznik, konfiguracja, pauza. */
  function canStartAnalysis() {
    const status = getAiStatus(getConfig());
    if (status === "disabled") return { ok: false, reason: REASON_AI_DISABLED };
    if (status === "not_configured") {
      return { ok: false, reason: REASON_AI_NOT_CONFIGURED };
    }
    if (isPaused()) return { ok: false, reason: REASON_AI_PAUSED };
    return { ok: true };
  }

  /**
   * Zgłoszenie HTTP 429 od dostawcy.
   * Pauza rośnie (base · factor^(n-1), maks. pauseMaxMs) tylko wtedy, gdy poprzednia
   * już wygasła. 429 przychodzące w TRAKCIE obowiązującej pauzy (np. od żądania
   * wysłanego jeszcze przed jej początkiem) niczego nie skraca ani nie eskaluje.
   */
  function reportRateLimited() {
    const config = getConfig();
    const t = now();

    if (pausedUntil > t) {
      return {
        pausedUntil,
        durationMs: pausedUntil - t,
        level,
        extended: false,
      };
    }

    level += 1;
    const durationMs = Math.min(
      config.pauseBaseMs * config.pauseFactor ** (level - 1),
      config.pauseMaxMs,
    );
    pausedUntil = Math.max(pausedUntil, t + durationMs);
    return { pausedUntil, durationMs, level, extended: true };
  }

  /**
   * Udane wywołanie zeruje licznik kolejnych pauz. Nie skraca pauzy, która już trwa
   * (przewidywalność: pauza kończy się o ustalonej godzinie).
   */
  function reportSuccess() {
    level = 0;
  }

  function getPauseState() {
    return {
      paused: isPaused(),
      pausedUntil: isPaused() ? pausedUntil : null,
      level,
    };
  }

  /** Rozpoczyna quick-check dla klucza (np. `userId:actionId`); false, gdy już trwa. */
  function tryBeginQuickCheck(key) {
    if (quickChecksInFlight.has(key)) return false;
    quickChecksInFlight.add(key);
    return true;
  }

  function endQuickCheck(key) {
    quickChecksInFlight.delete(key);
  }

  function isQuickCheckRunning(key) {
    return quickChecksInFlight.has(key);
  }

  /** Uruchamia `fn` z blokadą klucza; zwalnia ją po sukcesie i po błędzie. Duplikat → 409. */
  async function runExclusiveQuickCheck(key, fn) {
    if (!tryBeginQuickCheck(key)) {
      throw appError(
        409,
        "Szybka analiza tej akcji już trwa",
        "analysis_in_progress",
      );
    }
    try {
      return await fn();
    } finally {
      endQuickCheck(key);
    }
  }

  /** Czyści cały stan (do testów). */
  function reset() {
    pausedUntil = 0;
    level = 0;
    quickChecksInFlight.clear();
  }

  return {
    canStartAnalysis,
    reportRateLimited,
    reportSuccess,
    getPauseState,
    tryBeginQuickCheck,
    endQuickCheck,
    isQuickCheckRunning,
    runExclusiveQuickCheck,
    reset,
  };
}

/** Instancja produkcyjna (jeden proces). Testy używają createAiSafeguards(). */
export const aiSafeguards = createAiSafeguards();
