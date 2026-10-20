/**
 * Zestaw pomocniczy do testów orkiestratora AI (Etap 8.9): fałszywy Gemini, atrapa
 * modelu dziennika zużycia, atrapa kolekcji `Action` z zapytaniami po ścieżkach
 * (`earlyAiCheck.runStartedAt`) oraz złożony orkiestrator ze sterowanym zegarem.
 *
 * Bez sieci i bez prawdziwego Gemini; dane syntetyczne. Do budowy danych wejściowych
 * używany jest PRAWDZIWY builder z 8.7 (na atrapach modeli z `aiInputKit.js`).
 */
import mongoose from "mongoose";
import { getAiConfig } from "../../config/aiConfig.js";
import { createAiInputBuilder } from "../../services/aiInputBuilder.js";
import { createAiOrchestrator } from "../../services/aiOrchestrator.js";
import { createAiUsageLogger } from "../../services/aiUsageLogger.js";
import { createAiSafeguards } from "../../services/aiSafeguards.js";
import { BIAS_LIST } from "../../utils/biasList.js";
import { IDS, makeFixture, makeMarketContext, makeBars } from "./aiInputKit.js";

export const KNOWN_BIAS = BIAS_LIST[0].name;
export const SECRET_ANSWER = "TAJNY-TEKST-ODPOWIEDZI-MODELU";

/** Poprawna odpowiedź pełnej analizy (kształt kontraktu 7.1). */
export function validFull(over = {}) {
  return {
    summary: `Podsumowanie. ${SECRET_ANSWER}`,
    observedPatterns: ["Wzorzec A", "Wzorzec B"],
    possibleBiases: [
      {
        bias: KNOWN_BIAS,
        confidence: "medium",
        supportingEvidence: "Dowód za",
        contradictingEvidence: "Dowód przeciw",
      },
    ],
    alternativeExplanations: ["Inne wyjaśnienie"],
    limitations: "Brak świecy z bieżącej sesji.",
    outcomeNote: "Wynik osobno.",
    ...over,
  };
}

/** Poprawna odpowiedź quick-checka (kształt kontraktu 7.2). */
export function validQuick(over = {}) {
  return {
    summary: `Szybka ocena. ${SECRET_ANSWER}`,
    possibleBiases: [KNOWN_BIAS],
    limitations: "Krótka ocena.",
    ...over,
  };
}

export const usage = (over = {}) => ({
  input: 1200,
  output: 300,
  reasoning: 0,
  total: 1500,
  ...over,
});

export const REQUEST_SETTINGS = Object.freeze({
  maxOutputTokens: 8192,
  thinkingLevel: null,
  store: false,
  apiRevision: "test-revision",
});

/** Wynik udany klienta (kształt 6.14 + `attempts`). */
export function okResult(value, over = {}) {
  return {
    ok: true,
    value,
    usage: usage(),
    modelVersion: null,
    finishReason: "stop",
    attempts: [
      {
        attempt: 1,
        ok: true,
        errorKind: null,
        httpStatus: null,
        providerCode: null,
        durationMs: 800,
        usage: usage(),
        finishReason: "stop",
        endpointKind: "interactions",
      },
    ],
    requestSettings: { ...REQUEST_SETTINGS },
    ...over,
  };
}

/** Wynik błędu klienta; `tries` = liczba prób w `attempts` (0 = brak żądania sieciowego). */
export function failResult(kind, { httpStatus = null, providerCode = null, tries = 1 } = {}) {
  const attempts = Array.from({ length: tries }, (_, i) => ({
    attempt: i + 1,
    ok: false,
    errorKind: kind,
    httpStatus,
    providerCode,
    durationMs: 500,
    usage: usage({ input: null, output: null, reasoning: null, total: null }),
    finishReason: kind === "blocked" ? "blocked" : "other",
    endpointKind: "interactions",
  }));
  return {
    ok: false,
    error: { kind, httpStatus, providerCode },
    attempts,
    requestSettings: tries === 0 ? null : { ...REQUEST_SETTINGS },
  };
}

/**
 * Fałszywy klient Gemini: kolejne wywołania dostają kolejne elementy `script`
 * (wartość, albo funkcja `(request, callNo) => wynik | Promise`). Zapisuje żądania.
 * Gdy skrypt się skończy — rzuca, żeby nadmiarowe wywołanie było widoczne w teście.
 */
