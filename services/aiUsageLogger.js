/**
 * Zapis dziennika zużycia AI (Etap 8.9.1, plan 6.9, D8-06, D8-23).
 *
 * Jeden rekord `AiUsageLog` na każdą PRÓBĘ wywołania modelu — także ponowioną
 * wewnątrz klienta (8.8.3) i ponowioną po odrzuceniu odpowiedzi przez walidator
 * (8.9.2). Moduł zna wyłącznie neutralny kształt wyniku klienta (`attempts[]`
 * z `services/geminiClient.js`: {attempt, ok, errorKind, httpStatus, providerCode,
 * durationMs, usage{input,output,reasoning,total}, finishReason, endpointKind}) — nie zna
 * API Google. Rodzaj endpointu (`endpointKind`) podaje klient w opisie próby; logger tylko
 * go zapisuje (po filtrze bezpiecznego kodu), a gdy go brak — zapisuje `null`.
 *
 * ── Zasady ─────────────────────────────────────────────────────────────────────
 *  - BEZ treści: do rekordu i do linii logu trafiają tylko identyfikatory, kody,
 *    liczby i nazwy pól (D8-23). Nigdy uzasadnienia, newsy, tekst odpowiedzi modelu,
 *    klucz API ani e-mail. Długości pól (`maxFieldLengths`) to liczby pod stałymi
 *    nazwami, obliczane z już zwalidowanej odpowiedzi.
 *  - Błąd zapisu dziennika NIGDY nie przerywa analizy ani nie zmienia jej wyniku:
 *    `record()` łapie każdy wyjątek, ogranicza oczekiwanie na bazę i zapisuje w logu
 *    procesu tylko nazwę błędu; problem dziennika zwraca jako `false`. Oczekiwanie jest
 *    ograniczone podwójnie: do 5 s na rekord ORAZ wspólnym budżetem uruchomienia (5 s na
 *    wszystkie jego rekordy łącznie), żeby wolna baza nie wydłużała odpowiedzi wielokrotnie.
 *  - Tokeny są `null`, gdy klient ich nie podał (nie zgadujemy); liczniki muszą być
 *    całkowite (schemat), więc wartość niecałkowita też zamienia się na `null`.
 *  - Jedna linia JSON w logu procesu na próbę (te same pola, bez treści).
 *
 * ── Mapowanie wyniku próby na `outcome` (enumeracja modelu bez zmian) ──────────
 *   ok                                    → success (orkiestrator może nadpisać:
 *                                           invalid_response / write_rejected / timeout)
 *   rate_limited                          → http_error   (httpStatus 429)
 *   timeout                               → timeout
 *   unavailable, brak kodu HTTP           → network_error
 *   unavailable z kodem HTTP, config      → http_error
 *   blocked                               → blocked
 *   truncated                             → truncated_output
 *   bad_output                            → invalid_response
 *
 * `timeout` ma dwa źródła. Bez kodów w `errorCodes` to limit czasu DOSTAWCY (klient).
 * Z kodem `deadline_exceeded` odpowiedź mogła być poprawna i zużyć tokeny, ale quick-check
 * przekroczył własny limit czasu aplikacji i jej nie wykorzystał; kod `save_timeout`
 * (z `write_unconfirmed`, gdy nie wiadomo, czy zapis się udał) oznacza limit zapisu wyniku.
 * `write_rejected` z kodem `write_unconfirmed` = wynik zapisu NIEZNANY (np. zerwane połączenie
 * po wysłaniu aktualizacji); `write_rejected` bez kodu = zapis odrzucony przez warunek.
 * Tokeny zapisujemy zawsze. Statystyki błędów dostawcy liczymy więc bez rekordów z tymi kodami.
 *
 * Czego tu NIE ma: wywołania Gemini, walidacji, zapisu analizy (to orkiestrator).
 * Brak próby = brak rekordu: gdy model nie został wywołany (np. brak danych
 * rynkowych, błąd konfiguracji klienta bez żądania sieciowego), rekordu nie
 * tworzymy — `outcome: "skipped"` w modelu oznacza „zablokowane przed wywołaniem”,
 * a decyzja o osobnym rodzaju dla „brak danych” pozostaje otwarta (plan 8.9.1).
 */
import AiUsageLog, {
  AI_USAGE_KINDS,
  AI_USAGE_OUTCOMES,
  AI_USAGE_TRIGGERS,
} from "../models/AiUsageLog.js";

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

