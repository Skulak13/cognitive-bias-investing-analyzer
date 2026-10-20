import { test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Position from "../models/Position.js";
import Action from "../models/Action.js";
import { validateAiResponse } from "../utils/validateAiResponse.js";
import { BIAS_LIST, OTHER_BIAS } from "../utils/biasList.js";

/* ------------------------------------------------------------------ *
 * Etap 7, krok 3 — "most do Mongoose".
 *
 * Dwie warstwy chronią dane na dwóch różnych granicach:
 *   - validateAiResponse() — granica Gemini → backend,
 *   - model Mongoose (Position dla pełnej analizy, Action.earlyAiCheck dla
 *     quick-checka) — granica model domenowy → MongoDB.
 *
 * Ten test pilnuje, żeby się nie rozjechały: gdy walidator mówi
 * "ok: true", wynik (po dołożeniu metadanych backendu) musi być naprawdę
 * akceptowany przez Position.validateSync() — i musi zapisać się w
 * dokumencie w całości, z tymi samymi wartościami.
 *
 * Mongoose domyślnie po cichu POMIJA pola, których nie zna (tryb strict),
 * więc samo "validateSync() bez błędów" niczego nie dowodzi. Dlatego test
 * sprawdza też odwrotnie: każde pole z `value` musi występować w dokumencie.
 *
 * Nie wymaga bazy danych (validateSync działa lokalnie, bez połączenia).
 * Metadane backendu dokładane poniżej to LOKALNY pomocnik testowy —
 * prawdziwe dopisywanie metadanych to Etap 8; ten sam test posłuży wtedy
 * jako kryterium odbioru.
 * ------------------------------------------------------------------ */

const FULL = { kind: "full" };

function validFull(overrides = {}) {
  return {
    summary: "Decyzja o zakupie zapadła tuż po wzroście ceny.",
    observedPatterns: ["Zakup po dynamicznym wzroście", "Brak planu wyjścia"],
    possibleBiases: [
      {
        bias: "niechęć do straty",
        confidence: "medium",
        supportingEvidence:
          "Użytkownik pisze, że nie chciał realizować straty.",
        contradictingEvidence: "Pozycja była zamknięta zgodnie z planem.",
      },
    ],
    alternativeExplanations: ["Zwykła zmiana strategii."],
    limitations: "Analiza opiera się na jednej pozycji.",
    outcomeNote: "Wynik finansowy oceniany osobno.",
    ...overrides,
  };
}

/** Lokalna atrapa metadanych, które w Etapie 8 doda backend po ok:true. */
function backendMetadata() {
  return {
    analysisType: "final",
    analyzedAt: new Date("2026-10-05T12:00:00.000Z"),
    aiModelVersion: "test-model",
    promptVersion: "test-prompt",
    marketContextSnapshot: {
      priceHistory: [],
      newsHighlights: [],
      fetchedAt: new Date("2026-10-05T11:59:00.000Z"),
    },
    inputSnapshot: {
      actions: [],
      capturedAt: new Date("2026-10-05T11:59:00.000Z"),
    },
  };
}

/** Minimalna poprawna Position, zgodna z istniejącymi testami integracyjnymi. */
function buildPosition(analysis) {
  return new Position({
    userId: new mongoose.Types.ObjectId(),
    ticker: "CSCO",
    status: "closed",
    openedAt: new Date("2026-09-18T15:00:00.000Z"),
    currentQuantity: 0,
    analyses: [analysis],
  });
}

/** Wynik walidatora + metadane backendu — to, co w Etapie 8 trafi do Position. */
function toAnalysis(value, metadata = backendMetadata()) {
  return { ...value, ...metadata };
}

function validateThroughBridge(raw) {
  const result = validateAiResponse(raw, FULL);

  assert.equal(
    result.ok,
    true,
    `walidator powinien przyjąć odpowiedź: ${JSON.stringify(result.errors)}`,
  );

  const position = buildPosition(toAnalysis(result.value));
  const mongooseError = position.validateSync();

  return { value: result.value, position, mongooseError };
}

/**
 * Sprawdza, że KAŻDE pole z `expected` występuje w `actual` z tą samą
 * wartością (rekurencyjnie dla obiektów i tablic). Dodatkowe pola w `actual`
 * (np. _id czy wartości domyślne Mongoose) są dozwolone.
 */
function assertContainsAll(actual, expected, path = "value") {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: oczekiwano tablicy`);
    assert.equal(
      actual.length,
      expected.length,
      `${path}: inna liczba elementów`,
    );
    expected.forEach((item, index) =>
      assertContainsAll(actual[index], item, `${path}[${index}]`),
    );
    return;
  }

  if (expected !== null && typeof expected === "object") {
    assert.ok(
      actual !== null && typeof actual === "object",
      `${path}: oczekiwano obiektu`,
    );

    for (const key of Object.keys(expected)) {
      assert.ok(
        Object.hasOwn(actual, key),
        `${path}.${key}: pole z walidatora nie występuje w dokumencie Mongoose (zostało po cichu pominięte?)`,
      );
      assertContainsAll(actual[key], expected[key], `${path}.${key}`);
    }
    return;
  }

  assert.deepEqual(actual, expected, `${path}: inna wartość w dokumencie`);
}

/** Zapisany w dokumencie obiekt analizy (zwykłe dane, bez metod Mongoose). */
function storedAnalysis(position) {
  return position.toObject().analyses[0];
}

/* ------------------------------------------------------------------ *
 * Etap 8.7.5 — identyfikatory uruchomienia należą do backendu
 * ------------------------------------------------------------------ */

test("most (8.7.5) — analysisRunId i runStartedAt podane przez model nie trafiają do dokumentu; zapisuje się wartość backendu", () => {
  const raw = validFull({
    analysisRunId: "podrobione-przez-model",
    runStartedAt: "2020-01-01T00:00:00.000Z",
    lastAnalysisRunId: "podrobione-przez-model",
  });

  const result = validateAiResponse(raw, FULL);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ["backend_field_removed", "backend_field_removed", "backend_field_removed"],
  );

  // backend dopisuje WŁASNY identyfikator uruchomienia po walidacji
  const position = buildPosition(
    toAnalysis(result.value, {
      ...backendMetadata(),
      analysisRunId: "run-backendu-1",
    }),
  );

  assert.equal(position.validateSync(), undefined);
  assert.equal(storedAnalysis(position).analysisRunId, "run-backendu-1");
});

/* ------------------------------------------------------------------ *
 * Zgodność wyniku walidatora z modelem Position
 * ------------------------------------------------------------------ */

test("most — poprawna pełna odpowiedź przechodzi walidator i Position.validateSync()", () => {
  const { mongooseError } = validateThroughBridge(validFull());

  assert.equal(mongooseError, undefined);
});

test("most — odpowiedź podana jako tekst JSON przechodzi tę samą drogę", () => {
  const { mongooseError } = validateThroughBridge(JSON.stringify(validFull()));

  assert.equal(mongooseError, undefined);
});

test("most — KAŻDE pole z value walidatora występuje w dokumencie z tą samą wartością", () => {
  const { value, position, mongooseError } = validateThroughBridge(validFull());

  assert.equal(mongooseError, undefined);
  assertContainsAll(storedAnalysis(position), value);
});

test("most — przycięte teksty i domyślne contradictingEvidence trafiają do dokumentu w tej samej postaci", () => {
  const raw = validFull({
    summary: "  Podsumowanie.  ",
    limitations: "",
    outcomeNote: "  ",
  });
  delete raw.possibleBiases[0].contradictingEvidence;

  const { value, position, mongooseError } = validateThroughBridge(raw);

  assert.equal(mongooseError, undefined);
  assert.equal(value.possibleBiases[0].contradictingEvidence, "");
  assertContainsAll(storedAnalysis(position), value);
});

test("most — puste listy (possibleBiases, observedPatterns, alternativeExplanations) przechodzą oba poziomy", () => {
  const raw = validFull({
    observedPatterns: [],
    possibleBiases: [],
    alternativeExplanations: [],
  });

  const { value, position, mongooseError } = validateThroughBridge(raw);

  assert.equal(mongooseError, undefined);
  assertContainsAll(storedAnalysis(position), value);
});

test("most — wszystkie wartości confidence dopuszczone przez model (low, medium, high) przechodzą oba poziomy", () => {
  for (const confidence of ["low", "medium", "high"]) {
    const raw = validFull();
    raw.possibleBiases[0].confidence = confidence;

    const { value, position, mongooseError } = validateThroughBridge(raw);

    assert.equal(mongooseError, undefined, `confidence=${confidence}`);
    assertContainsAll(storedAnalysis(position), value);
  }
});

test("most — wszystkie 35 nazw kanonicznych oraz fallback przechodzą oba poziomy, a bias należy do taksonomii", () => {
  const allowed = new Set([
    ...BIAS_LIST.map((entry) => entry.name),
    OTHER_BIAS,
  ]);
  const names = [...BIAS_LIST.map((entry) => entry.name), OTHER_BIAS];

  assert.equal(names.length, 36);

  for (const name of names) {
    const raw = validFull();
    raw.possibleBiases[0].bias = name;

    const { value, position, mongooseError } = validateThroughBridge(raw);

    assert.equal(mongooseError, undefined, `bias="${name}"`);

    // Schemat Position NIE ogranicza pola bias do listy, więc przynależność
    // do taksonomii pilnuje wyłącznie ten test (i walidator).
    assert.ok(
      allowed.has(value.possibleBiases[0].bias),
      `"${name}" spoza taksonomii`,
    );
    assert.equal(storedAnalysis(position).possibleBiases[0].bias, name);
  }
});

test("most — jedna analiza ze wszystkimi 36 wpisami (35 nazw + fallback) zapisuje się w całości", () => {
  const entries = [...BIAS_LIST.map((entry) => entry.name), OTHER_BIAS].map(
    (bias) => ({
      bias,
      confidence: "low",
      supportingEvidence: `Dowód dla: ${bias}`,
      contradictingEvidence: "",
    }),
  );

  const { value, position, mongooseError } = validateThroughBridge(
    validFull({ possibleBiases: entries }),
  );

  assert.equal(mongooseError, undefined);
  assert.equal(storedAnalysis(position).possibleBiases.length, 36);
  assertContainsAll(storedAnalysis(position), value);
});

test("most — typ analizy (interim i final) nie zależy od walidatora: oba przechodzą z tym samym value", () => {
  for (const analysisType of ["interim", "final"]) {
    const result = validateAiResponse(validFull(), FULL);
    const metadata = { ...backendMetadata(), analysisType };

    const position = buildPosition(toAnalysis(result.value, metadata));

    assert.equal(position.validateSync(), undefined, analysisType);
    assert.equal(storedAnalysis(position).analysisType, analysisType);
  }
});

/* ------------------------------------------------------------------ *
 * Zgodność wymagań: to, co model uważa za wymagane, walidator też
 * ------------------------------------------------------------------ */

test("most — summary i wpis possibleBiases: pola wymagane przez Mongoose są wymagane także przez walidator", () => {
  // Pola, bez których Position.validateSync() zgłasza błąd, a więc takie,
  // które walidator MUSI odrzucać, zanim odpowiedź w ogóle trafi do modelu.
  const required = [
    { label: "summary", path: "summary", mongoosePath: "analyses.0.summary" },
    ...["bias", "confidence", "supportingEvidence"].map((field) => ({
      label: field,
      path: `possibleBiases[0].${field}`,
      mongoosePath: `analyses.0.possibleBiases.0.${field}`,
    })),
  ];

  for (const { label, path, mongoosePath } of required) {
    // 1) walidator odrzuca odpowiedź bez tego pola
    const raw = validFull();
    if (label === "summary") delete raw.summary;
    else delete raw.possibleBiases[0][label];

    const result = validateAiResponse(raw, FULL);

    assert.equal(
      result.ok,
      false,
      `walidator powinien odrzucić brak "${label}"`,
    );
    assert.ok(
      result.errors.some((e) => e.path === path && e.code === "missing_field"),
      `brak błędu missing_field dla ${path}`,
    );

    // 2) Mongoose też odrzuca dokument bez tego pola (czyli walidator jest
    //    wobec modelu nie luźniejszy niż model)
    const base = validAnalysisForMongoose();
    if (label === "summary") delete base.summary;
    else delete base.possibleBiases[0][label];

    const mongooseError = buildPosition(base).validateSync();

    assert.ok(
      mongooseError?.errors?.[mongoosePath],
      `Mongoose powinien zgłosić błąd dla ${mongoosePath}`,
    );
  }
});

test("most — pusty summary jest odrzucany zarówno przez walidator, jak i przez Mongoose", () => {
  const result = validateAiResponse(validFull({ summary: "" }), FULL);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === "summary" && e.code === "empty_value"),
  );

  const base = validAnalysisForMongoose();
  base.summary = "";
  const mongooseError = buildPosition(base).validateSync();

  assert.ok(mongooseError?.errors?.["analyses.0.summary"]);
});

function validAnalysisForMongoose() {
  const result = validateAiResponse(validFull(), FULL);
  return toAnalysis(structuredClone(result.value));
}

/* ------------------------------------------------------------------ *
 * Mongoose po cichu pomija nieznane pola — dlatego sprawdzamy odwrotnie
 * ------------------------------------------------------------------ */

test("most — Mongoose po cichu pomija nieznane pola, więc samo validateSync() nie wystarcza (kontrola testu)", () => {
  const result = validateAiResponse(validFull(), FULL);

  const withStray = toAnalysis(structuredClone(result.value));
  withStray.polePrzemycone = "wartość spoza modelu";
  withStray.possibleBiases[0].poleWpisu = "też spoza modelu";

  const position = buildPosition(withStray);

  // 1) Mongoose NIE zgłasza błędu...
  assert.equal(position.validateSync(), undefined);

  // 2) ...ale pola nie ma w dokumencie
  const stored = storedAnalysis(position);
  assert.equal(Object.hasOwn(stored, "polePrzemycone"), false);
  assert.equal(Object.hasOwn(stored.possibleBiases[0], "poleWpisu"), false);

  // 3) a pomocnik testu, który to wykrywa, faktycznie zgłasza problem
  assert.throws(() => assertContainsAll(stored, withStray), /pominięte/);
});

test("most — pomocnik assertContainsAll wykrywa brakujące pole, inną wartość i inną liczbę elementów", () => {
  const stored = { a: 1, lista: [{ x: "1" }], pusta: [] };

  assert.doesNotThrow(() =>
    assertContainsAll(stored, { a: 1, lista: [{ x: "1" }] }),
  );

  assert.throws(() => assertContainsAll(stored, { b: 2 }), /pominięte/);
  assert.throws(() => assertContainsAll(stored, { a: 2 }), /inna wartość/);
  assert.throws(
    () => assertContainsAll(stored, { lista: [{ x: "1" }, { x: "2" }] }),
    /liczba elementów/,
  );
  assert.throws(
    () => assertContainsAll(stored, { lista: [{ y: "1" }] }),
    /pominięte/,
  );
});

/* ------------------------------------------------------------------ *
 * Kontrola odwrotna dla confidence (krok 4 zamyka lukę z kroku 3)
 * ------------------------------------------------------------------ */

test("most — walidator odrzuca confidence, który odrzuca Mongoose (zamknięta luka z kroku 3)", () => {
  const invalid = [
    "very high",
    "bardzo pewny",
    "0.8",
    "",
    "   ",
    "średni",
    "high!",
    "med",
  ];

  for (const confidence of invalid) {
    // Mongoose odrzuca wartość spoza enum...
    const base = validAnalysisForMongoose();
    base.possibleBiases[0].confidence = confidence;

    assert.ok(
      buildPosition(base).validateSync()?.errors?.[
        "analyses.0.possibleBiases.0.confidence"
      ],
      `Mongoose powinien odrzucić confidence="${confidence}"`,
    );

    // ...więc walidator musi ją odrzucić jeszcze przed modelem.
    const raw = validFull();
    raw.possibleBiases[0].confidence = confidence;
    const result = validateAiResponse(raw, FULL);

    assert.equal(
      result.ok,
      false,
      `walidator powinien odrzucić confidence="${confidence}"`,
    );
    assert.ok(
      result.errors.some(
        (e) =>
          e.path === "possibleBiases[0].confidence" &&
          e.code === "invalid_confidence",
      ),
    );
  }
});

test("most — confidence w nietekstowej postaci (0.8, null, 123, tablica) jest odrzucany przez oba poziomy", () => {
  for (const confidence of [0.8, null, 123, [], true]) {
    const raw = validFull();
    raw.possibleBiases[0].confidence = confidence;

    assert.equal(
      validateAiResponse(raw, FULL).ok,
      false,
      JSON.stringify(confidence),
    );
  }
});

test("most — znormalizowany confidence (Medium, ' HIGH ') przechodzi walidator, a w dokumencie jest w postaci low/medium/high", () => {
  for (const [input, expected] of [
    ["Medium", "medium"],
    [" HIGH ", "high"],
    ["\tLow\n", "low"],
  ]) {
    const raw = validFull();
    raw.possibleBiases[0].confidence = input;

    const { value, position, mongooseError } = validateThroughBridge(raw);

    assert.equal(mongooseError, undefined, JSON.stringify(input));
    assert.equal(value.possibleBiases[0].confidence, expected);
    assert.equal(
      storedAnalysis(position).possibleBiases[0].confidence,
      expected,
    );
    assertContainsAll(storedAnalysis(position), value);
  }
});

/* ------------------------------------------------------------------ *
 * Krok 5 — rozpoznawanie biasów a model Position
 * ------------------------------------------------------------------ */

test("most — każdy zatwierdzony alias daje w dokumencie nazwę kanoniczną (taksonomia jest spójna z modelem)", () => {
  const allowed = new Set(BIAS_LIST.map((entry) => entry.name));
  let checked = 0;

  for (const entry of BIAS_LIST) {
    for (const alias of entry.aliases) {
      const raw = validFull();
      raw.possibleBiases[0].bias = alias;

      const { value, position, mongooseError } = validateThroughBridge(raw);

      assert.equal(mongooseError, undefined, `alias "${alias}"`);
      assert.equal(
        value.possibleBiases[0].bias,
        entry.name,
        `alias "${alias}"`,
      );
      assert.ok(allowed.has(storedAnalysis(position).possibleBiases[0].bias));
      assert.equal(
        Object.hasOwn(
          storedAnalysis(position).possibleBiases[0],
          "proposedLabel",
        ),
        false,
      );
      checked += 1;
    }
  }

  assert.equal(checked, 143);
});

test("most — nieznany bias: fallback i proposedLabel (wyliczone przez walidator) zapisują się w dokumencie w tej samej postaci", () => {
  const raw = validFull();
  raw.possibleBiases = [
    {
      ...validFull().possibleBiases[0],
      bias: "  FOMO związane z AI   stocks ",
    },
    {
      ...validFull().possibleBiases[0],
      bias: "Xe\u0328 effect",
      proposedLabel: "to pole model ma zignorować",
    },
  ];

  const { value, position, mongooseError } = validateThroughBridge(raw);

  assert.equal(mongooseError, undefined);
  assert.deepEqual(
    value.possibleBiases.map(({ bias, proposedLabel }) => [
      bias,
      proposedLabel,
    ]),
    [
      [OTHER_BIAS, "FOMO związane z AI stocks"],
      [OTHER_BIAS, "Xę effect"],
    ],
  );

  // proposedLabel istnieje w schemacie Position, więc musi się zapisać
  const stored = storedAnalysis(position).possibleBiases;
  assert.equal(stored[0].proposedLabel, "FOMO związane z AI stocks");
  assert.equal(stored[1].proposedLabel, "Xę effect");
  assertContainsAll(storedAnalysis(position), value);
});

test("most — fallback podany wprost (bez nazwy) oraz duplikaty: wszystkie wpisy zapisują się w dokumencie", () => {
  const entry = (bias) => ({ ...validFull().possibleBiases[0], bias });
  const raw = validFull();
  raw.possibleBiases = [
    entry("błąd potwierdzenia"),
    entry("Confirmation Bias"),
    entry(OTHER_BIAS),
  ];

  const { value, position, mongooseError } = validateThroughBridge(raw);

  assert.equal(mongooseError, undefined);
  assert.equal(storedAnalysis(position).possibleBiases.length, 3);
  assert.deepEqual(
    storedAnalysis(position).possibleBiases.map((e) => e.bias),
    ["błąd potwierdzenia", "błąd potwierdzenia", OTHER_BIAS],
  );
  assertContainsAll(storedAnalysis(position), value);
});

/* ================================================================== *
 * Krok 7 — quickCheck a model Action (earlyAiCheck)
 * ================================================================== */

const QUICK = { kind: "quickCheck" };

function validQuick(overrides = {}) {
  return {
    summary: "Wstępna ocena: decyzja wygląda na reakcję na stratę.",
    possibleBiases: ["niechęć do straty"],
    limitations: "Szybka ocena na podstawie jednego zapisu.",
    ...overrides,
  };
}

/** Lokalna atrapa metadanych earlyAiCheck, które w Etapie 8 doda backend. */
function earlyMetadata() {
  return {
    analyzedAt: new Date("2026-10-05T12:00:00.000Z"),
    aiModelVersion: "test-model",
    promptVersion: "test-prompt",
  };
}

/** Minimalna poprawna Action (jak w testach HTTP) z podanym earlyAiCheck. */
function buildAction(earlyAiCheck) {
  return new Action({
    positionId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    actionType: "open",
    quantity: 10,
    executionPrice: 100,
    actionDate: new Date("2026-09-18T15:00:00.000Z"),
    tradingDateRef: new Date("2026-09-18T00:00:00.000Z"),
    statedMotivation: "spodziewam się wzrostu ceny",
    earlyAiCheck,
  });
}

function storedEarlyCheck(action) {
  return action.toObject().earlyAiCheck;
}

function quickThroughBridge(raw) {
  const result = validateAiResponse(raw, QUICK);

  assert.equal(
    result.ok,
    true,
    `walidator powinien przyjąć odpowiedź: ${JSON.stringify(result.errors)}`,
  );

  const action = buildAction({ ...result.value, ...earlyMetadata() });

  return { value: result.value, action, mongooseError: action.validateSync() };
}

test("most quickCheck — poprawna odpowiedź przechodzi walidator i Action.validateSync()", () => {
  const { mongooseError } = quickThroughBridge(validQuick());

  assert.equal(mongooseError, undefined);
});

test("most quickCheck — odpowiedź jako tekst JSON przechodzi tę samą drogę", () => {
  const { mongooseError } = quickThroughBridge(JSON.stringify(validQuick()));

  assert.equal(mongooseError, undefined);
});

test("most quickCheck — KAŻDE pole z value walidatora (także proposedBiasLabels) występuje w earlyAiCheck z tą samą wartością", () => {
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({
      possibleBiases: ["Loss Aversion", "FOMO związane z AI stocks"],
    }),
  );

  assert.equal(mongooseError, undefined);
  assert.deepEqual(value.proposedBiasLabels, ["FOMO związane z AI stocks"]);
  assertContainsAll(storedEarlyCheck(action), value);
});

test("most quickCheck — pusta lista possibleBiases i pusta proposedBiasLabels przechodzą oba poziomy i są obecne w dokumencie", () => {
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({ possibleBiases: [], limitations: "" }),
  );

  assert.equal(mongooseError, undefined);
  assert.deepEqual(value.possibleBiases, []);
  assert.deepEqual(value.proposedBiasLabels, []);
  assertContainsAll(storedEarlyCheck(action), value);
  assert.deepEqual(storedEarlyCheck(action).proposedBiasLabels, []);
});

test("most quickCheck — przycięte teksty i pusty limitations trafiają do dokumentu w tej samej postaci", () => {
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({ summary: "  Podsumowanie.  ", limitations: "   " }),
  );

  assert.equal(mongooseError, undefined);
  assert.equal(value.summary, "Podsumowanie.");
  assert.equal(value.limitations, "");
  assertContainsAll(storedEarlyCheck(action), value);
});

test("most quickCheck — wszystkie 35 nazw kanonicznych oraz fallback przechodzą oba poziomy, a nazwa należy do taksonomii", () => {
  const allowed = new Set([
    ...BIAS_LIST.map((entry) => entry.name),
    OTHER_BIAS,
  ]);
  const names = [...BIAS_LIST.map((entry) => entry.name), OTHER_BIAS];

  for (const name of names) {
    const { value, action, mongooseError } = quickThroughBridge(
      validQuick({ possibleBiases: [name] }),
    );

    assert.equal(mongooseError, undefined, `bias="${name}"`);

    // possibleBiases w Action to zwykłe [String] bez enum — przynależność do
    // taksonomii pilnuje wyłącznie walidator i ten test.
    assert.ok(
      allowed.has(value.possibleBiases[0]),
      `"${name}" spoza taksonomii`,
    );
    assert.deepEqual(storedEarlyCheck(action).possibleBiases, [name]);
  }

  // jedna odpowiedź ze wszystkimi 36 pozycjami
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({ possibleBiases: names }),
  );

  assert.equal(mongooseError, undefined);
  assert.equal(storedEarlyCheck(action).possibleBiases.length, 36);
  assertContainsAll(storedEarlyCheck(action), value);
});

test("most quickCheck — każdy zatwierdzony alias daje w dokumencie nazwę kanoniczną, bez etykiet", () => {
  let checked = 0;

  for (const entry of BIAS_LIST) {
    for (const alias of entry.aliases) {
      const { action, mongooseError } = quickThroughBridge(
        validQuick({ possibleBiases: [alias] }),
      );

      assert.equal(mongooseError, undefined, `alias "${alias}"`);
      assert.deepEqual(
        storedEarlyCheck(action).possibleBiases,
        [entry.name],
        `alias "${alias}"`,
      );
      assert.deepEqual(storedEarlyCheck(action).proposedBiasLabels, []);
      checked += 1;
    }
  }

  assert.equal(checked, 143);
});

test("most quickCheck — nieznane biasy: fallback i proposedBiasLabels (wyliczone przez walidator) zapisują się w dokumencie w tej samej postaci", () => {
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({
      possibleBiases: [
        "  FOMO związane z AI   stocks ",
        "Xe\u0328 effect",
        "fomo związane z ai stocks",
        "Anchoring",
      ],
    }),
  );

  assert.equal(mongooseError, undefined);
  assert.deepEqual(value.possibleBiases, [OTHER_BIAS, "zakotwiczenie"]);
  assert.deepEqual(value.proposedBiasLabels, [
    "FOMO związane z AI stocks",
    "Xę effect",
  ]);

  const stored = storedEarlyCheck(action);
  assert.deepEqual(stored.possibleBiases, [OTHER_BIAS, "zakotwiczenie"]);
  assert.deepEqual(stored.proposedBiasLabels, [
    "FOMO związane z AI stocks",
    "Xę effect",
  ]);
  assertContainsAll(stored, value);
});

test("most quickCheck — deduplikacja: w dokumencie jest tylko pierwsze wystąpienie każdego biasu", () => {
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({
      possibleBiases: [
        "Confirmation Bias",
        "błąd potwierdzenia",
        "Anchoring",
        "Confirmation Bias",
      ],
    }),
  );

  assert.equal(mongooseError, undefined);
  assert.deepEqual(storedEarlyCheck(action).possibleBiases, [
    "błąd potwierdzenia",
    "zakotwiczenie",
  ]);
  assertContainsAll(storedEarlyCheck(action), value);
});

test("most quickCheck — proposedBiasLabels i pola obce podane przez Gemini nie docierają do dokumentu; zapisuje się tylko wartość walidatora", () => {
  const { value, action, mongooseError } = quickThroughBridge(
    validQuick({
      possibleBiases: ["FOMO"],
      proposedBiasLabels: ["moja własna interpretacja"],
      analyzedAt: "2000-01-01",
      aiModelVersion: "podrobiona",
      obcePole: "x",
    }),
  );

  assert.equal(mongooseError, undefined);
  assert.deepEqual(value.proposedBiasLabels, ["FOMO"]);

  const stored = storedEarlyCheck(action);
  assert.deepEqual(stored.proposedBiasLabels, ["FOMO"]);
  assert.equal(
    stored.aiModelVersion,
    "test-model",
    "metadane backendu muszą pochodzić z backendu, nie od Gemini",
  );
  assert.equal(stored.analyzedAt.toISOString(), "2026-10-05T12:00:00.000Z");
  assert.equal(Object.hasOwn(stored, "obcePole"), false);
});

test("most quickCheck — schemat Action.earlyAiCheck ma pole proposedBiasLabels (lista tekstów, domyślnie pusta, bez limitu długości — D5)", () => {
  const schema = Action.schema.path("earlyAiCheck").schema;
  const field = schema.path("proposedBiasLabels");

  assert.ok(field, "brak pola earlyAiCheck.proposedBiasLabels w modelu Action");
  assert.equal(field.instance, "Array");

  // Mongoose 9: typ elementu tablicy to getEmbeddedSchemaType()
  const element = field.getEmbeddedSchemaType();
  assert.equal(element.instance, "String");
  assert.equal(element.options.maxlength, undefined);

  const withoutLabels = buildAction({
    summary: "x",
    possibleBiases: [],
    limitations: "",
    ...earlyMetadata(),
  });

  assert.equal(withoutLabels.validateSync(), undefined);
  assert.deepEqual(storedEarlyCheck(withoutLabels).proposedBiasLabels, []);
});

test("most quickCheck — Mongoose po cichu pomija nieznane pola earlyAiCheck, więc samo validateSync() nie wystarcza (kontrola testu)", () => {
  const result = validateAiResponse(validQuick(), QUICK);

  const action = buildAction({
    ...result.value,
    ...earlyMetadata(),
    polePrzemycone: "wartość spoza modelu",
  });

  assert.equal(action.validateSync(), undefined);

  const stored = storedEarlyCheck(action);
  assert.equal(Object.hasOwn(stored, "polePrzemycone"), false);

  assert.throws(
    () => assertContainsAll(stored, { ...result.value, polePrzemycone: "x" }),
    /pominięte/,
  );
});

test("most quickCheck — summary: pole wymagane przez Mongoose jest wymagane także przez walidator (brak i pusty tekst)", () => {
  const missing = validQuick();
  delete missing.summary;

  const rejectedMissing = validateAiResponse(missing, QUICK);
  assert.equal(rejectedMissing.ok, false);
  assert.ok(
    rejectedMissing.errors.some(
      (e) => e.path === "summary" && e.code === "missing_field",
    ),
  );

  const rejectedBlank = validateAiResponse(
    validQuick({ summary: "  " }),
    QUICK,
  );
  assert.equal(rejectedBlank.ok, false);
  assert.ok(
    rejectedBlank.errors.some(
      (e) => e.path === "summary" && e.code === "empty_value",
    ),
  );

  // Mongoose też odrzuca dokument bez summary lub z pustym summary
  for (const summary of [undefined, ""]) {
    const action = buildAction({
      summary,
      possibleBiases: [],
      limitations: "",
      proposedBiasLabels: [],
      ...earlyMetadata(),
    });

    assert.ok(
      action.validateSync()?.errors?.["earlyAiCheck.summary"],
      `Mongoose powinien odrzucić summary=${JSON.stringify(summary)}`,
    );
  }
});

/* ================================================================== *
 * Krok 8 — bezpieczeństwo i brak limitów (D5) po stronie modeli
 * ================================================================== */

const HUGE_TEXT = 300000;

test("most K8 — brak limitów (D5): bardzo długie teksty i tysiące elementów przechodzą walidator ORAZ Position / Action.validateSync(), a w dokumencie zostają w całości", () => {
  // Pola wyniku AI w modelach nie mają maxlength — gdyby je dodano, walidator
  // przyjmowałby dane, które Mongoose by odrzucił; ten test to wykrywa.
  const unknownNames = Array.from(
    { length: 2000 },
    (_, index) => `nieznany bias ${index}`,
  );
  const raw = validFull({
    summary: `  ${"S".repeat(HUGE_TEXT)}  `,
    observedPatterns: Array.from(
      { length: 3000 },
      (_, index) => `wzorzec ${index}`,
    ),
    alternativeExplanations: ["A".repeat(HUGE_TEXT)],
    limitations: "L".repeat(HUGE_TEXT),
    outcomeNote: "W".repeat(HUGE_TEXT),
    possibleBiases: [
      {
        ...validFull().possibleBiases[0],
        supportingEvidence: "E".repeat(HUGE_TEXT),
        contradictingEvidence: "C".repeat(HUGE_TEXT),
      },
      ...unknownNames.map((bias) => ({
        ...validFull().possibleBiases[0],
        bias,
      })),
    ],
  });

  const { value, position, mongooseError } = validateThroughBridge(raw);

  assert.equal(mongooseError, undefined);

  const stored = storedAnalysis(position);

  assert.ok(
    stored.summary === "S".repeat(HUGE_TEXT),
    "summary skrócony lub zmieniony",
  );
  assert.ok(
    stored.limitations === "L".repeat(HUGE_TEXT),
    "limitations skrócone lub zmienione",
  );
  assert.ok(
    stored.outcomeNote === "W".repeat(HUGE_TEXT),
    "outcomeNote skrócony lub zmieniony",
  );
  assert.ok(stored.alternativeExplanations[0] === "A".repeat(HUGE_TEXT));
  assert.equal(stored.observedPatterns.length, 3000);
  assert.equal(stored.possibleBiases.length, 2001);
  assert.ok(
    stored.possibleBiases[0].supportingEvidence === "E".repeat(HUGE_TEXT),
  );
  assert.ok(
    stored.possibleBiases[0].contradictingEvidence === "C".repeat(HUGE_TEXT),
  );
  assert.deepEqual(
    stored.possibleBiases.slice(1).map((entry) => entry.proposedLabel),
    unknownNames,
  );
  assertContainsAll(stored, value);

  // quickCheck → Action.earlyAiCheck
  const quick = quickThroughBridge(
    validQuick({
      summary: `\n${"S".repeat(HUGE_TEXT)}\n`,
      limitations: "L".repeat(HUGE_TEXT),
      possibleBiases: [...unknownNames, "N".repeat(HUGE_TEXT)],
    }),
  );

  assert.equal(quick.mongooseError, undefined);

  const storedQuick = storedEarlyCheck(quick.action);

  assert.ok(storedQuick.summary === "S".repeat(HUGE_TEXT));
  assert.ok(storedQuick.limitations === "L".repeat(HUGE_TEXT));
  assert.equal(storedQuick.proposedBiasLabels.length, 2001);
  assert.ok(storedQuick.proposedBiasLabels.at(-1) === "N".repeat(HUGE_TEXT));
  assert.deepEqual(storedQuick.possibleBiases, [OTHER_BIAS]);
  assertContainsAll(storedQuick, quick.value);
});

test("most K8 — specjalne nazwy (__proto__, constructor, prototype): pola obce z tekstu JSON nie docierają do dokumentu, a takie nazwy jako nazwy biasów zapisują się jako zwykły tekst bez zmiany prototypów", () => {
  const names = ["__proto__", "constructor", "prototype"];
  const payload = '{"polluted":true,"x":1}';
  const foreign = names.map((name) => `"${name}":${payload}`).join(",");

  // full: pola obce na górze i we wpisie (prawdziwe własne klucze z JSON.parse) + nazwy jako bias
  const entry = (bias) => ({
    __placeholder__: 1,
    ...validFull().possibleBiases[0],
    bias,
  });
  const fullText = JSON.stringify({
    __placeholder__: 1,
    ...validFull({ possibleBiases: names.map(entry) }),
  }).replaceAll('"__placeholder__":1', foreign);

  const parsed = JSON.parse(fullText);
  for (const name of names) {
    assert.ok(
      Object.hasOwn(parsed, name),
      `kontrola: ${name} jest własnym kluczem (góra)`,
    );
    assert.ok(
      Object.hasOwn(parsed.possibleBiases[0], name),
      `kontrola: ${name} jest własnym kluczem (wpis)`,
    );
  }

  const full = validateThroughBridge(fullText);

  assert.equal(full.mongooseError, undefined);

  const storedFull = storedAnalysis(full.position);

  assert.deepEqual(
    storedFull.possibleBiases.map((item) => [item.bias, item.proposedLabel]),
    names.map((name) => [OTHER_BIAS, name]),
  );
  assertContainsAll(storedFull, full.value);

  for (const node of [storedFull, ...storedFull.possibleBiases]) {
    assert.equal(Object.getPrototypeOf(node), Object.prototype);
    for (const name of names) {
      assert.equal(
        Object.hasOwn(node, name),
        false,
        `w dokumencie jest pole ${name}`,
      );
    }
    assert.equal(node.polluted, undefined);
  }

  // quickCheck: pola obce na górze + nazwy jako elementy listy
  const quickText = JSON.stringify({
    __placeholder__: 1,
    ...validQuick({ possibleBiases: names }),
  }).replace('"__placeholder__":1', foreign);
  const quick = quickThroughBridge(quickText);

  assert.equal(quick.mongooseError, undefined);

  const storedQuick = storedEarlyCheck(quick.action);

  assert.deepEqual(storedQuick.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(storedQuick.proposedBiasLabels, names);
  assertContainsAll(storedQuick, quick.value);
  assert.equal(Object.getPrototypeOf(storedQuick), Object.prototype);
  for (const name of names) {
    assert.equal(
      Object.hasOwn(storedQuick, name),
      false,
      `w dokumencie jest pole ${name}`,
    );
  }

  assert.equal({}.polluted, undefined);
  assert.equal([].polluted, undefined);
});