export function createFakeSend(script = []) {
  const calls = [];
  const send = async (request) => {
    const index = calls.length;
    calls.push(request);
    if (index >= script.length) {
      throw new Error(`Nieoczekiwane wywołanie modelu nr ${index + 1}`);
    }
    const step = script[index];
    return typeof step === "function" ? step(request, index + 1) : step;
  };
  return { send, calls };
}

/** Treść bloku <DANE> z `userContent` żądania (to, co faktycznie wysłano do modelu). */
export function extractSentData(request) {
  const match = /<DANE>\n([\s\S]*?)\n<\/DANE>/.exec(request.userContent);
  if (!match) throw new Error("Brak bloku <DANE> w userContent");
  return JSON.parse(match[1]);
}

// structuredClone psuje ObjectId (zamienia na zwykły obiekt) — własne kopiowanie.
export function cloneDeep(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneDeep(x)]));
  }
  return v;
}

/** Atrapa modelu `AiUsageLog`: zapisuje dokumenty; `failWith` wymusza błąd zapisu. */
export function createFakeUsageModel() {
  const docs = [];
  const model = {
    docs,
    failWith: null,
    async create(doc) {
      if (model.failWith) throw model.failWith;
      docs.push(cloneDeep(doc));
      return doc;
    },
  };
  return model;
}

/* ----------------------------------------------------------- atrapa Action */

const getPath = (doc, path) =>
  path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), doc);

const asTime = (v) => (v instanceof Date ? v.getTime() : v);

function matchOne(value, cond) {
  const isOps =
    cond !== null &&
    typeof cond === "object" &&
    !(cond instanceof Date) &&
    Object.keys(cond).some((k) => k.startsWith("$"));
  if (!isOps) {
    if (cond === null) return value === null || value === undefined; // null = brak pola lub null
    if (value == null) return false;
    return value instanceof Date || cond instanceof Date
      ? asTime(value) === asTime(cond)
      : String(value) === String(cond);
  }
  return Object.entries(cond).every(([op, arg]) => {
    if (op === "$lt") return value != null && asTime(value) < asTime(arg);
    if (op === "$ne") return !matchOne(value, arg);
    throw new Error(`Atrapa Action nie obsługuje ${op}`);
  });
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(doc, f));
    if (key === "$and") return cond.every((f) => matches(doc, f));
    return matchOne(getPath(doc, key), cond);
  });
}

function projectDoc(doc, select) {
  const copy = cloneDeep(doc);
  if (!select) return copy;
  const keep = new Set(["_id", ...select.split(/\s+/).filter(Boolean)]);
  return Object.fromEntries(Object.entries(copy).filter(([k]) => keep.has(k)));
}

function query(run) {
  const opts = {};
  const q = {
    select(s) {
      opts.select = s;
      return q;
    },
    lean() {
      return q;
    },
    then(resolve, reject) {
      return Promise.resolve().then(() => run(opts)).then(resolve, reject);
    },
  };
  return q;
}

/**
 * Atrapa kolekcji `Action` na wspólnej tablicy dokumentów. Obsługuje to, czego używają
 * builder (find) i orkiestrator (findOne, findOneAndUpdate z `$set`, `$or`, `$lt`,
 * ścieżki z kropką, `null` = brak pola). NIE zastępuje testu na MongoDB.
 */
export function createFakeActionModel(docs) {
  return {
    _docs: docs,
    /** Test może podmienić zapis (np. „wyścig” z nowszym quick-checkiem). */
    beforeUpdate: null,
    find: (filter) =>
      query((o) => docs.filter((d) => matches(d, filter)).map((d) => projectDoc(d, o.select))),
    findOne: (filter) =>
      query((o) => {
        const doc = docs.find((d) => matches(d, filter));
        return doc ? projectDoc(doc, o.select) : null;
      }),
    findOneAndUpdate(filter, update, options = {}) {
      return query(async (o) => {
        if (this.beforeUpdate) await this.beforeUpdate();
        const doc = docs.find((d) => matches(d, filter));
        if (!doc) return null;
        const before = cloneDeep(doc);
        for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = cloneDeep(v);
        return projectDoc(options.returnDocument === "after" ? doc : before, o.select);
      });
    },
  };
}

/* ------------------------------------------------------------ złożony zestaw */

export const T0 = Date.parse("2026-10-21T21:00:00.000Z");