/** Stałe nazwy pól, pod którymi zapisujemy długości (muszą pasować do wzorca modelu). */
export const FIELD_LENGTH_NAMES = Object.freeze({
  full: Object.freeze([
    "summary",
    "limitations",
    "outcomeNote",
    "observedPattern",
    "alternativeExplanation",
    "supportingEvidence",
    "contradictingEvidence",
  ]),
  quickCheck: Object.freeze(["summary", "limitations", "possibleBiasName"]),
});

/** Pojedynczy zapis dziennika nie może bezterminowo blokować analizy. */
export const DEFAULT_WRITE_TIMEOUT_MS = 5_000;
/**
 * WSPÓLNY budżet czasu oczekiwania na zapisy dziennika w jednym uruchomieniu (analiza ma
 * zwykle kilka rekordów: ponowienia klienta + ponowienie po walidatorze). Budżet nie odnawia się
 * przy każdym rekordzie: przy zawieszonej bazie całe uruchomienie czeka na dziennik najwyżej
 * tyle, a rekordy po wyczerpaniu budżetu są pomijane (zapis w logu procesu). Przy sprawnej
 * bazie zapisy trwają milisekundy, więc budżet starcza na wszystkie rekordy.
 */
export const DEFAULT_RUN_WRITE_BUDGET_MS = 5_000;

const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SAFE_PROVIDER_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_MODEL_VERSION = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_CODES = 30;

/** Kody (ostrzeżeń/błędów walidatora): unikalne, krótkie identyfikatory, najwyżej 30. */
export function uniqueCodes(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const code = typeof item === "string" ? item : item?.code;
    if (typeof code !== "string" || !SAFE_CODE.test(code)) continue;
    if (!out.includes(code)) out.push(code);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

const maxLength = (list) =>
  Array.isArray(list)
    ? list.reduce((max, item) => Math.max(max, len(item)), 0)
    : 0;
// Jedna jednostka długości w całej aplikacji: `.length` (jednostki UTF-16) — tak samo liczą
// limity `maxlength` w schematach Mongoose oraz `inputChars` / `outputChars`.
const len = (v) => (typeof v === "string" ? v.length : 0);

/**
 * Długości pól ZWALIDOWANEJ odpowiedzi (wynik `validateAiResponse().value`) pod
 * stałymi nazwami. Dla odpowiedzi niepoprawnej nie wołać — kształt nie jest znany.
 * @returns {Record<string, number>|undefined}
 */
export function measureFieldLengths(kind, value) {
  if (value === null || typeof value !== "object") return undefined;

  if (kind === "full") {
    const biases = Array.isArray(value.possibleBiases) ? value.possibleBiases : [];
    return {
      summary: len(value.summary),
      limitations: len(value.limitations),
      outcomeNote: len(value.outcomeNote),
      observedPattern: maxLength(value.observedPatterns),
      alternativeExplanation: maxLength(value.alternativeExplanations),
      supportingEvidence: biases.reduce(
        (max, b) => Math.max(max, len(b?.supportingEvidence)),
        0,
      ),
      contradictingEvidence: biases.reduce(
        (max, b) => Math.max(max, len(b?.contradictingEvidence)),
        0,
      ),
    };
  }

  if (kind === "quickCheck") {
    return {
      summary: len(value.summary),
      limitations: len(value.limitations),
      possibleBiasName: maxLength(value.possibleBiases),
    };
  }

  return undefined;
}

/** Długość odpowiedzi modelu w znakach (po serializacji zwalidowanego obiektu); bez treści. */
export function measureOutputChars(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text.length : null;
  } catch {
    return null;
  }
}

const intOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Rodzaj uruchomienia z serwisu stanu → wartość `trigger` modelu dziennika. */
export function toUsageTrigger(trigger) {
  if (trigger === "auto") return "auto_after_close";
  return AI_USAGE_TRIGGERS.includes(trigger) ? trigger : "manual";
}

/** Wartość metadanych dostawcy może być kodem — nigdy nie przechowujemy dowolnego tekstu. */
const safeProviderValue = (value) =>
  typeof value === "string" && SAFE_PROVIDER_VALUE.test(value) ? value : null;

const safeModelVersion = (value) =>
  typeof value === "string" && SAFE_MODEL_VERSION.test(value) ? value : null;

