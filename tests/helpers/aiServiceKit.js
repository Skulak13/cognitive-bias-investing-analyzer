/**
 * Zestaw pomocniczy do testów serwisu analiz (Etap 8.6): sterowany zegar,
 * konfiguracja, zabezpieczenia, użytkownik ze zgodą i atrapa executora.
 * Żadnych kluczy ani prawdziwych odpowiedzi AI — wszystko syntetyczne.
 */
import { getAiConfig } from "../../config/aiConfig.js";
import { createAiSafeguards } from "../../services/aiSafeguards.js";
import { createAiAnalysisService } from "../../services/aiAnalysisService.js";

export const MINUTE = 60_000;

export function validAnalysis(run, overrides = {}) {
  return {
    analyzedAt: new Date(),
    analysisType: run.analysisType,
    summary: "Podsumowanie testowe",
    aiModelVersion: "test-model",
    promptVersion: "test-prompt",
    ...overrides,
  };
}

export function createKit(
  harness,
  { config = {}, withExecutor = false, batch, model } = {},
) {
  const clock = { t: Date.parse("2026-10-20T12:00:00Z") };
  const cfg = { ...config };
  const state = {
    user: {
      disclaimerAcceptedAt: new Date("2026-10-01T00:00:00Z"),
      disclaimerVersion: "1",
    },
  };
  const events = [];
  let counter = 0;

  const getConfig = () => ({
    ...getAiConfig({ AI_ENABLED: "true", GEMINI_API_KEY: "test-key-not-real" }),
    ...cfg,
  });
  const safeguards = createAiSafeguards({ getConfig, now: () => clock.t });

  const service = createAiAnalysisService({
    PositionModel: model ?? harness.Position,
    loadUser: async () => {
      if (state.onLoadUser) await state.onLoadUser(); // wstrzyknięcie „równoległego” zdarzenia
      return state.user;
    },
    safeguards,
    getConfig,
    now: () => clock.t,
    generateRunId: () => `run-${++counter}`,
    log: (event, fields) => events.push({ event, ...fields }),
    ...(batch ? { recoveryBatchSize: batch } : {}),
  });

  /** Executor-atrapa: zapisuje wywołania; `behavior(run, controls)` decyduje o wyniku. */
  const calls = [];
  const useExecutor = (behavior) => {
    service.setExecutor(async (run, controls) => {
      calls.push(run);
      return behavior
        ? behavior(run, controls)
        : controls.finishSuccess(validAnalysis(run));
    });
  };
  if (withExecutor) useExecutor();

  return {
    clock,
    cfg,
    state,
    events,
    calls,
    safeguards,
    service,
    useExecutor,
    advance: (ms) => {
      clock.t += ms;
    },
    owner: async (id) => String((await harness.get(id)).userId),
  };
}

/** Obietnica, którą rozstrzygamy ręcznie — do wstrzymywania trwającej analizy. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