/**
 * Składa orkiestrator z PRAWDZIWYM builderem 8.7 (atrapy modeli i rynku), prawdziwym
 * walidatorem i promptem oraz fałszywym Gemini.
 *
 * @param {object} opts
 * @param {Array} [opts.script]          kolejne wyniki fałszywego klienta
 * @param {object} [opts.cfg]            nadpisania konfiguracji AI (np. {enabled:false})
 * @param {object} [opts.fixtureOptions] opcje `makeFixture` (np. {marketError})
 * @param {object} [opts.user]           użytkownik zwracany przez `loadUser`
 * @param {object} [opts.orchestratorOptions] dodatkowe opcje fabryki (np. krótsze limity czasu
 *                                        w testach: quickCheckTimeoutMs, saveBudgetMs, lockMaxHoldMs)
 */
export function createOrchestratorKit({
  script = [],
  cfg = {},
  fixtureOptions = {},
  user,
  orchestratorOptions = {},
} = {}) {
  const clock = { t: T0 };
  const cfgState = { ...cfg };
  const logs = [];
  const builderLogs = [];
  const fixture = makeFixture({
    ...fixtureOptions,
    now: new Date(T0),
    logs: builderLogs,
  });
  // Builder na atrapie Action z obsługą ścieżek (wspólna tablica dokumentów z fixture).
  const actions = createFakeActionModel(fixture.actions._docs);
  const marketCalls = [];
  const builder = createAiInputBuilder({
    PositionModel: fixture.positions,
    ActionModel: actions,
    getMarketContext: fixtureOptions.marketError
      ? async () => {
          throw fixtureOptions.marketError;
        }
      : makeMarketContext({ bars: makeBars(), calls: marketCalls }),
    getCompanyNews: async () => {
      if (fixtureOptions.newsError) throw fixtureOptions.newsError;
      return fixtureOptions.news ?? [];
    },
    now: () => new Date(clock.t),
    log: (event, fields) => builderLogs.push({ event, ...fields }),
  });

  const getConfig = () => ({
    ...getAiConfig({ AI_ENABLED: "true", GEMINI_API_KEY: "test-key-not-real" }),
    ...cfgState,
  });
  const safeguards = createAiSafeguards({ getConfig, now: () => clock.t });
  const usageModel = createFakeUsageModel();
  const usageLogger = createAiUsageLogger({
    UsageLogModel: usageModel,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  const fake = createFakeSend(script);
  const userState = {
    user: user ?? {
      disclaimerAcceptedAt: new Date("2026-10-01T00:00:00Z"),
      disclaimerVersion: "1",
    },
  };
  userState.loads = 0; // ile razy orkiestrator odczytał użytkownika (kontrola zgody)
  userState.onLoad = null; // opcjonalny hak `(numerOdczytu) => Promise|void`
  let counter = 0;

  const hooks = { beforeBuild: null, afterBuild: null };
  const build = async (args) => {
    if (hooks.beforeBuild) await hooks.beforeBuild(args);
    // Dane syntetyczne z fixture mają własne identyfikatory — przekierowanie jest
    // jawne, a nie ukryte w builderze: identyfikatory z żądania sprawdza osobny test.
    const result = await builder.buildModelInput(
      hooks.mapIds ? hooks.mapIds(args) : args,
    );
    if (hooks.afterBuild) await hooks.afterBuild(result);
    return result;
  };

  const orchestrator = createAiOrchestrator({
    buildModelInput: build,
    send: fake.send,
    usageLogger,
    safeguards,
    getConfig,
    loadUser: async () => {
      userState.loads += 1;
      // Test może „wstrzymać” odczyt użytkownika (np. zawisła baza, wyścig z pauzą po 429).
      if (userState.onLoad) await userState.onLoad(userState.loads);
      return userState.user;
    },
    PositionModel: fixture.positions,
    ActionModel: actions,
    now: () => clock.t,
    generateRunId: () => `run-${++counter}`,
    log: (event, fields) => logs.push({ event, ...fields }),
    ...orchestratorOptions,
  });

  return {
    orchestrator,
    fixture,
    actions,
    clock,
    cfg: cfgState,
    getConfig,
    safeguards,
    usageModel,
    usageDocs: usageModel.docs,
    calls: fake.calls,
    logs,
    builderLogs,
    marketCalls,
    userState,
    hooks,
    advance: (ms) => {
      clock.t += ms;
    },
    /** Identyfikatory z fixture (pozycja i akcje użytkownika A). */
    ids: IDS,
    /** Parametry quick-checka dla wybranej akcji fixture. */
    qc: (actionId = IDS.action2) => ({
      userId: IDS.userA,
      positionId: IDS.position,
      actionId,
    }),
  };
}

/** Wszystkie kombinacje tekstów (dokumenty i linie logu) do skanu „czy nie ma treści”. */
export const stringify = (value) => JSON.stringify(value ?? null);