/** Do mapy długości trafiają wyłącznie znane nazwy pól oraz liczby nieujemne. */
function safeFieldLengths(kind, value) {
  const allowed = FIELD_LENGTH_NAMES[kind];
  if (!allowed || value === null || typeof value !== "object") return undefined;
  const clean = {};
  for (const name of allowed) {
    if (!Object.hasOwn(value, name)) continue;
    const length = intOrNull(value[name]);
    if (length !== null) clean[name] = length;
  }
  return clean;
}

/** Wynik próby klienta → `outcome` dziennika (tabela w nagłówku modułu). */
export function outcomeForAttempt(entry) {
  if (entry?.ok === true) return "success";
  switch (entry?.errorKind) {
    case "timeout":
      return "timeout";
    case "blocked":
      return "blocked";
    case "truncated":
      return "truncated_output";
    case "bad_output":
      return "invalid_response";
    case "unavailable":
    case "rate_limited":
    case "config":
    default:
      // Brak statusu HTTP nie pozwala stwierdzić, że dostawca zwrócił odpowiedź.
      return entry?.httpStatus == null ? "network_error" : "http_error";
  }
}

/**
 * Tokeny z obu kształtów klienta: znormalizowanego oraz surowego Interactions API.
 * Brak pola, wartość ujemna lub niecałkowita → `null` (nie wyliczamy brakujących sum).
 */
export function mapUsage(usage) {
  const u = usage !== null && typeof usage === "object" ? usage : {};
  const pick = (...names) => {
    for (const name of names) {
      if (u[name] !== undefined && u[name] !== null) return intOrNull(u[name]);
    }
    return null;
  };
  return {
    inputTokens: pick("input", "total_input_tokens"),
    outputTokens: pick("output", "total_output_tokens"),
    reasoningTokens: pick("reasoning", "total_thought_tokens"),
    totalTokens: pick("total", "total_tokens"),
    cachedTokens: pick("cached", "total_cached_tokens"),
  };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.UsageLogModel] model z metodą `create` (w testach atrapa)
 * @param {Function} [deps.log] (event, fields) → zapis linii JSON do logu procesu
 */
export function createAiUsageLogger({
  UsageLogModel = AiUsageLog,
  log = defaultLog,
  writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
  runWriteBudgetMs = DEFAULT_RUN_WRITE_BUDGET_MS,
} = {}) {
  const effectiveRunBudgetMs =
    Number.isFinite(runWriteBudgetMs) && runWriteBudgetMs > 0
      ? Math.floor(runWriteBudgetMs)
      : DEFAULT_RUN_WRITE_BUDGET_MS;
  const effectiveWriteTimeoutMs =
    Number.isFinite(writeTimeoutMs) && writeTimeoutMs > 0
      ? Math.floor(writeTimeoutMs)
      : DEFAULT_WRITE_TIMEOUT_MS;

  const safeLog = (event, fields) => {
    try {
      log(event, fields);
    } catch {
      /* log nigdy nie przerywa pracy */
    }
  };

  /**
   * Rejestrator jednego uruchomienia: sam numeruje próby (1…n w obrębie
   * `analysisRunId`, także przez kolejne wywołania klienta po odrzuceniu przez walidator).
   *
   * @param {object} meta
   * @param {string} meta.runId
   * @param {"full"|"quickCheck"} meta.kind
   * @param {string} meta.trigger     wartość z serwisu stanu ("manual"/"auto") lub z enumeracji
   * @param {string} meta.userId
   * @param {string} [meta.positionId]
   * @param {string} [meta.actionId]  tylko quick-check
   * @param {string} meta.requestedModel
   * @param {string} [meta.promptVersion]
   * @param {number} [meta.inputChars] długość treści użytkownika wysłanej do modelu
   * @param {string} [meta.provider]
   */
  function forRun(meta) {
    let counter = 0;
    let budgetLeftMs = effectiveRunBudgetMs; // wspólny dla wszystkich rekordów tego uruchomienia
    const kind = AI_USAGE_KINDS.includes(meta.kind) ? meta.kind : "full";

    /**
     * Zapisuje jedną próbę. NIGDY nie rzuca. Zwraca true/false (czy rekord zapisano).
     *
     * @param {object} entry  opis próby z klienta (`attempts[i]`)
     * @param {object} [extra]
     * @param {Date|number} [extra.startedAt]
     * @param {string} [extra.outcome]        nadpisuje wynik wyliczony z próby
     * @param {string|null} [extra.modelVersion]
     * @param {string[]} [extra.warningCodes]
     * @param {string[]} [extra.errorCodes]
     * @param {number|null} [extra.outputChars]
     * @param {Record<string, number>} [extra.maxFieldLengths]
     */
    async function record(entry, extra = {}) {
      counter += 1;
      const attempt = counter;

      try {
        const outcome = AI_USAGE_OUTCOMES.includes(extra.outcome)
          ? extra.outcome
          : outcomeForAttempt(entry);
        const usage = entry?.usage ?? {};
        const startedAt = new Date(extra.startedAt ?? Date.now());
        const doc = {
          analysisRunId: meta.runId,
          attempt,
          kind,
          trigger: toUsageTrigger(meta.trigger),
          userId: meta.userId,
          positionId: meta.positionId ?? null,
          actionId: meta.actionId ?? null,
          provider: safeProviderValue(meta.provider) ?? "gemini",
          requestedModel: meta.requestedModel,
          modelVersion: safeModelVersion(extra.modelVersion),
          endpointKind: safeProviderValue(entry?.endpointKind),
          promptVersion: meta.promptVersion ?? null,
          startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
          durationMs: intOrNull(
            Number.isFinite(entry?.durationMs)
              ? Math.max(0, Math.round(entry.durationMs))
              : null,
          ),
          outcome,
          httpStatus: intOrNull(entry?.httpStatus),
          providerErrorCode: safeProviderValue(entry?.providerCode),
          finishReason: safeProviderValue(entry?.finishReason),
          ...mapUsage(usage),
          inputChars: intOrNull(meta.inputChars),
          outputChars: intOrNull(extra.outputChars),
          warningCodes: uniqueCodes(extra.warningCodes),
          errorCodes: uniqueCodes(extra.errorCodes),
        };
        const fieldLengths = safeFieldLengths(kind, extra.maxFieldLengths);
        if (fieldLengths) doc.maxFieldLengths = fieldLengths;

        // Linia JSON do logu procesu: te same pola bez treści (pola puste pomijamy).
        safeLog("ai_usage", {
          runId: doc.analysisRunId,
          attempt: doc.attempt,
          kind: doc.kind,
          trigger: doc.trigger,
          positionId: meta.positionId ? String(meta.positionId) : null,
          actionId: meta.actionId ? String(meta.actionId) : null,
          model: doc.requestedModel,
          modelVersion: doc.modelVersion,
          outcome: doc.outcome,
          httpStatus: doc.httpStatus,
          endpointKind: doc.endpointKind,
          providerCode: doc.providerErrorCode,
          finishReason: doc.finishReason,
          durationMs: doc.durationMs,
          inputTokens: doc.inputTokens,
          outputTokens: doc.outputTokens,
          reasoningTokens: doc.reasoningTokens,
          totalTokens: doc.totalTokens,
          warningCodes: doc.warningCodes,
          errorCodes: doc.errorCodes,
        });

        if (budgetLeftMs <= 0) {
          // Wcześniejsze zapisy zużyły wspólny budżet (baza jest wyraźnie wolna lub zawieszona).
          safeLog("usage_log_budget_exhausted", { runId: meta.runId, attempt });
          return false;
        }

        let timer;
        const waitStartedMs = Date.now();
        try {
          // Promise.race odcina oczekiwanie na zawieszoną bazę. Nie anuluje już
          // wysłanej operacji MongoDB; zapis może zakończyć się po naszym timeoutcie.
          const write = Promise.resolve().then(() => UsageLogModel.create(doc));
          const requestedWait = Number.isFinite(extra.maxWaitMs)
            ? Math.max(1, extra.maxWaitMs)
            : effectiveWriteTimeoutMs;
          const timeoutMs = Math.max(
            1,
            Math.min(effectiveWriteTimeoutMs, requestedWait, budgetLeftMs),
          );
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error("usage_log_timeout");
              error.name = "UsageLogTimeout";
              reject(error);
            }, timeoutMs);
          });
          await Promise.race([write, timeout]);
          return true;
        } finally {
          clearTimeout(timer);
          budgetLeftMs -= Math.max(0, Date.now() - waitStartedMs);
        }
      } catch (error) {
        safeLog("usage_log_write_failed", {
          runId: meta.runId,
          attempt,
          name: error?.name ?? "Error",
        });
        return false;
      }
    }

    return { record, attemptsRecorded: () => counter };
  }

  return { forRun };
}

/** Instancja produkcyjna (zapis do kolekcji `aiusagelogs`). */
export const aiUsageLogger = createAiUsageLogger();
