import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAiResponse,
  normalizeToken,
  normalizeLabel,
  resolveBias,
  BACKEND_OWNED_FIELDS,
  DERIVED_FIELDS,
} from "../utils/validateAiResponse.js";
import { BIAS_LIST, OTHER_BIAS } from "../utils/biasList.js";

/* ------------------------------------------------------------------ *
 * Etap 7, krok 2 — szkielet validateAiResponse (kind: "full").
 *
 * Zakres tego pliku (plan v1.1, sekcje 7.0, 7.1, 10, 12, 15 krok 2):
 *   - dozwolone formy wejścia (obiekt albo czysty tekst z poprawnym JSON-em),
 *   - odrzucanie wszystkiego innego bez "ratowania" odpowiedzi,
 *   - struktura, wymagane pola, typy, puste wartości,
 *   - kształt wyniku { ok, value, warnings } / { ok, errors },
 *   - zbieranie WSZYSTKICH błędów, budowa nowego `value`.
 *
 * Sekcje na końcu pliku pokrywają kolejne kroki: 4 i 5 (normalizeToken,
 * confidence, resolveBias, proposedLabel, other_bias_no_label, duplicate_bias
 * w pełnej analizie), 6 (lista dozwolonych pól, pola obce, pola backendu,
 * pola wyliczane) i 7 (kontrakt quickCheck).
 *
 * Dalsze sekcje (krok 8 i 9): testy bezpieczeństwa, niezmieniania wejścia,
 * przypadków brzegowych i brak limitów (D5), a także pomocnik kontrolujący
 * Object.prototype i Array.prototype (pełne deskryptory, odtwarzanie w finally).
 * Podłączenie walidatora do aiAnalysisService należy do Etapu 8 i nie jest tu testowane.
 * ------------------------------------------------------------------ */

const FULL = { kind: "full" };

/** Świeży, poprawny obiekt przy każdym wywołaniu — testy nie współdzielą stanu. */
function validFull() {
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
  };
}

const REQUIRED_FIELDS = [
  "summary",
  "observedPatterns",
  "possibleBiases",
  "alternativeExplanations",
  "limitations",
  "outcomeNote",
];

const ERROR_CODES = [
  "invalid_json",
  "invalid_structure",
  "missing_field",
  "invalid_type",
  "empty_value",
  "invalid_bias",
  "invalid_confidence",
];

const run = (raw) => validateAiResponse(raw, FULL);

/** Zamienia błędy na posortowane napisy "ścieżka | kod" — wygodne do porównań. */
const pairs = (errors) =>
  errors.map((error) => `${error.path} | ${error.code}`).sort();

function assertRejected(result, expected) {
  assert.equal(result.ok, false, "odpowiedź powinna zostać odrzucona");
  assert.deepEqual(
    pairs(result.errors),
    expected.map(([path, code]) => `${path} | ${code}`).sort(),
  );
}

function assertAccepted(result) {
  assert.equal(
    result.ok,
    true,
    `odpowiedź powinna zostać przyjęta, błędy: ${JSON.stringify(result.errors)}`,
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * kind
 * ------------------------------------------------------------------ */

test("kind — nieznany lub brakujący kind rzuca wyjątek (błąd programisty, nie ok:false)", () => {
  for (const kind of [
    undefined,
    null,
    "",
    "Full",
    "FULL",
    "quick",
    "analysis",
    5,
    {},
    [],
  ]) {
    assert.throws(
      () => validateAiResponse(validFull(), { kind }),
      /kind/,
      `kind=${JSON.stringify(kind)} powinien rzucić wyjątek`,
    );
  }
});

test("kind — brak obiektu opcji lub brak pola kind rzuca wyjątek", () => {
  assert.throws(() => validateAiResponse(validFull()), /kind/);
  assert.throws(() => validateAiResponse(validFull(), {}), /kind/);
  assert.throws(() => validateAiResponse(validFull(), null), /kind/);
});

test("kind — zły kind rzuca wyjątek także wtedy, gdy samo wejście jest niepoprawne", () => {
  assert.throws(
    () => validateAiResponse("to nie jest JSON", { kind: "oops" }),
    /kind/,
  );
  assert.throws(() => validateAiResponse(null, { kind: "oops" }), /kind/);
});

test("kind — quickCheck jest obsługiwanym kindem (nie rzuca wyjątku, tylko waliduje wg własnego kontraktu)", () => {
  assert.doesNotThrow(() =>
    validateAiResponse(
      { summary: "x", possibleBiases: [], limitations: "" },
      { kind: "quickCheck" },
    ),
  );

  // wielkość liter ma znaczenie: tylko dokładnie "full" i "quickCheck"
  for (const kind of [
    "quickcheck",
    "QuickCheck",
    "quick-check",
    "quick_check",
  ]) {
    assert.throws(() => validateAiResponse({}, { kind }), /kind/);
  }
});

/* ------------------------------------------------------------------ *
 * Dozwolone formy wejścia (sekcja 7.0)
 * ------------------------------------------------------------------ */

test("wejście — gotowy zwykły obiekt jest przyjmowany", () => {
  const result = run(validFull());

  assertAccepted(result);
  assert.deepEqual(result.value, validFull());
});

test("wejście — czysty tekst z poprawnym JSON-em jest parsowany i daje ten sam wynik co obiekt", () => {
  const fromObject = run(validFull());
  const fromText = run(JSON.stringify(validFull()));

  assertAccepted(fromText);
  assert.deepEqual(fromText.value, fromObject.value);
});

test("wejście — odstępy i nowe linie na brzegach tekstu z JSON-em są dopuszczalne", () => {
  const result = run(`\n  \t${JSON.stringify(validFull(), null, 2)}\n\n  `);

  assertAccepted(result);
  assert.deepEqual(result.value, validFull());
});

test("wejście — obiekt bez prototypu (Object.create(null)) jest zwykłym obiektem", () => {
  const raw = Object.assign(Object.create(null), validFull());

  assertAccepted(run(raw));
});

test("wejście — wynik sukcesu ma dokładnie pola ok, value, warnings (warnings to tablica)", () => {
  const result = run(validFull());

  assert.deepEqual(Object.keys(result).sort(), ["ok", "value", "warnings"]);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.warnings));
});

/* ------------------------------------------------------------------ *
 * Odrzucane formy wejścia — invalid_json (walidator niczego nie "ratuje")
 * ------------------------------------------------------------------ */

test("wejście — tekst niebędący czystym, poprawnym JSON-em daje invalid_json", () => {
  const json = JSON.stringify(validFull());

  const cases = {
    "opakowanie ```json": "```json\n" + json + "\n```",
    "opakowanie ``` bez nazwy języka": "```\n" + json + "\n```",
    "opakowanie ```JSON wielkimi literami": "```JSON\n" + json + "\n```",
    "tekst przed JSON-em": "Oto analiza: " + json,
    "tekst po JSON-ie": json + "\nMam nadzieję, że to pomoże.",
    "tekst przed i po JSON-ie": "Wynik:\n" + json + "\nKoniec.",
    "pusty tekst": "",
    "same odstępy": "  \n\t ",
    "urwany JSON": json.slice(0, json.length - 10),
    "zwykłe zdanie": "Nie potrafię tego przeanalizować.",
    "apostrofy zamiast cudzysłowów": "{'summary': 'x'}",
    "przecinek na końcu": '{"summary": "x",}',
    "komentarz w JSON-ie": '{"summary": "x" /* uwaga */}',
    "znak BOM przed JSON-em": "\uFEFF" + json,
  };

  for (const [label, text] of Object.entries(cases)) {
    const result = run(text);

    assertRejected(result, [["$", "invalid_json"]]);
    assert.equal(result.errors.length, 1, `${label}: oczekiwany jeden błąd`);
  }
});

/* ------------------------------------------------------------------ *
 * Odrzucane formy wejścia — invalid_structure
 * ------------------------------------------------------------------ */

test("wejście — wartości niebędące zwykłym obiektem dają invalid_structure", () => {
  class Niestandardowy {
    constructor() {
      this.summary = "x";
    }
  }

  const cases = {
    null: null,
    undefined: undefined,
    liczba: 42,
    "wartość logiczna": true,
    tablica: [],
    "tablica z poprawnym obiektem": [validFull()],
    funkcja: () => validFull(),
    Date: new Date(),
    Map: new Map(),
    "instancja klasy": new Niestandardowy(),
    "obiekt String": new String("{}"),
  };

  for (const [label, raw] of Object.entries(cases)) {
    const result = run(raw);

    assert.equal(result.ok, false, `${label}: powinno być odrzucone`);
    assert.deepEqual(
      pairs(result.errors),
      ["$ | invalid_structure"],
      `${label}: zły kod błędu`,
    );
  }
});

test("wejście — poprawny JSON, który nie jest obiektem, daje invalid_structure (bez drugiego parsowania)", () => {
  const cases = {
    "pusta tablica": "[]",
    "tablica z obiektem": JSON.stringify([validFull()]),
    null: "null",
    liczba: "123",
    "wartość logiczna": "true",
    "tekst w cudzysłowie": '"zwykły tekst"',
    "JSON zakodowany podwójnie": JSON.stringify(JSON.stringify(validFull())),
  };

  for (const [label, text] of Object.entries(cases)) {
    const result = run(text);

    assert.equal(result.ok, false, `${label}: powinno być odrzucone`);
    assert.deepEqual(
      pairs(result.errors),
      ["$ | invalid_structure"],
      `${label}: zły kod błędu`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Wymagane pola i typy
 * ------------------------------------------------------------------ */

test("pola — pusty obiekt (jako obiekt i jako tekst) daje missing_field dla wszystkich wymaganych pól", () => {
  const expected = REQUIRED_FIELDS.map((field) => [field, "missing_field"]);

  assertRejected(run({}), expected);
  assertRejected(run("{}"), expected);
});

test("pola — brak każdego wymaganego pola (osobno) daje dokładnie jeden błąd missing_field", () => {
  for (const field of REQUIRED_FIELDS) {
    const raw = validFull();
    delete raw[field];

    assertRejected(run(raw), [[field, "missing_field"]]);
  }
});

test("pola — pole o wartości undefined jest traktowane jak brakujące", () => {
  const raw = validFull();
  raw.summary = undefined;

  assertRejected(run(raw), [["summary", "missing_field"]]);
});

test("pola — zły typ każdego wymaganego pola daje invalid_type (np. tablica zamiast obiektu i odwrotnie)", () => {
  const wrongTypes = {
    summary: [null, 5, true, [], {}],
    observedPatterns: ["tekst", {}, null, 5, true],
    possibleBiases: ["tekst", {}, null, 5, true],
    alternativeExplanations: ["tekst", {}, null, 5, true],
    limitations: [null, 5, true, [], {}],
    outcomeNote: [null, 5, true, [], {}],
  };

  for (const [field, samples] of Object.entries(wrongTypes)) {
    for (const sample of samples) {
      const raw = validFull();
      raw[field] = sample;

      assertRejected(run(raw), [[field, "invalid_type"]]);
    }
  }
});

test("pola — summary pusty lub z samych odstępów daje empty_value", () => {
  for (const blank of ["", " ", "   ", "\n\t "]) {
    const raw = validFull();
    raw.summary = blank;

    assertRejected(run(raw), [["summary", "empty_value"]]);
  }
});

test("pola — limitations i outcomeNote mogą być puste lub z samych odstępów (wartość to wtedy pusty tekst)", () => {
  for (const blank of ["", "  ", "\n"]) {
    const raw = validFull();
    raw.limitations = blank;
    raw.outcomeNote = blank;

    const result = run(raw);

    assertAccepted(result);
    assert.equal(result.value.limitations, "");
    assert.equal(result.value.outcomeNote, "");
  }
});

test("pola — puste tablice są dopuszczalne (observedPatterns, possibleBiases, alternativeExplanations)", () => {
  const raw = validFull();
  raw.observedPatterns = [];
  raw.possibleBiases = [];
  raw.alternativeExplanations = [];

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(result.value.observedPatterns, []);
  assert.deepEqual(result.value.possibleBiases, []);
  assert.deepEqual(result.value.alternativeExplanations, []);
});

test("pola — elementy list tekstów: zły typ daje invalid_type, pusty tekst daje empty_value (ze wskazaniem indeksu)", () => {
  for (const field of ["observedPatterns", "alternativeExplanations"]) {
    for (const bad of [5, null, {}, [], true]) {
      const raw = validFull();
      raw[field] = ["poprawny", bad];

      assertRejected(run(raw), [[`${field}[1]`, "invalid_type"]]);
    }

    for (const blank of ["", "   "]) {
      const raw = validFull();
      raw[field] = [blank, "poprawny"];

      assertRejected(run(raw), [[`${field}[0]`, "empty_value"]]);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Wpisy possibleBiases (tylko struktura i typy — bez rozpoznawania biasów)
 * ------------------------------------------------------------------ */

test("possibleBiases — element niebędący zwykłym obiektem daje invalid_type ze wskazaniem indeksu", () => {
  for (const bad of [null, [], "tekst", 5, true]) {
    const raw = validFull();
    raw.possibleBiases = [validFull().possibleBiases[0], bad];

    assertRejected(run(raw), [["possibleBiases[1]", "invalid_type"]]);
  }
});

test("possibleBiases — brak wymaganych pól wpisu (bias, confidence, supportingEvidence) daje missing_field", () => {
  for (const field of ["bias", "confidence", "supportingEvidence"]) {
    const raw = validFull();
    delete raw.possibleBiases[0][field];

    assertRejected(run(raw), [[`possibleBiases[0].${field}`, "missing_field"]]);
  }
});

test("possibleBiases — bias niebędący niepustym tekstem daje invalid_bias", () => {
  for (const bad of [null, 123, "", "   ", [], {}, true]) {
    const raw = validFull();
    raw.possibleBiases[0].bias = bad;

    assertRejected(run(raw), [["possibleBiases[0].bias", "invalid_bias"]]);
  }
});

test("possibleBiases — confidence niebędący tekstem daje invalid_confidence (plan v1.1, sekcja 10)", () => {
  for (const bad of [null, 0.8, 123, true, [], {}]) {
    const raw = validFull();
    raw.possibleBiases[0].confidence = bad;

    assertRejected(run(raw), [
      ["possibleBiases[0].confidence", "invalid_confidence"],
    ]);
  }
});

test("possibleBiases — supportingEvidence: zły typ daje invalid_type, pusty lub same odstępy daje empty_value", () => {
  for (const bad of [null, 5, true, [], {}]) {
    const raw = validFull();
    raw.possibleBiases[0].supportingEvidence = bad;

    assertRejected(run(raw), [
      ["possibleBiases[0].supportingEvidence", "invalid_type"],
    ]);
  }

  for (const blank of ["", "  ", "\n"]) {
    const raw = validFull();
    raw.possibleBiases[0].supportingEvidence = blank;

    assertRejected(run(raw), [
      ["possibleBiases[0].supportingEvidence", "empty_value"],
    ]);
  }
});

test("possibleBiases — contradictingEvidence jest opcjonalne: brak lub pusty tekst daje pusty tekst w wyniku", () => {
  const missing = validFull();
  delete missing.possibleBiases[0].contradictingEvidence;

  const resultMissing = run(missing);
  assertAccepted(resultMissing);
  assert.equal(resultMissing.value.possibleBiases[0].contradictingEvidence, "");

  for (const blank of ["", "   "]) {
    const raw = validFull();
    raw.possibleBiases[0].contradictingEvidence = blank;

    const result = run(raw);
    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].contradictingEvidence, "");
  }
});

test("possibleBiases — contradictingEvidence o złym typie (także null) daje invalid_type", () => {
  for (const bad of [null, 5, true, [], {}]) {
    const raw = validFull();
    raw.possibleBiases[0].contradictingEvidence = bad;

    assertRejected(run(raw), [
      ["possibleBiases[0].contradictingEvidence", "invalid_type"],
    ]);
  }
});

test("possibleBiases — błędy w kilku wpisach mają poprawne indeksy w ścieżkach", () => {
  const entry = () => validFull().possibleBiases[0];
  const raw = validFull();

  raw.possibleBiases = [
    entry(),
    { ...entry(), bias: "" },
    { ...entry(), confidence: 5 },
    entry(),
  ];

  assertRejected(run(raw), [
    ["possibleBiases[1].bias", "invalid_bias"],
    ["possibleBiases[2].confidence", "invalid_confidence"],
  ]);
});

/* ------------------------------------------------------------------ *
 * Zbieranie wszystkich błędów i kształt wyniku porażki
 * ------------------------------------------------------------------ */

test("błędy — walidator zbiera wszystkie błędy naraz, a nie tylko pierwszy", () => {
  const raw = {
    // summary: brak
    observedPatterns: "to nie lista",
    possibleBiases: [{ bias: null, confidence: 5 }, "tekst"],
    // alternativeExplanations: brak
    limitations: 7,
    // outcomeNote: brak
  };

  assertRejected(run(raw), [
    ["summary", "missing_field"],
    ["observedPatterns", "invalid_type"],
    ["possibleBiases[0].bias", "invalid_bias"],
    ["possibleBiases[0].confidence", "invalid_confidence"],
    ["possibleBiases[0].supportingEvidence", "missing_field"],
    ["possibleBiases[1]", "invalid_type"],
    ["alternativeExplanations", "missing_field"],
    ["limitations", "invalid_type"],
    ["outcomeNote", "missing_field"],
  ]);
});

test("błędy — wynik porażki ma tylko pola ok i errors, a każdy błąd ma path, code i message", () => {
  const result = run({});

  assert.deepEqual(Object.keys(result).sort(), ["errors", "ok"]);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);

  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ["code", "message", "path"]);
    assert.equal(typeof error.path, "string");
    assert.ok(ERROR_CODES.includes(error.code), `nieznany kod: ${error.code}`);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
  }
});

test("błędy — komunikaty są krótkie i nie cytują wartości z odpowiedzi modelu", () => {
  const raw = validFull();
  raw.possibleBiases = "A".repeat(5000);

  const result = run(raw);

  assert.equal(result.ok, false);
  for (const error of result.errors) {
    assert.ok(error.message.length < 200, "komunikat jest zbyt długi");
    assert.ok(
      !error.message.includes("AAAA"),
      "komunikat cytuje wartość z odpowiedzi",
    );
  }
});

/* ------------------------------------------------------------------ *
 * Budowa nowego value
 * ------------------------------------------------------------------ */

test("value — to nowy obiekt: nie współdzieli referencji z wejściem, a wejście nie jest zmieniane", () => {
  const raw = validFull();
  const snapshot = JSON.parse(JSON.stringify(raw));

  const result = run(raw);
  assertAccepted(result);

  assert.notEqual(result.value, raw);
  assert.notEqual(result.value.observedPatterns, raw.observedPatterns);
  assert.notEqual(result.value.possibleBiases, raw.possibleBiases);
  assert.notEqual(result.value.possibleBiases[0], raw.possibleBiases[0]);
  assert.notEqual(
    result.value.alternativeExplanations,
    raw.alternativeExplanations,
  );

  // zmiana wyniku nie może zmienić wejścia
  result.value.summary = "zmienione";
  result.value.observedPatterns.push("dopisane");
  result.value.possibleBiases[0].bias = "zmieniony";

  assert.deepEqual(raw, snapshot);
});

test("value — głęboko zamrożone wejście jest przyjmowane i niezmieniane (walidator niczego w nim nie zapisuje)", () => {
  const raw = deepFreeze(validFull());

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(result.value, validFull());
  assert.deepEqual(raw, validFull());
});

test("value — zawiera wyłącznie pola kontraktu (pola spoza kontraktu nie są przepisywane)", () => {
  const raw = validFull();
  raw.obcePole = "x";
  raw.analyzedAt = "2020-01-01";
  raw.possibleBiases[0].proposedLabel = "cokolwiek";
  raw.possibleBiases[0].obcePole = 1;

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(
    Object.keys(result.value).sort(),
    [...REQUIRED_FIELDS].sort(),
  );
  assert.deepEqual(Object.keys(result.value.possibleBiases[0]).sort(), [
    "bias",
    "confidence",
    "contradictingEvidence",
    "supportingEvidence",
  ]);
});

test("value — teksty swobodne są przycinane na brzegach (zawartość nie jest zmieniana)", () => {
  const raw = validFull();
  raw.summary = "  Podsumowanie.\n";
  raw.observedPatterns = ["  wzorzec 1  "];
  raw.alternativeExplanations = ["\talternatywa\n"];
  raw.limitations = " ograniczenia ";
  raw.outcomeNote = "\nnotatka\n";
  raw.possibleBiases[0].supportingEvidence = "  dowód \n ciąg dalszy  ";
  raw.possibleBiases[0].contradictingEvidence = " kontrdowód ";

  const result = run(raw);

  assertAccepted(result);
  assert.equal(result.value.summary, "Podsumowanie.");
  assert.deepEqual(result.value.observedPatterns, ["wzorzec 1"]);
  assert.deepEqual(result.value.alternativeExplanations, ["alternatywa"]);
  assert.equal(result.value.limitations, "ograniczenia");
  assert.equal(result.value.outcomeNote, "notatka");
  assert.equal(
    result.value.possibleBiases[0].supportingEvidence,
    "dowód \n ciąg dalszy",
  );
  assert.equal(
    result.value.possibleBiases[0].contradictingEvidence,
    "kontrdowód",
  );
});

test("value — nazwa kanoniczna z taksonomii i poprawny confidence przechodzą bez zmian", () => {
  const result = run(validFull());

  assertAccepted(result);
  assert.equal(result.value.possibleBiases[0].bias, "niechęć do straty");
  assert.equal(result.value.possibleBiases[0].confidence, "medium");
});

/* ================================================================== *
 * KROK 4 — normalizeToken i confidence (D4)
 * ================================================================== */

/** Wpis possibleBiases z możliwością nadpisania pól. */
function biasEntry(overrides = {}) {
  return {
    bias: "niechęć do straty",
    confidence: "medium",
    supportingEvidence: "Dowód.",
    contradictingEvidence: "",
    ...overrides,
  };
}

function runWithEntries(entries) {
  const raw = validFull();
  raw.possibleBiases = entries;
  return run(raw);
}

const warningPairs = (warnings) =>
  warnings.map((warning) => `${warning.path} | ${warning.code}`).sort();

const WARNING_CODES = [
  "confidence_normalized",
  "bias_unmapped",
  "other_bias_no_label",
  "duplicate_bias",
  "unknown_field_removed",
  "backend_field_removed",
];

/* ---------------------------- normalizeToken ---------------------------- */

test("normalizeToken — zamienia litery na małe, także polskie wielkie litery", () => {
  assert.equal(normalizeToken("NIECHĘĆ DO STRATY"), "niechęć do straty");
  assert.equal(normalizeToken("ŁÓDŹ ŻÓŁĆ ĄĘŚŃ"), "łódź żółć ąęśń");
  assert.equal(normalizeToken("Confirmation Bias"), "confirmation bias");
});

test("normalizeToken — Unicode NFC: zapis rozłożony polskich znaków daje ten sam wynik co złożony", () => {
  const decomposed = "niech" + "e\u0328" + "c\u0301" + " do straty"; // ę = e + ogonek, ć = c + akcent
  const composed = "niechęć do straty";

  assert.notEqual(
    decomposed,
    composed,
    "dane testowe muszą się różnić zapisem",
  );
  assert.equal(normalizeToken(decomposed), composed);
  assert.equal(
    normalizeToken("a\u0328 o\u0301 z\u0307 s\u0301 n\u0301"),
    "ą ó ż ś ń",
  );
});

test("normalizeToken — zbija odstępy: spacje, tabulatory, nowe linie, twarde spacje i inne spacje Unicode", () => {
  assert.equal(
    normalizeToken("  \t\nniechęć\u00a0\u00a0do \u2003 straty\r\n"),
    "niechęć do straty",
  );
  assert.equal(normalizeToken("a\u3000b\u202fc\u2009d"), "a b c d");
  assert.equal(normalizeToken("\u00a0 \t medium \n"), "medium");
});

test("normalizeToken — krzywe apostrofy zamienia na zwykły apostrof", () => {
  for (const apostrophe of ["\u2019", "\u2018", "\u02bc"]) {
    assert.equal(
      normalizeToken(`Gambler${apostrophe}s Fallacy`),
      "gambler's fallacy",
    );
  }
});

test("normalizeToken — wszystkie warianty myślnika zamienia na zwykły łącznik", () => {
  for (const dash of [
    "\u2010",
    "\u2011",
    "\u2012",
    "\u2013",
    "\u2014",
    "\u2015",
    "\u2212",
  ]) {
    assert.equal(normalizeToken(`self${dash}attribution`), "self-attribution");
  }
});

test("normalizeToken — zachowuje polskie znaki diakrytyczne (nie zamienia ich na ASCII)", () => {
  assert.equal(
    normalizeToken("Błąd Wstecznej Wiedzy"),
    "błąd wstecznej wiedzy",
  );
  assert.notEqual(normalizeToken("błąd"), "blad");
  assert.equal(normalizeToken("żółć"), "żółć");
});

test("normalizeToken — nie usuwa interpunkcji i nie utożsamia łącznika ze spacją", () => {
  assert.equal(normalizeToken("A, B (c) d."), "a, b (c) d.");
  assert.equal(normalizeToken("sympatii/afiliacji"), "sympatii/afiliacji");
  assert.notEqual(
    normalizeToken("under-diversification"),
    normalizeToken("under diversification"),
  );
});

test("normalizeToken — jest idempotentny (ponowna normalizacja niczego nie zmienia)", () => {
  const samples = [
    "  NIECHĘĆ\u00a0DO STRATY ",
    "Gambler\u2019s Fallacy",
    "Self\u2013Attribution Bias",
    "e\u0328 c\u0301",
    "İSTANBUL",
    "",
    "medium",
  ];

  for (const sample of samples) {
    const once = normalizeToken(sample);
    assert.equal(normalizeToken(once), once, JSON.stringify(sample));
  }
});

test("normalizeToken — pusty tekst i same odstępy dają pusty tekst", () => {
  assert.equal(normalizeToken(""), "");
  assert.equal(normalizeToken("  \t\n\u00a0 "), "");
});

test("normalizeToken — wartość niebędąca tekstem to błąd programisty (TypeError)", () => {
  for (const bad of [null, undefined, 5, true, {}, [], () => "x"]) {
    assert.throws(() => normalizeToken(bad), TypeError);
  }
});

test("normalizeLabel (etykieta nieznanego biasu, U8) — zachowuje wielkość liter i znaki, zbija tylko odstępy i stosuje NFC", () => {
  assert.equal(
    normalizeLabel("  Investor\u2019s\tRegret \u2013  Variant \n"),
    "Investor\u2019s Regret \u2013 Variant",
  );
  assert.equal(
    normalizeLabel("FOMO związane z AI Stocks"),
    "FOMO związane z AI Stocks",
  );
  assert.equal(normalizeLabel("X" + "e\u0328"), "Xę");
  assert.equal(normalizeLabel("a\u00a0\u00a0b"), "a b");

  for (const bad of [null, undefined, 5, {}]) {
    assert.throws(() => normalizeLabel(bad), TypeError);
  }
});

test("teksty swobodne — nadal tylko przycięte na brzegach: bez małych liter i bez normalizacji tokenów", () => {
  const messy = "  Duży  SPADEK\u00a0ceny \u2019test\u2019 \u2013 Błąd \n";
  const expected = "Duży  SPADEK\u00a0ceny \u2019test\u2019 \u2013 Błąd";

  const raw = validFull();
  raw.summary = messy;
  raw.observedPatterns = [messy];
  raw.alternativeExplanations = [messy];
  raw.limitations = messy;
  raw.outcomeNote = messy;
  raw.possibleBiases[0].supportingEvidence = messy;
  raw.possibleBiases[0].contradictingEvidence = messy;

  const result = run(raw);

  assertAccepted(result);
  assert.equal(result.value.summary, expected);
  assert.deepEqual(result.value.observedPatterns, [expected]);
  assert.deepEqual(result.value.alternativeExplanations, [expected]);
  assert.equal(result.value.limitations, expected);
  assert.equal(result.value.outcomeNote, expected);
  assert.equal(result.value.possibleBiases[0].supportingEvidence, expected);
  assert.equal(result.value.possibleBiases[0].contradictingEvidence, expected);
});

/* ------------------------------ confidence ------------------------------ */

test("confidence — poprawne low, medium, high przechodzą bez ostrzeżeń", () => {
  for (const confidence of ["low", "medium", "high"]) {
    const result = runWithEntries([biasEntry({ confidence })]);

    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].confidence, confidence);
    assert.deepEqual(result.warnings, [], confidence);
  }
});

test("confidence — inny zapis (wielkość liter, odstępy, twarde spacje) jest normalizowany, z ostrzeżeniem confidence_normalized", () => {
  const variants = [
    ["Medium", "medium"],
    ["MEDIUM", "medium"],
    [" medium ", "medium"],
    ["\tHigh\n", "high"],
    ["LOW", "low"],
    ["\u00a0low\u00a0", "low"],
    ["  HiGh  ", "high"],
  ];

  for (const [input, expected] of variants) {
    const result = runWithEntries([biasEntry({ confidence: input })]);

    assertAccepted(result);
    assert.equal(
      result.value.possibleBiases[0].confidence,
      expected,
      JSON.stringify(input),
    );
    assert.deepEqual(
      warningPairs(result.warnings),
      ["possibleBiases[0].confidence | confidence_normalized"],
      JSON.stringify(input),
    );
  }
});

test("confidence — ostrzeżenie tylko wtedy, gdy zapis wejściowy rzeczywiście się zmienił (i ze wskazaniem właściwego wpisu)", () => {
  // Różne biasy w każdym wpisie, żeby ostrzeżenia o duplikatach (krok 5)
  // nie mieszały się z tym, co sprawdza ten test.
  const result = runWithEntries([
    biasEntry({ bias: "niechęć do straty", confidence: "low" }),
    biasEntry({ bias: "efekt stadny", confidence: "High" }),
    biasEntry({ bias: "błąd potwierdzenia", confidence: "medium" }),
    biasEntry({ bias: "zakotwiczenie", confidence: " medium" }),
  ]);

  assertAccepted(result);
  assert.deepEqual(
    result.value.possibleBiases.map((entry) => entry.confidence),
    ["low", "high", "medium", "medium"],
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1].confidence | confidence_normalized",
    "possibleBiases[3].confidence | confidence_normalized",
  ]);
});

test("confidence — wartości niejednoznaczne lub spoza zbioru daje invalid_confidence (backend ich nie zgaduje)", () => {
  const rejected = [
    "very high",
    "bardzo pewny",
    "średni",
    "wysoki",
    "0.8",
    0.8,
    123,
    0,
    true,
    false,
    null,
    "",
    "   ",
    [],
    ["medium"],
    {},
    { value: "medium" },
    "med",
    "mediu m",
    "medium.",
    "medium!",
    "medium high",
    "high-ish",
    "HIGH?",
    "l",
    "lo w",
  ];

  for (const confidence of rejected) {
    assertRejected(runWithEntries([biasEntry({ confidence })]), [
      ["possibleBiases[0].confidence", "invalid_confidence"],
    ]);
  }
});

test("confidence — brak pola nadal daje missing_field (a nie invalid_confidence)", () => {
  const entry = biasEntry();
  delete entry.confidence;

  assertRejected(runWithEntries([entry]), [
    ["possibleBiases[0].confidence", "missing_field"],
  ]);
});

test("confidence — jeden błędny wpis odrzuca całą odpowiedź (bez value i bez ostrzeżeń), także gdy reszta jest poprawna", () => {
  const result = runWithEntries([
    biasEntry({ confidence: "Medium" }),
    biasEntry({ confidence: "very high" }),
    biasEntry({ confidence: "low" }),
  ]);

  assertRejected(result, [
    ["possibleBiases[1].confidence", "invalid_confidence"],
  ]);
  assert.deepEqual(Object.keys(result).sort(), ["errors", "ok"]);
});

test("confidence — błędna wartość nie jest 'naprawiana' do najbliższej poprawnej", () => {
  const result = runWithEntries([biasEntry({ confidence: "very high" })]);

  assert.equal(result.ok, false);
  assert.equal(result.value, undefined);
});

/* ================================================================== *
 * KROK 5 — resolveBias, proposedLabel, other_bias_no_label, duplikaty
 * ================================================================== */

const ALIAS_OWNER = new Map();
for (const entry of BIAS_LIST) {
  ALIAS_OWNER.set(entry.name, entry.name);
  for (const alias of entry.aliases) ALIAS_OWNER.set(alias, entry.name);
}

/* ------------------------------ resolveBias ------------------------------ */

test("resolveBias — nazwa kanoniczna, alias, fallback podany wprost i nazwa nieznana", () => {
  assert.deepEqual(resolveBias("błąd potwierdzenia"), {
    bias: "błąd potwierdzenia",
    match: "canonical",
  });

  assert.deepEqual(resolveBias("Confirmation Bias"), {
    bias: "błąd potwierdzenia",
    match: "alias",
  });

  assert.deepEqual(resolveBias(" Inne / Nieskatalogowane "), {
    bias: OTHER_BIAS,
    match: "other",
  });

  assert.deepEqual(resolveBias("  XYZ   Bias "), {
    bias: OTHER_BIAS,
    match: "unknown",
    proposedLabel: "XYZ Bias",
  });
});

test("resolveBias — wartość niebędąca tekstem to błąd programisty (TypeError)", () => {
  for (const bad of [null, undefined, 5, {}, []]) {
    assert.throws(() => resolveBias(bad), TypeError);
  }
});

/* --------------------- nazwy kanoniczne i aliasy (D3) --------------------- */

test("bias — każda nazwa kanoniczna z taksonomii zostaje bez zmian, bez proposedLabel i bez ostrzeżeń", () => {
  for (const { name } of BIAS_LIST) {
    const result = runWithEntries([biasEntry({ bias: name })]);

    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].bias, name);
    assert.equal(
      Object.hasOwn(result.value.possibleBiases[0], "proposedLabel"),
      false,
    );
    assert.deepEqual(result.warnings, [], name);
  }
});

test("bias — każdy zatwierdzony alias (EN i PL) daje nazwę kanoniczną swojego biasu, bez ostrzeżeń", () => {
  let checked = 0;

  for (const [term, owner] of ALIAS_OWNER) {
    const result = runWithEntries([biasEntry({ bias: term })]);

    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].bias, owner, `alias "${term}"`);
    assert.equal(
      Object.hasOwn(result.value.possibleBiases[0], "proposedLabel"),
      false,
    );
    assert.deepEqual(result.warnings, [], `alias "${term}"`);
    checked += 1;
  }

  assert.equal(checked, 35 + 143);
});

test("bias — przykłady z planu: alias → nazwa kanoniczna", () => {
  const examples = [
    ["Confirmation Bias", "błąd potwierdzenia"],
    ["confirmation bias", "błąd potwierdzenia"],
    ["efekt potwierdzania", "błąd potwierdzenia"],
    ["disposition effect", "efekt dyspozycji"],
    ["awersja do strat", "niechęć do straty"],
    ["Loss Aversion", "niechęć do straty"],
  ];

  for (const [input, expected] of examples) {
    const result = runWithEntries([biasEntry({ bias: input })]);

    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].bias, expected, input);
  }
});

test("bias — wielkość liter, odstępy, polskie znaki i krzywe znaki są normalizowane przed szukaniem", () => {
  const variants = [
    ["  BŁĄD   POTWIERDZENIA ", "błąd potwierdzenia"],
    ["Błąd potwierdzenia", "błąd potwierdzenia"],
    ["BŁĄD\tPOTWIERDZENIA", "błąd potwierdzenia"],
    ["błąd\u00a0potwierdzenia", "błąd potwierdzenia"],
    ["błąd\npotwierdzenia", "błąd potwierdzenia"],
    [" CONFIRMATION   BIAS ", "błąd potwierdzenia"],
    ["NIECHĘĆ DO STRATY", "niechęć do straty"],
    ["niech" + "e\u0328" + "c\u0301" + " do straty", "niechęć do straty"],
    ["Gambler\u2019s Fallacy", "błąd hazardzisty"],
    ["GAMBLER\u2018S FALLACY", "błąd hazardzisty"],
    ["Self\u2013Attribution Bias", "błąd atrybucji własnych sukcesów"],
    ["Self\u2014attribution bias", "błąd atrybucji własnych sukcesów"],
    ["Under\u2010Diversification", "niedostateczna dywersyfikacja"],
    ["Monte Carlo Fallacy", "błąd hazardzisty"],
    ["AWERSJA DO STRAT", "niechęć do straty"],
  ];

  for (const [input, expected] of variants) {
    const result = runWithEntries([biasEntry({ bias: input })]);

    assertAccepted(result);
    assert.equal(
      result.value.possibleBiases[0].bias,
      expected,
      JSON.stringify(input),
    );
    assert.deepEqual(result.warnings, [], JSON.stringify(input));
  }
});

/* ------------------- nieznany bias → fallback + proposedLabel ------------------- */

test("bias — brak fuzzy matching: podobnie brzmiące i usunięte z listy pojęcia NIE są mapowane", () => {
  const notMapped = [
    "awersja do ryzyka",
    "niechęć do ryzyka",
    "risk aversion",
    "FOMO",
    "FOMO związane z AI stocks",
    "fear of missing out",
    "confirmation",
    "outcome",
    "availability",
    "recency",
    "framing",
    "familiarity",
    "affinity",
    "conservatism",
    "knew it all along",
    "gambling preference",
    "trade-by-trade evaluation",
    "underreaction to new information",
    "inattention to news",
    "certainty overconfidence",
    "błąd potwierdzenia.",
    "błąd potwierdzenia!",
    "blad potwierdzenia",
    "niechec do straty",
    "niechęć do straty i zysku",
    "bardzo silna niechęć do straty",
    "confirmation biases",
    "inne/nieskatalogowane",
    "xyz bias",
  ];

  for (const input of notMapped) {
    const result = runWithEntries([biasEntry({ bias: input })]);

    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].bias, OTHER_BIAS, input);
    assert.equal(result.value.possibleBiases[0].proposedLabel, input, input);
    assert.deepEqual(
      warningPairs(result.warnings),
      ["possibleBiases[0].bias | bias_unmapped"],
      input,
    );
  }
});

test("bias — przykłady z planu: nieznany bias → fallback + proposedLabel z oryginalną nazwą", () => {
  const result = runWithEntries([
    biasEntry({ bias: "FOMO związane z AI stocks" }),
    biasEntry({ bias: "xyz bias", confidence: "low" }),
  ]);

  assertAccepted(result);
  assert.deepEqual(
    result.value.possibleBiases.map(({ bias, proposedLabel }) => ({
      bias,
      proposedLabel,
    })),
    [
      { bias: OTHER_BIAS, proposedLabel: "FOMO związane z AI stocks" },
      { bias: OTHER_BIAS, proposedLabel: "xyz bias" },
    ],
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0].bias | bias_unmapped",
    "possibleBiases[1].bias | bias_unmapped",
  ]);
});

test("proposedLabel (U8) — oryginalna pisownia i wielkość liter, odstępy zbite do jednej spacji, bez spacji na brzegach, NFC", () => {
  const result = runWithEntries([
    biasEntry({
      bias: "  Xyz\u00a0 BIAS  of\tthe \u2019Investor\u2019 \u2013 variant\n",
    }),
    biasEntry({ bias: "Xe\u0328 Effect" }),
  ]);

  assertAccepted(result);
  assert.equal(
    result.value.possibleBiases[0].proposedLabel,
    "Xyz BIAS of the \u2019Investor\u2019 \u2013 variant",
  );
  assert.equal(result.value.possibleBiases[1].proposedLabel, "Xę Effect");
});

test("proposedLabel — tworzy go wyłącznie walidator: pole podane przez Gemini nie ma wpływu na wynik", () => {
  // przykład z ustaleń: model próbuje sterować etykietą
  const unknown = runWithEntries([
    biasEntry({ bias: "efekt XYZ", proposedLabel: "potwierdzenie" }),
  ]);

  assertAccepted(unknown);
  assert.equal(unknown.value.possibleBiases[0].bias, OTHER_BIAS);
  assert.equal(unknown.value.possibleBiases[0].proposedLabel, "efekt XYZ");

  // przy znanym biasie podana etykieta nie trafia do wyniku
  const known = runWithEntries([
    biasEntry({ bias: "Confirmation Bias", proposedLabel: "cokolwiek" }),
  ]);

  assertAccepted(known);
  assert.equal(known.value.possibleBiases[0].bias, "błąd potwierdzenia");
  assert.equal(
    Object.hasOwn(known.value.possibleBiases[0], "proposedLabel"),
    false,
  );

  // przy fallbacku podanym wprost też nie
  const other = runWithEntries([
    biasEntry({ bias: OTHER_BIAS, proposedLabel: "cokolwiek" }),
  ]);

  assertAccepted(other);
  assert.equal(
    Object.hasOwn(other.value.possibleBiases[0], "proposedLabel"),
    false,
  );
});

test("proposedLabel — bardzo długa nazwa nieznanego biasu jest zachowana w całości (D5: brak limitów), a komunikat jej nie cytuje", () => {
  const longName = "Q".repeat(100000);
  const result = runWithEntries([biasEntry({ bias: longName })]);

  assertAccepted(result);
  assert.equal(result.value.possibleBiases[0].proposedLabel.length, 100000);

  for (const warning of result.warnings) {
    assert.ok(warning.message.length < 200);
    assert.ok(!warning.message.includes("QQQQ"));
  }
});

/* ------------------ fallback podany wprost → other_bias_no_label ------------------ */

test("bias — 'inne / nieskatalogowane' podane bez własnej nazwy jest przyjęte z ostrzeżeniem other_bias_no_label", () => {
  for (const input of [
    OTHER_BIAS,
    "Inne / Nieskatalogowane",
    " inne  /  nieskatalogowane \n",
  ]) {
    const result = runWithEntries([biasEntry({ bias: input })]);

    assertAccepted(result);
    assert.equal(result.value.possibleBiases[0].bias, OTHER_BIAS);
    assert.equal(
      Object.hasOwn(result.value.possibleBiases[0], "proposedLabel"),
      false,
    );
    assert.deepEqual(
      warningPairs(result.warnings),
      ["possibleBiases[0].bias | other_bias_no_label"],
      JSON.stringify(input),
    );
  }
});

/* ------------------------ nadal obowiązujące błędy bias ------------------------ */

test("bias — pusty lub niebędący tekstem bias nadal daje invalid_bias (rozpoznawanie biasów tego nie zmienia)", () => {
  for (const bad of [null, 123, "", "   ", [], {}, true]) {
    assertRejected(runWithEntries([biasEntry({ bias: bad })]), [
      ["possibleBiases[0].bias", "invalid_bias"],
    ]);
  }
});

/* ----------------------- duplikaty w pełnej analizie ----------------------- */

test("duplikaty — ten sam bias zapisany nazwą i aliasem: oba wpisy zostają, ostrzeżenie duplicate_bias przy późniejszym", () => {
  const result = runWithEntries([
    biasEntry({ bias: "błąd potwierdzenia", supportingEvidence: "Dowód A." }),
    biasEntry({ bias: "Confirmation Bias", supportingEvidence: "Dowód B." }),
  ]);

  assertAccepted(result);
  assert.equal(result.value.possibleBiases.length, 2);
  assert.deepEqual(
    result.value.possibleBiases.map((entry) => [
      entry.bias,
      entry.supportingEvidence,
    ]),
    [
      ["błąd potwierdzenia", "Dowód A."],
      ["błąd potwierdzenia", "Dowód B."],
    ],
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1].bias | duplicate_bias",
  ]);
});

test("duplikaty — trzy wystąpienia dają dwa ostrzeżenia (po jednym dla każdego powtórzenia) i wszystkie wpisy zostają", () => {
  const result = runWithEntries([
    biasEntry({ bias: "efekt stadny" }),
    biasEntry({ bias: "Herding" }),
    biasEntry({ bias: "owczy pęd" }),
  ]);

  assertAccepted(result);
  assert.equal(result.value.possibleBiases.length, 3);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1].bias | duplicate_bias",
    "possibleBiases[2].bias | duplicate_bias",
  ]);
});

test("duplikaty — ta sama nieznana nazwa (bez względu na wielkość liter) to duplikat, różne nieznane nazwy nie", () => {
  const same = runWithEntries([
    biasEntry({ bias: "Xyz Bias" }),
    biasEntry({ bias: "  XYZ   bias " }),
  ]);

  assertAccepted(same);
  assert.equal(same.value.possibleBiases.length, 2);
  assert.deepEqual(warningPairs(same.warnings), [
    "possibleBiases[0].bias | bias_unmapped",
    "possibleBiases[1].bias | bias_unmapped",
    "possibleBiases[1].bias | duplicate_bias",
  ]);

  const different = runWithEntries([
    biasEntry({ bias: "Xyz Bias" }),
    biasEntry({ bias: "Abc Bias" }),
  ]);

  assertAccepted(different);
  assert.deepEqual(warningPairs(different.warnings), [
    "possibleBiases[0].bias | bias_unmapped",
    "possibleBiases[1].bias | bias_unmapped",
  ]);
});

test("duplikaty — dwa fallbacki podane wprost bez nazwy to duplikat", () => {
  const result = runWithEntries([
    biasEntry({ bias: OTHER_BIAS }),
    biasEntry({ bias: "Inne / nieskatalogowane" }),
  ]);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0].bias | other_bias_no_label",
    "possibleBiases[1].bias | duplicate_bias",
    "possibleBiases[1].bias | other_bias_no_label",
  ]);
});

test("duplikaty — różne biasy nie dają ostrzeżenia, a nieznany bias i znany bias o podobnej nazwie nie są duplikatami", () => {
  const result = runWithEntries([
    biasEntry({ bias: "błąd potwierdzenia" }),
    biasEntry({ bias: "niechęć do straty" }),
    biasEntry({ bias: "błąd potwierdzenia!" }),
  ]);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[2].bias | bias_unmapped",
  ]);
});

test("ostrzeżenia — mają kształt { path, code, message }, znane kody i są zwracane tylko przy ok:true", () => {
  const ok = runWithEntries([
    biasEntry({ bias: "xyz", confidence: "HIGH" }),
    biasEntry({ bias: "xyz" }),
    biasEntry({ bias: OTHER_BIAS }),
  ]);

  assertAccepted(ok);
  assert.ok(ok.warnings.length >= 4);

  for (const warning of ok.warnings) {
    assert.deepEqual(Object.keys(warning).sort(), ["code", "message", "path"]);
    assert.ok(
      WARNING_CODES.includes(warning.code),
      `nieznany kod: ${warning.code}`,
    );
    assert.equal(typeof warning.message, "string");
    assert.ok(warning.message.length > 0);
  }

  const rejected = runWithEntries([
    biasEntry({ bias: "xyz", confidence: "HIGH" }),
    biasEntry({ bias: "xyz", confidence: "very high" }),
  ]);

  assert.equal(rejected.ok, false);
  assert.deepEqual(Object.keys(rejected).sort(), ["errors", "ok"]);
});

test("krok 5 — wpisy bez błędów zachowują kolejność pól: bias, proposedLabel (tylko dla fallbacku), confidence, supportingEvidence, contradictingEvidence", () => {
  const result = runWithEntries([biasEntry({ bias: "xyz" }), biasEntry()]);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value.possibleBiases[0]), [
    "bias",
    "proposedLabel",
    "confidence",
    "supportingEvidence",
    "contradictingEvidence",
  ]);
  assert.deepEqual(Object.keys(result.value.possibleBiases[1]), [
    "bias",
    "confidence",
    "supportingEvidence",
    "contradictingEvidence",
  ]);
});

/* ================================================================== *
 * KROK 6 — lista dozwolonych pól, pola obce, pola backendu, pola wyliczane
 * ================================================================== */

// Lista z sekcji 11 planu v1.1 (zapisana niezależnie od kodu, żeby test
// wykrył jej przypadkową zmianę) + 3 nazwy dopisane w Etapie 8.7.5
// (plan Etapu 8, sekcja 6.4 i zadanie 8.7.5): identyfikatory uruchomienia.
const PLAN_BACKEND_FIELDS = [
  "analyzedAt",
  "analysisType",
  "aiModelVersion",
  "promptVersion",
  "marketContextSnapshot",
  "inputSnapshot",
  "_id",
  "userId",
  "positionId",
  "createdAt",
  "updatedAt",
  // Etap 8.7.5
  "analysisRunId",
  "runStartedAt",
  "lastAnalysisRunId",
];

const PLAN_DERIVED_FIELDS = ["proposedLabel", "proposedBiasLabels"];

const FULL_TOP_KEYS = [...REQUIRED_FIELDS].sort();
const FULL_ENTRY_KEYS = [
  "bias",
  "confidence",
  "contradictingEvidence",
  "supportingEvidence",
];

test("krok 6 — BACKEND_OWNED_FIELDS i DERIVED_FIELDS są wyeksportowane, zamrożone i zgodne z sekcją 11 planu", () => {
  assert.deepEqual(
    [...BACKEND_OWNED_FIELDS].sort(),
    [...PLAN_BACKEND_FIELDS].sort(),
  );
  assert.deepEqual([...DERIVED_FIELDS].sort(), [...PLAN_DERIVED_FIELDS].sort());
  assert.ok(Object.isFrozen(BACKEND_OWNED_FIELDS));
  assert.ok(Object.isFrozen(DERIVED_FIELDS));
});

/* ----------------------------- pola obce ----------------------------- */

test("pola obce — na poziomie głównym: nie trafiają do value, każde daje unknown_field_removed", () => {
  const raw = validFull();
  raw.obcePole = "x";
  raw.drugiePole = { zagniezdzone: true };
  raw.trzecie = [1, 2, 3];

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS);
  assert.deepEqual(warningPairs(result.warnings), [
    "drugiePole | unknown_field_removed",
    "obcePole | unknown_field_removed",
    "trzecie | unknown_field_removed",
  ]);
});

test("pola obce — we wpisie possibleBiases[]: ścieżka wskazuje właściwy wpis, a wpis ma tylko pola kontraktu", () => {
  const raw = validFull();
  raw.possibleBiases = [
    biasEntry(),
    biasEntry({ bias: "efekt stadny", obcePole: 1, kolejne: "x" }),
  ];

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(
    Object.keys(result.value.possibleBiases[1]).sort(),
    FULL_ENTRY_KEYS,
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1].kolejne | unknown_field_removed",
    "possibleBiases[1].obcePole | unknown_field_removed",
  ]);
});

test("pola obce — pola z innego kontraktu (np. pola quickCheck lub inne nieznane) też są obce w pełnej analizie", () => {
  const raw = validFull();
  raw.confidence = "high"; // pole wpisu podane na górze odpowiedzi
  raw.possibleBiases[0].observedPatterns = ["x"]; // pole z góry podane we wpisie

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), [
    "confidence | unknown_field_removed",
    "possibleBiases[0].observedPatterns | unknown_field_removed",
  ]);
});

test("pola obce — __proto__, constructor i prototype (z tekstu JSON) są zwykłymi polami obcymi i nie trafiają do wyniku", () => {
  const text = JSON.stringify(validFull()).replace(
    "{",
    '{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":[1],',
  );

  const entryText = JSON.stringify({
    ...validFull(),
    possibleBiases: [biasEntry()],
  }).replace(
    '"bias":"niechęć do straty",',
    '"__proto__":{"polluted":true},"constructor":"c","prototype":"p","bias":"niechęć do straty",',
  );

  for (const input of [text, entryText]) {
    const result = run(input);

    assertAccepted(result);
    assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS);
    assert.deepEqual(
      Object.keys(result.value.possibleBiases[0]).sort(),
      FULL_ENTRY_KEYS,
    );
    assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
    assert.equal(Object.hasOwn(result.value, "__proto__"), false);
    assert.equal({}.polluted, undefined);
  }

  const topResult = run(text);
  assert.deepEqual(warningPairs(topResult.warnings), [
    "__proto__ | unknown_field_removed",
    "constructor | unknown_field_removed",
    "prototype | unknown_field_removed",
  ]);

  const entryResult = run(entryText);
  assert.deepEqual(warningPairs(entryResult.warnings), [
    "possibleBiases[0].__proto__ | unknown_field_removed",
    "possibleBiases[0].constructor | unknown_field_removed",
    "possibleBiases[0].prototype | unknown_field_removed",
  ]);
});

/* ----------------------------- pola backendu ----------------------------- */

test("pola backendu — każde z listy planu na poziomie głównym jest usuwane z backend_field_removed", () => {
  for (const field of PLAN_BACKEND_FIELDS) {
    const raw = validFull();
    raw[field] =
      field === "marketContextSnapshot" || field === "inputSnapshot"
        ? { a: 1 }
        : "podrobiona wartość";

    const result = run(raw);

    assertAccepted(result);
    assert.equal(Object.hasOwn(result.value, field), false, field);
    assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS, field);
    assert.deepEqual(
      warningPairs(result.warnings),
      [`${field} | backend_field_removed`],
      field,
    );
  }
});

test("pola backendu — każde z listy planu we wpisie possibleBiases[] jest usuwane z backend_field_removed", () => {
  for (const field of PLAN_BACKEND_FIELDS) {
    const result = runWithEntries([
      biasEntry({ [field]: "podrobiona wartość" }),
    ]);

    assertAccepted(result);
    assert.equal(
      Object.hasOwn(result.value.possibleBiases[0], field),
      false,
      field,
    );
    assert.deepEqual(
      Object.keys(result.value.possibleBiases[0]).sort(),
      FULL_ENTRY_KEYS,
      field,
    );
    assert.deepEqual(
      warningPairs(result.warnings),
      [`possibleBiases[0].${field} | backend_field_removed`],
      field,
    );
  }
});

test("pola backendu (8.7.5) — analysisRunId, runStartedAt i lastAnalysisRunId od modelu są usuwane z backend_field_removed (nie unknown_field_removed), w obu rodzajach i w tekście JSON", () => {
  const RUN_FIELDS = ["analysisRunId", "runStartedAt", "lastAnalysisRunId"];

  for (const field of RUN_FIELDS) {
    // pełna analiza — poziom główny, jako obiekt i jako tekst JSON
    const full = validFull();
    full[field] = "podrobione-uruchomienie";

    for (const input of [full, JSON.stringify(full)]) {
      const result = run(input);

      assertAccepted(result);
      assert.equal(Object.hasOwn(result.value, field), false, field);
      assert.deepEqual(
        warningPairs(result.warnings),
        [`${field} | backend_field_removed`],
        field,
      );
    }

    // quick-check
    const quick = validQuick();
    quick[field] = "podrobione-uruchomienie";
    const quickResult = runQuick(quick);

    assertAccepted(quickResult);
    assert.equal(Object.hasOwn(quickResult.value, field), false, field);
    assert.deepEqual(
      warningPairs(quickResult.warnings),
      [`${field} | backend_field_removed`],
      field,
    );
  }

  // wszystkie trzy naraz — jeden kod na każde pole, nic nie trafia do wyniku
  const all = validFull();
  for (const field of RUN_FIELDS) all[field] = { zagniezdzone: true };

  const result = run(all);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS);
  assert.deepEqual(warningPairs(result.warnings), [
    "analysisRunId | backend_field_removed",
    "lastAnalysisRunId | backend_field_removed",
    "runStartedAt | backend_field_removed",
  ]);
});

test("pola backendu — pole backendu i pole obce w jednej odpowiedzi dostają różne kody ostrzeżeń", () => {
  const raw = validFull();
  raw.analyzedAt = "2020-01-01";
  raw.cosInnego = 1;

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), [
    "analyzedAt | backend_field_removed",
    "cosInnego | unknown_field_removed",
  ]);
});

/* -------------------- pola wyliczane: proposedLabel / proposedBiasLabels -------------------- */

test("pola wyliczane — przykład z ustaleń: efekt XYZ + proposedLabel od Gemini → fallback, własna etykieta walidatora i ostrzeżenie", () => {
  const result = runWithEntries([
    biasEntry({ bias: "efekt XYZ", proposedLabel: "potwierdzenie" }),
  ]);

  assertAccepted(result);
  assert.equal(result.value.possibleBiases[0].bias, OTHER_BIAS);
  assert.equal(result.value.possibleBiases[0].proposedLabel, "efekt XYZ");
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0].bias | bias_unmapped",
    "possibleBiases[0].proposedLabel | backend_field_removed",
  ]);
});

test("pola wyliczane — przy znanym biasie podane przez Gemini proposedLabel jest usuwane, a własnego walidator nie tworzy", () => {
  const result = runWithEntries([
    biasEntry({ bias: "Confirmation Bias", proposedLabel: "cokolwiek" }),
  ]);

  assertAccepted(result);
  assert.equal(result.value.possibleBiases[0].bias, "błąd potwierdzenia");
  assert.equal(
    Object.hasOwn(result.value.possibleBiases[0], "proposedLabel"),
    false,
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0].proposedLabel | backend_field_removed",
  ]);
});

test("pola wyliczane — fallback podany wprost z proposedLabel od Gemini: etykieta usunięta, nie ma własnej do wyliczenia", () => {
  const result = runWithEntries([
    biasEntry({ bias: OTHER_BIAS, proposedLabel: "cokolwiek" }),
  ]);

  assertAccepted(result);
  assert.equal(
    Object.hasOwn(result.value.possibleBiases[0], "proposedLabel"),
    false,
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0].bias | other_bias_no_label",
    "possibleBiases[0].proposedLabel | backend_field_removed",
  ]);
});

test("pola wyliczane — proposedBiasLabels podane przez Gemini (na górze i we wpisie) jest usuwane z backend_field_removed", () => {
  const raw = validFull();
  raw.proposedBiasLabels = ["moja własna interpretacja"];
  raw.possibleBiases[0].proposedBiasLabels = ["inna interpretacja"];
  raw.proposedLabel = "na górze";

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS);
  assert.deepEqual(
    Object.keys(result.value.possibleBiases[0]).sort(),
    FULL_ENTRY_KEYS,
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0].proposedBiasLabels | backend_field_removed",
    "proposedBiasLabels | backend_field_removed",
    "proposedLabel | backend_field_removed",
  ]);
});

/* ------------------- wartości pól obcych nie są nawet odczytywane ------------------- */

test("lista dozwolonych pól — wartości pól spoza kontraktu nie są odczytywane (getter rzucający wyjątek nie jest wywołany)", () => {
  const explode = () => {
    throw new Error("pole spoza kontraktu zostało odczytane");
  };

  const raw = validFull();
  for (const field of [
    "obcePole",
    "analyzedAt",
    "proposedLabel",
    "proposedBiasLabels",
  ]) {
    Object.defineProperty(raw, field, { get: explode, enumerable: true });
    Object.defineProperty(raw.possibleBiases[0], field, {
      get: explode,
      enumerable: true,
    });
  }

  const result = run(raw);

  assertAccepted(result);
  assert.equal(result.warnings.length, 8);
});

/* ------------------------- współdziałanie z K4/K5 ------------------------- */

test("ostrzeżenia K4, K5 i K6 działają razem w jednej odpowiedzi", () => {
  const raw = validFull();
  raw.analyzedAt = "2020-01-01";
  raw.cosInnego = true;
  raw.possibleBiases = [
    biasEntry({ bias: "Confirmation Bias", confidence: "HIGH" }),
    biasEntry({ bias: "błąd potwierdzenia", userId: "x" }),
    biasEntry({ bias: "FOMO", proposedLabel: "podrzucona", dodatkowe: 1 }),
    biasEntry({ bias: OTHER_BIAS }),
  ];

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(
    warningPairs(result.warnings),
    [
      "analyzedAt | backend_field_removed",
      "cosInnego | unknown_field_removed",
      "possibleBiases[0].confidence | confidence_normalized",
      "possibleBiases[1].bias | duplicate_bias",
      "possibleBiases[1].userId | backend_field_removed",
      "possibleBiases[2].bias | bias_unmapped",
      "possibleBiases[2].dodatkowe | unknown_field_removed",
      "possibleBiases[2].proposedLabel | backend_field_removed",
      "possibleBiases[3].bias | other_bias_no_label",
    ].sort(),
  );
  assert.equal(result.value.possibleBiases[2].proposedLabel, "FOMO");
});

test("ostrzeżenia — przy odrzuceniu odpowiedzi (ok:false) nie ma ostrzeżeń, nawet gdy są pola obce i pola backendu", () => {
  const raw = validFull();
  raw.analyzedAt = "2020-01-01";
  raw.cosInnego = 1;
  delete raw.summary;

  const result = run(raw);

  assertRejected(result, [["summary", "missing_field"]]);
  assert.deepEqual(Object.keys(result).sort(), ["errors", "ok"]);
});

test("ostrzeżenia — wejście jako obiekt i jako tekst JSON daje te same ostrzeżenia i ten sam wynik", () => {
  const raw = validFull();
  raw.analyzedAt = "2020-01-01";
  raw.cosInnego = 1;
  raw.possibleBiases[0].proposedLabel = "x";

  const fromObject = run(raw);
  const fromText = run(JSON.stringify(raw));

  assertAccepted(fromObject);
  assertAccepted(fromText);
  assert.deepEqual(fromText.warnings, fromObject.warnings);
  assert.deepEqual(fromText.value, fromObject.value);
});

test("ostrzeżenia — komunikaty o polach obcych są krótkie i nie powtarzają nazwy pola ani jego wartości (ścieżka wskazuje miejsce)", () => {
  const longKey = "k".repeat(5000);
  const raw = validFull();
  raw[longKey] = "v".repeat(5000);
  raw.analyzedAt = "w".repeat(5000);

  const result = run(raw);

  assertAccepted(result);
  assert.equal(result.warnings.length, 2);

  for (const warning of result.warnings) {
    assert.ok(warning.message.length < 200);
    assert.ok(!warning.message.includes("kkkk"));
    assert.ok(!warning.message.includes("vvvv"));
    assert.ok(!warning.message.includes("wwww"));
  }
});

/* ================================================================== *
 * KROK 7 — kontrakt quickCheck (earlyAiCheck)
 * ================================================================== */

const QUICK = { kind: "quickCheck" };
const QUICK_VALUE_KEYS = [
  "limitations",
  "possibleBiases",
  "proposedBiasLabels",
  "summary",
];
const QUICK_CONTRACT_KEYS = ["limitations", "possibleBiases", "summary"];

function validQuick() {
  return {
    summary: "Wstępna ocena: decyzja wygląda na reakcję na stratę.",
    possibleBiases: ["niechęć do straty"],
    limitations: "Szybka ocena na podstawie jednego zapisu.",
  };
}

const runQuick = (raw) => validateAiResponse(raw, QUICK);

function quickWith(possibleBiases) {
  return runQuick({ ...validQuick(), possibleBiases });
}

/* ------------------------- poprawne odpowiedzi ------------------------- */

test("quickCheck — poprawna odpowiedź: kształt wyniku i dokładne pola value (summary, possibleBiases, proposedBiasLabels, limitations)", () => {
  const result = runQuick(validQuick());

  assertAccepted(result);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "value", "warnings"]);
  assert.deepEqual(Object.keys(result.value), [
    "summary",
    "possibleBiases",
    "proposedBiasLabels",
    "limitations",
  ]);
  assert.deepEqual(result.value, {
    summary: "Wstępna ocena: decyzja wygląda na reakcję na stratę.",
    possibleBiases: ["niechęć do straty"],
    proposedBiasLabels: [],
    limitations: "Szybka ocena na podstawie jednego zapisu.",
  });
  assert.deepEqual(result.warnings, []);
});

test("quickCheck — obiekt i czysty tekst JSON dają ten sam wynik", () => {
  const fromObject = runQuick(validQuick());
  const fromText = runQuick(JSON.stringify(validQuick()));

  assertAccepted(fromText);
  assert.deepEqual(fromText.value, fromObject.value);
  assert.deepEqual(fromText.warnings, fromObject.warnings);
});

test("quickCheck — pusta lista possibleBiases jest dopuszczalna (wynik: puste possibleBiases i proposedBiasLabels)", () => {
  const result = quickWith([]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, []);
  assert.deepEqual(result.value.proposedBiasLabels, []);
  assert.deepEqual(result.warnings, []);
});

test("quickCheck — kilka różnych biasów zachowuje kolejność wejścia", () => {
  const result = quickWith([
    "zakotwiczenie",
    "Loss Aversion",
    "efekt stadny",
    "Confirmation Bias",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [
    "zakotwiczenie",
    "niechęć do straty",
    "efekt stadny",
    "błąd potwierdzenia",
  ]);
  assert.deepEqual(result.value.proposedBiasLabels, []);
  assert.deepEqual(result.warnings, []);
});

test("quickCheck — summary i limitations są tylko przycinane (bez małych liter), limitations może być puste", () => {
  const messy = "  Duży  SPADEK\u00a0ceny \u2019test\u2019 \u2013 Błąd \n";
  const expected = "Duży  SPADEK\u00a0ceny \u2019test\u2019 \u2013 Błąd";

  const result = runQuick({
    ...validQuick(),
    summary: messy,
    limitations: messy,
  });

  assertAccepted(result);
  assert.equal(result.value.summary, expected);
  assert.equal(result.value.limitations, expected);

  for (const blank of ["", "   ", "\n\t"]) {
    const blankResult = runQuick({ ...validQuick(), limitations: blank });

    assertAccepted(blankResult);
    assert.equal(blankResult.value.limitations, "");
  }
});

/* ---------------------- wejście, wymagane pola, typy ---------------------- */

test("quickCheck — te same zasady wejścia co w pełnej analizie (fences, tekst wokół, zły kształt)", () => {
  const json = JSON.stringify(validQuick());

  assertRejected(runQuick("```json\n" + json + "\n```"), [
    ["$", "invalid_json"],
  ]);
  assertRejected(runQuick("Oto wynik: " + json), [["$", "invalid_json"]]);
  assertRejected(runQuick(""), [["$", "invalid_json"]]);
  assertRejected(runQuick(null), [["$", "invalid_structure"]]);
  assertRejected(runQuick([validQuick()]), [["$", "invalid_structure"]]);
  assertRejected(runQuick(JSON.stringify(json)), [["$", "invalid_structure"]]);
});

test("quickCheck — pusty obiekt daje missing_field dla trzech wymaganych pól (a nie dla pól pełnej analizy)", () => {
  const expected = QUICK_CONTRACT_KEYS.map((field) => [field, "missing_field"]);

  assertRejected(runQuick({}), expected);
  assertRejected(runQuick("{}"), expected);
});

test("quickCheck — brak każdego wymaganego pola (osobno) daje dokładnie jeden błąd missing_field", () => {
  for (const field of QUICK_CONTRACT_KEYS) {
    const raw = validQuick();
    delete raw[field];

    assertRejected(runQuick(raw), [[field, "missing_field"]]);
  }
});

test("quickCheck — zły typ pola daje invalid_type (tablica zamiast obiektu i odwrotnie)", () => {
  const wrongTypes = {
    summary: [null, 5, true, [], {}],
    possibleBiases: ["tekst", {}, null, 5, true],
    limitations: [null, 5, true, [], {}],
  };

  for (const [field, samples] of Object.entries(wrongTypes)) {
    for (const sample of samples) {
      assertRejected(runQuick({ ...validQuick(), [field]: sample }), [
        [field, "invalid_type"],
      ]);
    }
  }
});

test("quickCheck — summary pusty lub z samych odstępów daje empty_value", () => {
  for (const blank of ["", " ", "\n\t "]) {
    assertRejected(runQuick({ ...validQuick(), summary: blank }), [
      ["summary", "empty_value"],
    ]);
  }
});

test("quickCheck — element possibleBiases niebędący niepustym tekstem daje invalid_bias ze wskazaniem indeksu", () => {
  for (const bad of [null, 5, true, [], {}, "", "   ", { bias: "FOMO" }]) {
    assertRejected(quickWith(["niechęć do straty", bad]), [
      ["possibleBiases[1]", "invalid_bias"],
    ]);
  }
});

test("quickCheck — walidator zbiera wszystkie błędy naraz", () => {
  const raw = {
    // summary: brak
    possibleBiases: ["niechęć do straty", null, "", 5],
    limitations: 7,
  };

  assertRejected(runQuick(raw), [
    ["summary", "missing_field"],
    ["possibleBiases[1]", "invalid_bias"],
    ["possibleBiases[2]", "invalid_bias"],
    ["possibleBiases[3]", "invalid_bias"],
    ["limitations", "invalid_type"],
  ]);
});

test("quickCheck — odrzucenie ma tylko pola ok i errors (bez value i warnings), nawet gdy są pola obce", () => {
  const raw = { ...validQuick(), analyzedAt: "2020-01-01", cosInnego: 1 };
  delete raw.summary;

  const result = runQuick(raw);

  assertRejected(result, [["summary", "missing_field"]]);
  assert.deepEqual(Object.keys(result).sort(), ["errors", "ok"]);

  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ["code", "message", "path"]);
    assert.ok(ERROR_CODES.includes(error.code));
  }
});

/* ------------- rozpoznawanie biasów (ten sam mechanizm co w pełnej analizie) ------------- */

test("quickCheck — każda nazwa kanoniczna i każdy zatwierdzony alias daje nazwę kanoniczną, bez ostrzeżeń i bez etykiet", () => {
  let checked = 0;

  for (const [term, owner] of ALIAS_OWNER) {
    const result = quickWith([term]);

    assertAccepted(result);
    assert.deepEqual(result.value.possibleBiases, [owner], `"${term}"`);
    assert.deepEqual(result.value.proposedBiasLabels, [], `"${term}"`);
    assert.deepEqual(result.warnings, [], `"${term}"`);
    checked += 1;
  }

  assert.equal(checked, 35 + 143);
});

test("quickCheck — wielkość liter, odstępy, polskie znaki i krzywe znaki są normalizowane przed szukaniem", () => {
  const variants = [
    ["  BŁĄD   POTWIERDZENIA ", "błąd potwierdzenia"],
    ["BŁĄD\tPOTWIERDZENIA", "błąd potwierdzenia"],
    ["błąd\u00a0potwierdzenia", "błąd potwierdzenia"],
    ["błąd\npotwierdzenia", "błąd potwierdzenia"],
    [" CONFIRMATION   BIAS ", "błąd potwierdzenia"],
    ["NIECHĘĆ DO STRATY", "niechęć do straty"],
    ["niech" + "e\u0328" + "c\u0301" + " do straty", "niechęć do straty"],
    ["Gambler\u2019s Fallacy", "błąd hazardzisty"],
    ["Self\u2013Attribution Bias", "błąd atrybucji własnych sukcesów"],
    ["Monte Carlo Fallacy", "błąd hazardzisty"],
  ];

  for (const [input, expected] of variants) {
    const result = quickWith([input]);

    assertAccepted(result);
    assert.deepEqual(
      result.value.possibleBiases,
      [expected],
      JSON.stringify(input),
    );
    assert.deepEqual(result.warnings, [], JSON.stringify(input));
  }
});

/* ------------------- nieznany bias → fallback + proposedBiasLabels ------------------- */

test("quickCheck — nieznany bias: fallback w possibleBiases, oryginalna nazwa w proposedBiasLabels, ostrzeżenie bias_unmapped", () => {
  const result = quickWith(["FOMO"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO"]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
  ]);
});

test("quickCheck — przykład z planu (B3): znany + nieznany bias", () => {
  const result = quickWith(["Loss Aversion", "FOMO związane z AI stocks"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [
    "niechęć do straty",
    OTHER_BIAS,
  ]);
  assert.deepEqual(result.value.proposedBiasLabels, [
    "FOMO związane z AI stocks",
  ]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1] | bias_unmapped",
  ]);
});

test("quickCheck — wiele nieznanych biasów: jeden fallback, wszystkie etykiety zachowane w kolejności (bez powtórzeń)", () => {
  const result = quickWith(["FOMO", "confirmation loop", "FOMO", "Anchoring"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS, "zakotwiczenie"]);
  assert.deepEqual(result.value.proposedBiasLabels, [
    "FOMO",
    "confirmation loop",
  ]);
  // duplicate_bias dostaje TYLKO drugie "FOMO" (ta sama etykieta wejściowa),
  // a nie "confirmation loop" (inna etykieta, która tylko trafia do fallbacku).
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | bias_unmapped",
    "possibleBiases[2] | duplicate_bias",
  ]);
});

test("quickCheck — proposedBiasLabels: bez powtórzeń niezależnie od wielkości liter i odstępów, zostaje pierwsza pisownia", () => {
  const result = quickWith(["FOMO", "fomo", " Fomo ", "F O M O"]);

  assertAccepted(result);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO", "F O M O"]);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
});

test("quickCheck — etykieta zachowuje pisownię (U8): NFC, odstępy zbite do jednej spacji, trim, wielkość liter i znaki bez zmian", () => {
  const result = quickWith([
    "  Xyz\u00a0 BIAS  of\tthe \u2019Investor\u2019 \u2013 variant\n",
    "Xe\u0328 Effect",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.proposedBiasLabels, [
    "Xyz BIAS of the \u2019Investor\u2019 \u2013 variant",
    "Xę Effect",
  ]);
});

test("quickCheck — brak fuzzy matching: podobne i usunięte z listy pojęcia nie są mapowane, a ich nazwy trafiają do proposedBiasLabels", () => {
  const notMapped = [
    "awersja do ryzyka",
    "niechęć do ryzyka",
    "confirmation",
    "outcome",
    "gambling preference",
    "błąd potwierdzenia.",
    "blad potwierdzenia",
    "niechec do straty",
    "inne/nieskatalogowane",
  ];

  const result = quickWith(notMapped);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, notMapped);
});

test("quickCheck — fallback podany wprost bez nazwy jest przyjęty z other_bias_no_label i nie tworzy etykiety", () => {
  for (const input of [
    OTHER_BIAS,
    "Inne / Nieskatalogowane",
    " inne  /  nieskatalogowane \n",
  ]) {
    const result = quickWith([input]);

    assertAccepted(result);
    assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
    assert.deepEqual(result.value.proposedBiasLabels, []);
    assert.deepEqual(warningPairs(result.warnings), [
      "possibleBiases[0] | other_bias_no_label",
    ]);
  }
});

test("quickCheck — fallback wprost i nieznany bias: jedna pozycja fallbacku, etykieta tylko dla nieznanego", () => {
  const result = quickWith(["FOMO", OTHER_BIAS]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO"]);
  // "FOMO" i fallback podany wprost to RÓŻNE etykiety wejściowe — brak duplicate_bias.
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | other_bias_no_label",
  ]);
});

/* ------------------------------- deduplikacja ------------------------------- */

test("quickCheck — duplikat nazwy kanonicznej: zostaje pierwsze wystąpienie, duplicate_bias przy usuniętym", () => {
  const result = quickWith([
    "błąd potwierdzenia",
    "efekt stadny",
    "błąd potwierdzenia",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [
    "błąd potwierdzenia",
    "efekt stadny",
  ]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[2] | duplicate_bias",
  ]);
});

test("quickCheck — przykład z ustaleń: alias + nazwa kanoniczna + powtórzenie aliasu", () => {
  const result = quickWith([
    "Confirmation Bias",
    "błąd potwierdzenia",
    "Anchoring",
    "Confirmation Bias",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [
    "błąd potwierdzenia",
    "zakotwiczenie",
  ]);
  assert.deepEqual(result.value.proposedBiasLabels, []);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1] | duplicate_bias",
    "possibleBiases[3] | duplicate_bias",
  ]);
});

test("quickCheck — duplikat przez różnicę wielkości liter i białych znaków", () => {
  const result = quickWith([
    "Błąd potwierdzenia",
    "  BŁĄD\u00a0 POTWIERDZENIA ",
    "błąd\tpotwierdzenia",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, ["błąd potwierdzenia"]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1] | duplicate_bias",
    "possibleBiases[2] | duplicate_bias",
  ]);
});

test("quickCheck — zostaje pierwsze wystąpienie i kolejność wejścia (bez przesuwania)", () => {
  const result = quickWith([
    "Anchoring",
    "Confirmation Bias",
    "anchoring",
    "efekt stadny",
    "Herding",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [
    "zakotwiczenie",
    "błąd potwierdzenia",
    "efekt stadny",
  ]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[2] | duplicate_bias",
    "possibleBiases[4] | duplicate_bias",
  ]);
});

test("quickCheck — komunikat duplicate_bias wskazuje pierwsze wystąpienie, a nie cytuje treści odpowiedzi", () => {
  const result = quickWith(["efekt stadny", "Q".repeat(5000), "Herding"]);

  assertAccepted(result);

  const duplicate = result.warnings.find(
    (warning) => warning.code === "duplicate_bias",
  );

  assert.equal(duplicate.path, "possibleBiases[2]");
  assert.match(duplicate.message, /possibleBiases\[0\]/);

  for (const warning of result.warnings) {
    assert.ok(warning.message.length < 200);
    assert.ok(!warning.message.includes("QQQQ"));
  }
});

test("quickCheck — dedupe nie łączy niczego poza listą: ta sama wartość wejścia nie jest zmieniana, a brak duplikatów nie daje ostrzeżeń", () => {
  const input = ["niechęć do straty", "efekt stadny", "zakotwiczenie"];
  const raw = { ...validQuick(), possibleBiases: input };

  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, input);
  assert.notEqual(result.value.possibleBiases, input);
  assert.deepEqual(result.warnings, []);
});

/* ---- deduplikacja nieznanych etykiet: po znormalizowanej etykiecie wejściowej ---- */

test("quickCheck dedupe — dwie RÓŻNE nieznane etykiety nie są duplikatami (bias_unmapped dla obu, bez duplicate_bias, obie w proposedBiasLabels)", () => {
  const result = quickWith(["FOMO", "confirmation loop"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, [
    "FOMO",
    "confirmation loop",
  ]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | bias_unmapped",
  ]);
  assert.equal(
    result.warnings.some((warning) => warning.code === "duplicate_bias"),
    false,
  );
});

test("quickCheck dedupe — przykład z zadania: tylko drugie FOMO to duplikat, 'confirmation loop' nim nie jest", () => {
  const result = quickWith(["FOMO", "confirmation loop", "FOMO", "Anchoring"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS, "zakotwiczenie"]);
  assert.deepEqual(result.value.proposedBiasLabels, [
    "FOMO",
    "confirmation loop",
  ]);
  assert.deepEqual(
    result.warnings
      .filter((warning) => warning.code === "duplicate_bias")
      .map((warning) => warning.path),
    ["possibleBiases[2]"],
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | bias_unmapped",
    "possibleBiases[2] | duplicate_bias",
  ]);
});

test("quickCheck dedupe — 'FOMO' i 'fomo' to duplikat: zostaje pierwsza pisownia, usunięte powtórzenie dostaje tylko duplicate_bias", () => {
  const result = quickWith(["FOMO", "fomo"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO"]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | duplicate_bias",
  ]);
});

test("quickCheck dedupe — wiele różnych nieznanych etykiet nigdy nie daje duplicate_bias tylko dlatego, że wszystkie mapują się na fallback", () => {
  const names = [
    "FOMO",
    "confirmation loop",
    "hype chasing",
    "revenge trading",
    "tilt",
  ];
  const result = quickWith(names);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, names);
  assert.deepEqual(
    warningPairs(result.warnings),
    names.map((_, index) => `possibleBiases[${index}] | bias_unmapped`),
  );
});

test("quickCheck dedupe — dwa identyczne znane biasy: dotychczasowe zachowanie (zostaje pierwszy, duplicate_bias przy drugim, bez etykiet)", () => {
  const result = quickWith(["zakotwiczenie", "zakotwiczenie"]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, ["zakotwiczenie"]);
  assert.deepEqual(result.value.proposedBiasLabels, []);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1] | duplicate_bias",
  ]);
});

test("quickCheck dedupe — fallback w possibleBiases występuje dokładnie raz, także gdy mieszają się nieznane etykiety i fallback wprost", () => {
  const result = quickWith([
    "FOMO",
    "confirmation loop",
    OTHER_BIAS,
    "Anchoring",
    "fomo",
  ]);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS, "zakotwiczenie"]);
  assert.equal(
    result.value.possibleBiases.filter((bias) => bias === OTHER_BIAS).length,
    1,
  );
  assert.deepEqual(result.value.proposedBiasLabels, [
    "FOMO",
    "confirmation loop",
  ]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | bias_unmapped",
    "possibleBiases[2] | other_bias_no_label",
    "possibleBiases[4] | duplicate_bias",
  ]);
});

test("quickCheck dedupe — fallback podany wprost dwa razy (po normalizacji) to duplikat, fallback wprost i nieznana etykieta (w obu kolejnościach) nie", () => {
  const twice = quickWith([OTHER_BIAS, " Inne  /  nieskatalogowane "]);

  assertAccepted(twice);
  assert.deepEqual(twice.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(twice.value.proposedBiasLabels, []);
  assert.deepEqual(warningPairs(twice.warnings), [
    "possibleBiases[0] | other_bias_no_label",
    "possibleBiases[1] | duplicate_bias",
  ]);

  const otherFirst = quickWith([OTHER_BIAS, "FOMO"]);

  assertAccepted(otherFirst);
  assert.deepEqual(otherFirst.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(otherFirst.value.proposedBiasLabels, ["FOMO"]);
  assert.deepEqual(warningPairs(otherFirst.warnings), [
    "possibleBiases[0] | other_bias_no_label",
    "possibleBiases[1] | bias_unmapped",
  ]);
});

test("quickCheck dedupe — normalizacja etykiet (wielkość liter, odstępy, krzywy apostrof, warianty myślnika) wykrywa duplikaty; zostaje pierwsza pisownia", () => {
  const cases = [
    { first: "FOMO", second: "fomo", kept: "FOMO" },
    {
      first: "confirmation  loop",
      second: "confirmation loop",
      kept: "confirmation loop",
    },
    {
      first: "investor’s bias",
      second: "investor's bias",
      kept: "investor’s bias",
    },
    { first: "risk–seeking", second: "risk-seeking", kept: "risk–seeking" },
  ];

  for (const { first, second, kept } of cases) {
    for (const [a, b, keptLabel] of [
      [first, second, kept],
      [second, first, normalizeLabel(second)],
    ]) {
      const result = quickWith([a, b]);
      const context = JSON.stringify([a, b]);

      assertAccepted(result);
      assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS], context);
      assert.deepEqual(result.value.proposedBiasLabels, [keptLabel], context);
      assert.deepEqual(
        warningPairs(result.warnings),
        [
          "possibleBiases[0] | bias_unmapped",
          "possibleBiases[1] | duplicate_bias",
        ],
        context,
      );
    }
  }
});

test("quickCheck dedupe — brak fuzzy/semantycznego łączenia: etykiety różniące się znakami lub słowami nie są duplikatami", () => {
  const distinct = [
    ["risk-seeking", "risk seeking"],
    ["fomo", "fomo!"],
    ["confirmation loop", "confirmation loops"],
    ["FOMO", "fear of missing out"],
  ];

  for (const pair of distinct) {
    const result = quickWith(pair);

    assertAccepted(result);
    assert.deepEqual(
      result.value.proposedBiasLabels,
      pair,
      JSON.stringify(pair),
    );
    assert.deepEqual(
      warningPairs(result.warnings),
      [
        "possibleBiases[0] | bias_unmapped",
        "possibleBiases[1] | bias_unmapped",
      ],
      JSON.stringify(pair),
    );
  }
});

test("quickCheck dedupe — duplicate_bias dla nieznanej etykiety wskazuje pierwsze wystąpienie i nie cytuje treści odpowiedzi", () => {
  const result = quickWith([
    "efekt stadny",
    "Q".repeat(5000),
    "q".repeat(5000),
  ]);

  assertAccepted(result);

  const duplicate = result.warnings.find(
    (warning) => warning.code === "duplicate_bias",
  );

  assert.equal(duplicate.path, "possibleBiases[2]");
  assert.match(duplicate.message, /possibleBiases\[1\]/);

  for (const warning of result.warnings) {
    assert.ok(warning.message.length < 200);
    assert.ok(!/q{4}/i.test(warning.message));
  }
});

test("quickCheck dedupe — zmiana nie dotyka pełnej analizy: dwie RÓŻNE nieznane nazwy nadal bez duplicate_bias, ta sama nazwa nadal z duplicate_bias (oba wpisy zostają)", () => {
  const different = runWithEntries([
    biasEntry({ bias: "FOMO" }),
    biasEntry({ bias: "confirmation loop" }),
    biasEntry({ bias: "FOMO" }),
  ]);

  assertAccepted(different);
  assert.equal(different.value.possibleBiases.length, 3);
  assert.deepEqual(
    different.value.possibleBiases.map((entry) => [
      entry.bias,
      entry.proposedLabel,
    ]),
    [
      [OTHER_BIAS, "FOMO"],
      [OTHER_BIAS, "confirmation loop"],
      [OTHER_BIAS, "FOMO"],
    ],
  );
  assert.deepEqual(warningPairs(different.warnings), [
    "possibleBiases[0].bias | bias_unmapped",
    "possibleBiases[1].bias | bias_unmapped",
    "possibleBiases[2].bias | bias_unmapped",
    "possibleBiases[2].bias | duplicate_bias",
  ]);
});

/* ------------- pola wyliczane i pola obce w quickCheck ------------- */

test("quickCheck — proposedBiasLabels podane przez Gemini jest usuwane (backend_field_removed), a walidator wylicza własne", () => {
  const raw = {
    ...validQuick(),
    possibleBiases: ["FOMO"],
    proposedBiasLabels: ["moja własna interpretacja"],
  };

  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO"]);
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "proposedBiasLabels | backend_field_removed",
  ]);
});

test("quickCheck — proposedBiasLabels od Gemini przy samych znanych biasach: wynik ma pustą listę walidatora", () => {
  const raw = { ...validQuick(), proposedBiasLabels: ["cokolwiek", "inne"] };

  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(result.value.proposedBiasLabels, []);
  assert.deepEqual(warningPairs(result.warnings), [
    "proposedBiasLabels | backend_field_removed",
  ]);
});

test("quickCheck — proposedLabel na poziomie głównym też jest polem wyliczanym i jest usuwane", () => {
  const result = runQuick({ ...validQuick(), proposedLabel: "cokolwiek" });

  assertAccepted(result);
  assert.equal(Object.hasOwn(result.value, "proposedLabel"), false);
  assert.deepEqual(warningPairs(result.warnings), [
    "proposedLabel | backend_field_removed",
  ]);
});

test("quickCheck — pola derived w nieprawidłowym miejscu zagnieżdżonym: element-obiekt to błąd, a obiekt zagnieżdżony w polu obcym jest usuwany w całości", () => {
  // element possibleBiases nie może być obiektem (to lista nazw)
  assertRejected(
    quickWith([
      { bias: "FOMO", proposedBiasLabels: ["x"], proposedLabel: "y" },
    ]),
    [["possibleBiases[0]", "invalid_bias"]],
  );

  // pole zagnieżdżone w obcym obiekcie nigdy nie dociera do wyniku
  const raw = {
    ...validQuick(),
    meta: { proposedBiasLabels: ["x"], analyzedAt: "z" },
  };
  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), QUICK_VALUE_KEYS);
  assert.deepEqual(result.value.proposedBiasLabels, []);
  assert.deepEqual(warningPairs(result.warnings), [
    "meta | unknown_field_removed",
  ]);
});

test("quickCheck — obce pole na poziomie głównym daje unknown_field_removed i nie trafia do wyniku", () => {
  const result = runQuick({ ...validQuick(), obcePole: "x", drugie: [1] });

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), QUICK_VALUE_KEYS);
  assert.deepEqual(warningPairs(result.warnings), [
    "drugie | unknown_field_removed",
    "obcePole | unknown_field_removed",
  ]);
});

test("quickCheck — pola pełnej analizy (confidence, observedPatterns, alternativeExplanations, outcomeNote, supportingEvidence...) są w quickCheck polami obcymi", () => {
  const raw = {
    ...validQuick(),
    confidence: "high",
    observedPatterns: ["x"],
    alternativeExplanations: ["y"],
    outcomeNote: "z",
    supportingEvidence: "w",
    contradictingEvidence: "v",
  };

  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), QUICK_VALUE_KEYS);
  assert.deepEqual(warningPairs(result.warnings), [
    "alternativeExplanations | unknown_field_removed",
    "confidence | unknown_field_removed",
    "contradictingEvidence | unknown_field_removed",
    "observedPatterns | unknown_field_removed",
    "outcomeNote | unknown_field_removed",
    "supportingEvidence | unknown_field_removed",
  ]);
});

test("quickCheck — każde pole backendu z listy planu na poziomie głównym jest usuwane z backend_field_removed", () => {
  for (const field of PLAN_BACKEND_FIELDS) {
    const result = runQuick({ ...validQuick(), [field]: "podrobiona wartość" });

    assertAccepted(result);
    assert.deepEqual(Object.keys(result.value).sort(), QUICK_VALUE_KEYS, field);
    assert.deepEqual(
      warningPairs(result.warnings),
      [`${field} | backend_field_removed`],
      field,
    );
  }
});

test("quickCheck — __proto__, constructor i prototype (z tekstu JSON) są polami obcymi i nie trafiają do wyniku", () => {
  const text = JSON.stringify(validQuick()).replace(
    "{",
    '{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":[1],',
  );

  const result = runQuick(text);

  assertAccepted(result);
  assert.deepEqual(Object.keys(result.value).sort(), QUICK_VALUE_KEYS);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(warningPairs(result.warnings), [
    "__proto__ | unknown_field_removed",
    "constructor | unknown_field_removed",
    "prototype | unknown_field_removed",
  ]);
});

test("quickCheck — wartości pól spoza kontraktu nie są odczytywane (getter rzucający wyjątek nie jest wywołany)", () => {
  const explode = () => {
    throw new Error("pole spoza kontraktu zostało odczytane");
  };

  const raw = validQuick();
  for (const field of [
    "obcePole",
    "analyzedAt",
    "proposedBiasLabels",
    "proposedLabel",
  ]) {
    Object.defineProperty(raw, field, { get: explode, enumerable: true });
  }

  const result = runQuick(raw);

  assertAccepted(result);
  assert.equal(result.warnings.length, 4);
});

test("quickCheck — ostrzeżenia różnych rodzajów w jednej odpowiedzi (nieznany bias, duplikat, fallback wprost, pole obce, pole backendu)", () => {
  const raw = {
    ...validQuick(),
    possibleBiases: ["Loss Aversion", "FOMO", "loss aversion", OTHER_BIAS],
    analyzedAt: "2020-01-01",
    cosInnego: true,
  };

  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(result.value.possibleBiases, [
    "niechęć do straty",
    OTHER_BIAS,
  ]);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO"]);
  assert.deepEqual(warningPairs(result.warnings), [
    "analyzedAt | backend_field_removed",
    "cosInnego | unknown_field_removed",
    "possibleBiases[1] | bias_unmapped",
    "possibleBiases[2] | duplicate_bias",
    "possibleBiases[3] | other_bias_no_label",
  ]);
});

test("quickCheck — wynik to nowy obiekt: bez wspólnych referencji z wejściem, wejście (także zamrożone) bez zmian", () => {
  const raw = deepFreeze(validQuick());
  const snapshot = JSON.parse(JSON.stringify(raw));

  const result = runQuick(raw);

  assertAccepted(result);
  assert.notEqual(result.value, raw);
  assert.notEqual(result.value.possibleBiases, raw.possibleBiases);

  result.value.possibleBiases.push("dopisane");
  result.value.proposedBiasLabels.push("dopisane");
  assert.deepEqual(raw, snapshot);
});

test("quickCheck — brak limitów (D5): bardzo długi tekst i bardzo wiele nieznanych biasów są przyjmowane w całości", () => {
  const names = Array.from(
    { length: 5000 },
    (_, index) => `nieznany bias numer ${index}`,
  );
  const result = runQuick({
    summary: "S".repeat(200000),
    possibleBiases: names,
    limitations: "L".repeat(200000),
  });

  assertAccepted(result);
  assert.equal(result.value.summary.length, 200000);
  assert.equal(result.value.limitations.length, 200000);
  assert.deepEqual(result.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(result.value.proposedBiasLabels, names);
});

/* ================================================================== *
 * KROK 8 — bezpieczeństwo, niezmienność wejścia, brak limitów, brzegi
 *
 * Uzupełnia testy z kroków 2–7 o przypadki, których tam nie było:
 *   - niezmienność głęboko zamrożonego wejścia także przy ODRZUCENIU,
 *   - brak wspólnych referencji (sprawdzany na każdym zagnieżdżonym
 *     obiekcie i tablicy, nie tylko na kilku wybranych),
 *   - __proto__ / constructor / prototype na każdym poziomie, w tym
 *     w danych z tekstu JSON, w wejściu obiektowym i jako WARTOŚCI,
 *   - brak limitów (D5) dla pełnej analizy i quick-checka,
 *   - wiele problemów naraz bez utraty błędów i ostrzeżeń.
 * ================================================================== */

/* ------------------------------ pomocniki K8 ------------------------------ */

const GUARDED_PROTOTYPES = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
];
const DESCRIPTOR_FIELDS = [
  "value",
  "writable",
  "get",
  "set",
  "enumerable",
  "configurable",
];

/**
 * Pomocnik kontrolujący Object.prototype i Array.prototype. Co potrafi:
 *
 *   WYKRYWA (diffPrototypeSnapshots): dodanie, usunięcie i zmianę właściwości
 *   (wartości lub dowolnej flagi deskryptora, także kluczy symbolicznych),
 *   zmianę prototypu prototypu oraz utratę rozszerzalności.
 *
 *   ODWRACA (restorePrototypes): to, co da się odwrócić zwykłymi operacjami —
 *   usuwa właściwości dodane po migawce, odtwarza zmienione lub usunięte
 *   właściwości z ich pierwotnych deskryptorów i przywraca prototyp prototypu.
 *
 *   NIE ODWRACA: utraty rozszerzalności (Object.preventExtensions) ani zmiany
 *   właściwości na `configurable: false` — JavaScript na to nie pozwala, więc
 *   nie istnieje uniwersalne odtworzenie dowolnej zmiany globalnego prototypu.
 *   Gdy któraś zmiana jest nieodwracalna, restorePrototypes odtwarza resztę
 *   i rzuca błąd z listą tego, czego nie dało się cofnąć (zamiast to ukryć).
 *   Dlatego testy w głównym procesie nie wykonują zmian nieodwracalnych;
 *   wykrywanie i zgłaszanie takich zmian sprawdza test na obiekcie
 *   jednorazowym, nie na prawdziwych prototypach.
 */

/**
 * Pełna migawka chronionych prototypów: dla każdego klucza z Reflect.ownKeys()
 * (także symbolicznego) deskryptor z Object.getOwnPropertyDescriptor(), a do
 * tego prototyp prototypu i rozszerzalność. Sama lista nazw nie wystarczała:
 * nie wykrywała podmiany wartości, metody ani zmiany flag właściwości.
 * `targets` domyślnie wskazuje prawdziwe prototypy; test pomocnika podaje
 * w nim obiekt jednorazowy.
 */
function snapshotPrototypes(targets = GUARDED_PROTOTYPES) {
  return targets.map(([name, prototype]) => ({
    name,
    prototype,
    parent: Object.getPrototypeOf(prototype),
    extensible: Object.isExtensible(prototype),
    descriptors: new Map(
      Reflect.ownKeys(prototype).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(prototype, key),
      ]),
    ),
  }));
}

/** Deskryptory są równe, gdy zgadzają się wszystkie pola (wartości i funkcje przez Object.is). */
const sameDescriptor = (a, b) =>
  DESCRIPTOR_FIELDS.every((field) => Object.is(a[field], b[field]));

/** Różnice między dwiema migawkami (pusta lista = stan identyczny). */
function diffPrototypeSnapshots(before, after) {
  const differences = [];

  before.forEach((was, index) => {
    const now = after[index];

    if (was.parent !== now.parent) {
      differences.push(`${was.name}: zmieniony prototyp prototypu`);
    }

    if (was.extensible !== now.extensible) {
      differences.push(`${was.name}: zmieniona rozszerzalność`);
    }

    for (const [key, descriptor] of now.descriptors) {
      if (!was.descriptors.has(key)) {
        differences.push(`${was.name}: dodano właściwość ${String(key)}`);
      } else if (!sameDescriptor(was.descriptors.get(key), descriptor)) {
        differences.push(
          `${was.name}: zmieniono deskryptor lub wartość właściwości ${String(key)}`,
        );
      }
    }

    for (const key of was.descriptors.keys()) {
      if (!now.descriptors.has(key)) {
        differences.push(`${was.name}: usunięto właściwość ${String(key)}`);
      }
    }
  });

  return differences;
}

/**
 * Odtwarza z migawki to, co da się odwrócić: przywraca prototyp prototypu,
 * usuwa właściwości nieobecne w migawce, a zmienione lub usunięte odtwarza
 * z ich pierwotnych deskryptorów. Utraty rozszerzalności i zmian na
 * `configurable: false` NIE da się cofnąć. Taką zmianę (i każdą inną
 * operację, która się nie powiodła) funkcja zbiera, odtwarza resztę i na końcu
 * rzuca jeden błąd z listą — niczego nie ukrywa.
 */
function restorePrototypes(snapshot) {
  const unrestorable = [];

  const attempt = (description, operation) => {
    try {
      operation();
    } catch {
      unrestorable.push(description);
    }
  };

  for (const { name, prototype, parent, extensible, descriptors } of snapshot) {
    if (Object.getPrototypeOf(prototype) !== parent) {
      attempt(`${name}: nie udało się przywrócić prototypu prototypu`, () =>
        Object.setPrototypeOf(prototype, parent),
      );
    }

    for (const key of Reflect.ownKeys(prototype)) {
      if (!descriptors.has(key)) {
        attempt(
          `${name}: nie udało się usunąć właściwości ${String(key)}`,
          () => {
            if (!Reflect.deleteProperty(prototype, key))
              throw new TypeError("deleteProperty");
          },
        );
      }
    }

    for (const [key, descriptor] of descriptors) {
      const current = Object.getOwnPropertyDescriptor(prototype, key);

      if (!current || !sameDescriptor(descriptor, current)) {
        attempt(
          `${name}: nie udało się odtworzyć właściwości ${String(key)}`,
          () => Object.defineProperty(prototype, key, descriptor),
        );
      }
    }

    if (Object.isExtensible(prototype) !== extensible) {
      unrestorable.push(`${name}: utraty rozszerzalności nie da się cofnąć`);
    }
  }

  if (unrestorable.length > 0) {
    throw new Error(
      `Nie wszystkie zmiany prototypów dało się odwrócić: ${unrestorable.join("; ")}`,
    );
  }
}

/**
 * Wykonuje `action` po tymczasowej zmianie prototypów (`mutate`). Stan sprzed
 * zmiany jest odtwarzany w `finally`, więc także wtedy, gdy rzuci `mutate`
 * albo `action`.
 */
function withPrototypeMutations(mutate, action) {
  const before = snapshotPrototypes();

  try {
    mutate();
    return action();
  } finally {
    restorePrototypes(before);
  }
}

const PROTOTYPES_AT_START = snapshotPrototypes();

/** Chronione prototypy są dokładnie takie jak na początku (klucze, deskryptory, wartości). */
function assertPrototypesClean() {
  assert.deepEqual(
    diffPrototypeSnapshots(PROTOTYPES_AT_START, snapshotPrototypes()),
    [],
    "zmieniono Object.prototype lub Array.prototype",
  );
  assert.equal({}.polluted, undefined);
  assert.equal([].polluted, undefined);
}

/** Wszystkie zagnieżdżone obiekty i tablice (bez cykli — nie używać do wejść cyklicznych). */
function collectNodes(value, path = "value", nodes = []) {
  if (value !== null && typeof value === "object") {
    nodes.push([path, value]);

    for (const key of Object.keys(value)) {
      collectNodes(value[key], `${path}.${key}`, nodes);
    }
  }

  return nodes;
}

/** Każdy obiekt i tablica wyniku ma zwykły prototyp i nie widzi "zanieczyszczenia". */
function assertPlainResult(value) {
  for (const [path, node] of collectNodes(value)) {
    assert.equal(
      Object.getPrototypeOf(node),
      Array.isArray(node) ? Array.prototype : Object.prototype,
      `${path}: nietypowy prototyp`,
    );
    assert.equal(node.polluted, undefined, `${path}.polluted`);
    assert.equal(node.x, undefined, `${path}.x`);
  }
}

/** Żaden obiekt ani tablica wyniku nie jest tym samym obiektem co element wejścia. */
function assertNoSharedReferences(input, output) {
  const inputNodes = new Set(collectNodes(input).map(([, node]) => node));

  for (const [path, node] of collectNodes(output)) {
    assert.ok(
      !inputNodes.has(node),
      `${path}: współdzieli referencję z wejściem`,
    );
  }
}

function assertEverythingFrozen(input) {
  for (const [path, node] of collectNodes(input)) {
    assert.ok(
      Object.isFrozen(node),
      `${path}: wejście przestało być zamrożone`,
    );
  }
}

const countByCode = (warnings) =>
  warnings.reduce((counts, warning) => {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1;
    return counts;
  }, {});

const SPECIAL_KEYS = ["__proto__", "constructor", "prototype"];
const POLLUTION_PAYLOAD = '{"polluted":true,"x":1}';
const PLACEHOLDER = '"__placeholder__":1';

/** Tekst JSON, w którym znacznik został zastąpiony fragmentem z prawdziwym własnym kluczem. */
function jsonWithSnippet(object, snippet) {
  const text = JSON.stringify({ __placeholder__: 1, ...object });
  assert.ok(text.includes(PLACEHOLDER));
  return text.replace(PLACEHOLDER, snippet);
}

/** Własny, wyliczalny klucz o specjalnej nazwie także w wejściu obiektowym (nie literał). */
function withOwnKey(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return target;
}

/** Zamyka wejście głęboko i zwraca (zamrożone wejście, migawka sprzed zamrożenia). */
function frozenWithSnapshot(raw) {
  const snapshot = structuredClone(raw);
  return { raw: deepFreeze(raw), snapshot };
}

function richFull() {
  return {
    summary: "  Podsumowanie  ",
    observedPatterns: ["wzorzec A", " wzorzec B "],
    possibleBiases: [
      {
        bias: "Loss Aversion",
        confidence: "MEDIUM",
        supportingEvidence: "Dowód A.",
        contradictingEvidence: "Kontra A.",
      },
      {
        bias: "FOMO",
        proposedLabel: "podrzucone przez model",
        confidence: "low",
        supportingEvidence: "Dowód B.",
        nested: { deep: [1, { deeper: true }] },
      },
      {
        bias: "niechęć do straty",
        confidence: " high ",
        supportingEvidence: "Dowód C.",
      },
    ],
    alternativeExplanations: ["Alternatywa."],
    limitations: "Ograniczenia.",
    outcomeNote: "",
    obcePole: { zagniezdzone: ["a", { b: 1 }] },
    analyzedAt: "2020-01-01",
    marketContextSnapshot: { priceHistory: [1, 2, 3] },
  };
}

const RICH_FULL_WARNINGS = [
  "analyzedAt | backend_field_removed",
  "marketContextSnapshot | backend_field_removed",
  "obcePole | unknown_field_removed",
  "possibleBiases[0].confidence | confidence_normalized",
  "possibleBiases[1].bias | bias_unmapped",
  "possibleBiases[1].nested | unknown_field_removed",
  "possibleBiases[1].proposedLabel | backend_field_removed",
  "possibleBiases[2].bias | duplicate_bias",
  "possibleBiases[2].confidence | confidence_normalized",
].sort();

function richQuick() {
  return {
    summary: " Ocena ",
    possibleBiases: ["Loss Aversion", "FOMO", "niechęć do straty", "fomo"],
    limitations: "Ograniczenia.",
    proposedBiasLabels: ["podrzucone przez model"],
    analyzedAt: "2020-01-01",
    obcePole: { zagniezdzone: ["a", { b: 1 }] },
  };
}

const RICH_QUICK_WARNINGS = [
  "analyzedAt | backend_field_removed",
  "obcePole | unknown_field_removed",
  "possibleBiases[1] | bias_unmapped",
  "possibleBiases[2] | duplicate_bias",
  "possibleBiases[3] | duplicate_bias",
  "proposedBiasLabels | backend_field_removed",
].sort();

/* ------------------------- niezmienność wejścia ------------------------- */

test("K8 niezmienność — full: głęboko zamrożone, bogate wejście (alias, nieznany bias, duplikat, pola obce i backendu) nie jest zmieniane, a wynik nie dzieli z nim żadnego obiektu ani tablicy", () => {
  const { raw, snapshot } = frozenWithSnapshot(richFull());

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), RICH_FULL_WARNINGS);
  assert.deepEqual(result.value.possibleBiases[1], {
    bias: OTHER_BIAS,
    proposedLabel: "FOMO",
    confidence: "low",
    supportingEvidence: "Dowód B.",
    contradictingEvidence: "",
  });

  // wejście: wartości bez zmian i nadal zamrożone w każdym zagnieżdżeniu
  assert.deepEqual(raw, snapshot);
  assertEverythingFrozen(raw);

  // tożsamość: osobne tablice i obiekty (sama równość wartości tego nie wykaże)
  assert.notStrictEqual(result.value, raw);
  assert.notStrictEqual(result.value.observedPatterns, raw.observedPatterns);
  assert.notStrictEqual(result.value.possibleBiases, raw.possibleBiases);
  assert.notStrictEqual(
    result.value.alternativeExplanations,
    raw.alternativeExplanations,
  );
  raw.possibleBiases.forEach((entry, index) => {
    assert.notStrictEqual(
      result.value.possibleBiases[index],
      entry,
      `possibleBiases[${index}]`,
    );
  });
  assertNoSharedReferences(raw, result.value);
  assertNoSharedReferences(raw, result.warnings);
  assertPlainResult(result.value);
});

test("K8 niezmienność — quickCheck: głęboko zamrożone, bogate wejście nie jest zmieniane, a wynik nie dzieli z nim żadnej tablicy ani obiektu", () => {
  const { raw, snapshot } = frozenWithSnapshot(richQuick());

  const result = runQuick(raw);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), RICH_QUICK_WARNINGS);
  assert.deepEqual(result.value.possibleBiases, [
    "niechęć do straty",
    OTHER_BIAS,
  ]);
  assert.deepEqual(result.value.proposedBiasLabels, ["FOMO"]);

  assert.deepEqual(raw, snapshot);
  assertEverythingFrozen(raw);

  assert.notStrictEqual(result.value, raw);
  assert.notStrictEqual(result.value.possibleBiases, raw.possibleBiases);
  // lista podana przez Gemini nie może stać się listą wyniku
  assert.notStrictEqual(
    result.value.proposedBiasLabels,
    raw.proposedBiasLabels,
  );
  assertNoSharedReferences(raw, result.value);
  assertNoSharedReferences(raw, result.warnings);
  assertPlainResult(result.value);
});

test("K8 niezmienność — ODRZUCONE wejście (full i quickCheck, głęboko zamrożone, wiele problemów) nie jest zmieniane, a błędy nie współdzielą z nim obiektów", () => {
  const full = frozenWithSnapshot({
    summary: 5,
    observedPatterns: ["a", null],
    possibleBiases: [
      {
        bias: "",
        confidence: "super",
        supportingEvidence: ["x"],
        obce: { a: [1] },
      },
      null,
    ],
    alternativeExplanations: "x",
    limitations: {},
    outcomeNote: ["x"],
    analyzedAt: "2020-01-01",
    obcePole: { a: [1, { b: 2 }] },
  });

  const fullResult = run(full.raw);

  assertRejected(fullResult, [
    ["summary", "invalid_type"],
    ["observedPatterns[1]", "invalid_type"],
    ["possibleBiases[0].bias", "invalid_bias"],
    ["possibleBiases[0].confidence", "invalid_confidence"],
    ["possibleBiases[0].supportingEvidence", "invalid_type"],
    ["possibleBiases[1]", "invalid_type"],
    ["alternativeExplanations", "invalid_type"],
    ["limitations", "invalid_type"],
    ["outcomeNote", "invalid_type"],
  ]);
  assert.deepEqual(Object.keys(fullResult).sort(), ["errors", "ok"]);
  assert.deepEqual(full.raw, full.snapshot);
  assertEverythingFrozen(full.raw);
  assertNoSharedReferences(full.raw, fullResult.errors);

  const quick = frozenWithSnapshot({
    summary: "",
    possibleBiases: ["FOMO", 5, ""],
    analyzedAt: "2020-01-01",
    obcePole: { a: [1, { b: 2 }] },
  });

  const quickResult = runQuick(quick.raw);

  assertRejected(quickResult, [
    ["summary", "empty_value"],
    ["possibleBiases[1]", "invalid_bias"],
    ["possibleBiases[2]", "invalid_bias"],
    ["limitations", "missing_field"],
  ]);
  assert.deepEqual(Object.keys(quickResult).sort(), ["errors", "ok"]);
  assert.deepEqual(quick.raw, quick.snapshot);
  assertEverythingFrozen(quick.raw);
  assertNoSharedReferences(quick.raw, quickResult.errors);
});

test("K8 niezmienność — kolejne wywołania na tym samym wejściu dają równe, ale niezależne wyniki (brak wspólnego stanu, także dla pustych list)", () => {
  const cases = [
    { name: "full", call: run, make: richFull },
    { name: "quickCheck", call: runQuick, make: richQuick },
    {
      name: "full, puste listy",
      call: run,
      make: () => ({
        ...validFull(),
        observedPatterns: [],
        possibleBiases: [],
        alternativeExplanations: [],
      }),
    },
    {
      name: "quickCheck, puste listy",
      call: runQuick,
      make: () => ({ ...validQuick(), possibleBiases: [] }),
    },
  ];

  for (const { name, call, make } of cases) {
    const raw = make();
    const first = call(raw);
    const second = call(raw);

    assertAccepted(first);
    assert.deepEqual(first, second, name);
    assert.notStrictEqual(first, second, name);
    assert.notStrictEqual(first.value, second.value, name);
    assert.notStrictEqual(first.warnings, second.warnings, name);

    // żaden obiekt ani tablica wyniku nie jest wspólny dla dwóch wywołań
    const firstNodes = new Set(collectNodes(first).map(([, node]) => node));
    for (const [path, node] of collectNodes(second)) {
      assert.ok(
        !firstNodes.has(node),
        `${name}: ${path} wspólne dla dwóch wywołań`,
      );
    }

    // zepsucie pierwszego wyniku nie może zmienić następnych wywołań
    const expected = call(make());

    first.value.summary = "ZEPSUTE";
    for (const key of Object.keys(first.value)) {
      if (Array.isArray(first.value[key])) first.value[key].push("ZEPSUTE");
    }
    first.warnings.length = 0;
    first.warnings.push({ path: "x", code: "x", message: "x" });

    assert.deepEqual(call(raw), expected, name);
  }

  const rejected = [run({}), run({})];
  assert.notStrictEqual(rejected[0].errors, rejected[1].errors);
  rejected[0].errors.length = 0;
  assert.equal(run({}).errors.length, REQUIRED_FIELDS.length);
});

test("K8 referencje — to samo wejście użyte w kilku miejscach (wspólna tablica, ten sam wpis dwa razy) daje w wyniku osobne tablice i obiekty", () => {
  const shared = ["wspólny wzorzec"];
  const entry = biasEntry();
  const raw = {
    ...validFull(),
    observedPatterns: shared,
    alternativeExplanations: shared,
    possibleBiases: [entry, entry],
  };

  const result = run(raw);

  assertAccepted(result);
  assert.notStrictEqual(
    result.value.observedPatterns,
    result.value.alternativeExplanations,
  );
  assert.notStrictEqual(
    result.value.possibleBiases[0],
    result.value.possibleBiases[1],
  );
  assert.deepEqual(warningPairs(result.warnings), [
    "possibleBiases[1].bias | duplicate_bias",
  ]);

  result.value.observedPatterns.push("dopisane");
  result.value.possibleBiases[0].bias = "zmieniony";

  assert.deepEqual(result.value.alternativeExplanations, ["wspólny wzorzec"]);
  assert.equal(result.value.possibleBiases[1].bias, "niechęć do straty");
  assert.deepEqual(shared, ["wspólny wzorzec"]);
  assert.equal(entry.bias, "niechęć do straty");
  assertNoSharedReferences(raw, result.value);
});

test("K8 referencje — wejście już w postaci kanonicznej (wynik równy wejściu co do wartości): żaden obiekt ani tablica wyniku nie jest elementem wejścia, także dla wszystkich wpisów", () => {
  // Tu deepEqual nie odróżni kopii od oryginału — liczy się wyłącznie tożsamość.
  const entries = ["niechęć do straty", "efekt stadny", "zakotwiczenie"].map(
    (bias) => biasEntry({ bias }),
  );
  const fullRaw = { ...validFull(), possibleBiases: entries };
  const quickRaw = {
    ...validQuick(),
    possibleBiases: ["niechęć do straty", "efekt stadny"],
  };

  for (const [kind, call, raw] of [
    ["full", run, fullRaw],
    ["quickCheck", runQuick, quickRaw],
    ["full (zamrożone)", run, deepFreeze(structuredClone(fullRaw))],
    ["quickCheck (zamrożone)", runQuick, deepFreeze(structuredClone(quickRaw))],
  ]) {
    const result = call(raw);

    assertAccepted(result);
    assert.deepEqual(result.warnings, [], kind);
    assertNoSharedReferences(raw, result.value);

    if (raw.possibleBiases.every((item) => typeof item === "object")) {
      raw.possibleBiases.forEach((entry, index) => {
        assert.notStrictEqual(
          result.value.possibleBiases[index],
          entry,
          `${kind}: possibleBiases[${index}]`,
        );
      });
    }
  }

  assert.deepEqual(run(fullRaw).value.possibleBiases, entries);
});

/* ------------------ nietypowe, ale poprawnie zbudowane wejścia ------------------ */

test("K8 nietypowe wejście — obiekty bez prototypu, pola jako akcesory, klucze symboli i pola niewyliczalne: wynik zawiera tylko dane kontraktu", () => {
  const fields = validFull();
  const entry = Object.assign(Object.create(null), biasEntry());

  fields.possibleBiases = [entry];
  fields.observedPatterns.meta =
    "własność nazwana na tablicy — nie jest elementem listy";

  const raw = Object.create(null);
  for (const key of Object.keys(fields)) {
    Object.defineProperty(raw, key, {
      enumerable: true,
      get: () => fields[key],
    });
  }
  raw[Symbol("meta")] = "klucz symbolu";
  Object.defineProperty(raw, "ukryte", {
    value: "niewyliczalne",
    enumerable: false,
  });

  const result = run(raw);

  assertAccepted(result);
  assert.deepEqual(
    Reflect.ownKeys(result.value).sort(),
    [...REQUIRED_FIELDS].sort(),
  );
  assert.deepEqual(Object.keys(result.value.observedPatterns), ["0", "1"]);
  assert.deepEqual(result.value.observedPatterns, validFull().observedPatterns);
  assert.deepEqual(result.value.possibleBiases, [biasEntry()]);
  assert.ok(
    result.warnings.every((warning) => WARNING_CODES.includes(warning.code)),
  );
  assertPlainResult(result.value);
  assertNoSharedReferences(raw, result.value);
});

test("K8 nietypowe wejście — akcesor zmieniający wartość przy każdym odczycie nie przemyci do wyniku wartości niezgodnej z kontraktem", () => {
  const allowedBiases = new Set([
    ...BIAS_LIST.map((entry) => entry.name),
    OTHER_BIAS,
  ]);

  /** Zwraca raz dobrą, raz złą wartość — w obu kolejnościach. */
  const flip = (good, bad, startWithGood) => {
    const values = startWithGood ? [good, bad] : [bad, good];
    let reads = 0;
    return () => values[reads++ % 2];
  };

  const fullCases = [
    {
      name: "summary",
      make: (get) =>
        Object.defineProperty(validFull(), "summary", {
          enumerable: true,
          get,
        }),
      good: "Dobre podsumowanie.",
      bad: 123,
      check: (value) =>
        assert.ok(typeof value.summary === "string" && value.summary !== ""),
    },
    {
      name: "confidence",
      make: (get) => {
        const entry = Object.defineProperty(biasEntry(), "confidence", {
          enumerable: true,
          get,
        });
        return { ...validFull(), possibleBiases: [entry] };
      },
      good: "medium",
      bad: "very high",
      check: (value) =>
        assert.ok(
          ["low", "medium", "high"].includes(
            value.possibleBiases[0].confidence,
          ),
        ),
    },
    {
      name: "bias",
      make: (get) => {
        const entry = Object.defineProperty(biasEntry(), "bias", {
          enumerable: true,
          get,
        });
        return { ...validFull(), possibleBiases: [entry] };
      },
      good: "niechęć do straty",
      bad: "   ",
      check: (value) =>
        assert.ok(allowedBiases.has(value.possibleBiases[0].bias)),
    },
  ];

  for (const { name, make, good, bad, check } of fullCases) {
    for (const startWithGood of [true, false]) {
      const result = run(make(flip(good, bad, startWithGood)));
      const context = `${name}, start od dobrej: ${startWithGood}`;

      if (result.ok) {
        check(result.value);
      } else {
        assert.ok(result.errors.length > 0, context);
        assert.equal(Object.hasOwn(result, "value"), false, context);
      }
    }
  }

  for (const startWithGood of [true, false]) {
    const raw = Object.defineProperty({ ...validQuick() }, "summary", {
      enumerable: true,
      get: flip("Dobra ocena.", 0, startWithGood),
    });
    const result = runQuick(raw);

    if (result.ok) {
      assert.ok(
        typeof result.value.summary === "string" && result.value.summary !== "",
      );
    } else {
      assert.ok(result.errors.length > 0);
      assert.equal(Object.hasOwn(result, "value"), false);
    }
  }
});

/* ------------------------------------------------------------------ *
 * K9 — odczyt pól raz i kontrolowany błąd, gdy getter rzuca wyjątek
 *
 * Wejście może być zwykłym obiektem JavaScript, więc odczyt pola lub
 * elementu może uruchomić getter. Walidator czyta każde pole dokładnie raz,
 * a wyjątek z gettera zamienia na błąd invalid_structure ze ścieżką pola
 * (zamiast rzucać na zewnątrz). Dla wspieranego wejścia — zwykłego obiektu
 * lub tekstu JSON — na zewnątrz rzuca tylko nieznany lub brakujący `kind`.
 * Obiekty Proxy z rzucającymi pułapkami nie są wspieranym wejściem i nie są
 * tu testowane.
 * ------------------------------------------------------------------ */

const THROWING_MESSAGE = "TAJNY-KOMUNIKAT-GETTERA";

const throwingGetter = () => {
  throw new Error(THROWING_MESSAGE);
};

/** Pole z gettera, który liczy odczyty i zwraca zadaną wartość. */
function countingField(target, key, value) {
  const counter = { reads: 0 };

  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      counter.reads += 1;
      return value;
    },
  });

  return counter;
}

/** Pola odpowiedzi pełnej: [ścieżka, funkcja ustawiająca akcesor na świeżym obiekcie, poprawna wartość]. */
const FULL_ACCESSOR_CASES = [
  ...REQUIRED_FIELDS.map((key) => [
    key,
    (raw, define) => define(raw, key),
    validFull()[key],
  ]),
  ...["bias", "confidence", "supportingEvidence", "contradictingEvidence"].map(
    (key) => [
      `possibleBiases[0].${key}`,
      (raw, define) => define(raw.possibleBiases[0], key),
      biasEntry()[key],
    ],
  ),
];

const QUICK_ACCESSOR_CASES = QUICK_CONTRACT_KEYS.map((key) => [
  key,
  (raw, define) => define(raw, key),
  validQuick()[key],
]);

test("K9 getter rzucający wyjątek — pełna analiza: kontrolowany błąd invalid_structure ze ścieżką pola, bez wyjątku na zewnątrz (każde pole kontraktu, także we wpisie possibleBiases)", () => {
  for (const [path, install] of FULL_ACCESSOR_CASES) {
    const raw = validFull();
    install(raw, (target, key) =>
      Object.defineProperty(target, key, {
        enumerable: true,
        get: throwingGetter,
      }),
    );

    let result;
    assert.doesNotThrow(() => {
      result = run(raw);
    }, path);

    assertRejected(result, [[path, "invalid_structure"]]);
    assert.equal(Object.hasOwn(result, "value"), false, path);
    assert.equal(
      JSON.stringify(result.errors).includes(THROWING_MESSAGE),
      false,
      `${path}: treść wyjątku nie powinna trafiać do komunikatu`,
    );
  }
});

test("K9 getter rzucający wyjątek — quickCheck: kontrolowany błąd invalid_structure ze ścieżką pola", () => {
  for (const [path, install] of QUICK_ACCESSOR_CASES) {
    const raw = validQuick();
    install(raw, (target, key) =>
      Object.defineProperty(target, key, {
        enumerable: true,
        get: throwingGetter,
      }),
    );

    let result;
    assert.doesNotThrow(() => {
      result = runQuick(raw);
    }, path);

    assertRejected(result, [[path, "invalid_structure"]]);
    assert.equal(Object.hasOwn(result, "value"), false, path);
    assert.equal(
      JSON.stringify(result.errors).includes(THROWING_MESSAGE),
      false,
      path,
    );
  }
});

test("K9 getter rzucający wyjątek — nie przesłania innych problemów: wszystkie błędy zostają zgłoszone, a pole z getterem nie dostaje dodatkowego missing_field ani invalid_type", () => {
  const full = validFull();
  Object.defineProperty(full, "summary", {
    enumerable: true,
    get: throwingGetter,
  });
  full.limitations = 42;
  full.possibleBiases[0].confidence = "very high";
  Object.defineProperty(full.possibleBiases[0], "bias", {
    enumerable: true,
    get: throwingGetter,
  });

  assertRejected(run(full), [
    ["summary", "invalid_structure"],
    ["limitations", "invalid_type"],
    ["possibleBiases[0].bias", "invalid_structure"],
    ["possibleBiases[0].confidence", "invalid_confidence"],
  ]);

  const quick = validQuick();
  Object.defineProperty(quick, "limitations", {
    enumerable: true,
    get: throwingGetter,
  });
  quick.summary = "   ";

  assertRejected(runQuick(quick), [
    ["limitations", "invalid_structure"],
    ["summary", "empty_value"],
  ]);
});

test("K9 getter rzucający wyjątek — element tablicy: błąd invalid_structure ze ścieżką elementu, pozostałe elementy nadal sprawdzane", () => {
  const throwingElement = (list, index) =>
    Object.defineProperty(list, index, {
      enumerable: true,
      configurable: true,
      get: throwingGetter,
    });

  const raw = validFull();
  throwingElement(raw.observedPatterns, 0);
  raw.alternativeExplanations = ["ok", "  ", "ok"];
  throwingElement(raw.alternativeExplanations, 2);
  raw.possibleBiases = [
    biasEntry(),
    biasEntry(),
    biasEntry({ confidence: "very high" }),
  ];
  throwingElement(raw.possibleBiases, 1);

  assertRejected(run(raw), [
    ["observedPatterns[0]", "invalid_structure"],
    ["alternativeExplanations[1]", "empty_value"],
    ["alternativeExplanations[2]", "invalid_structure"],
    ["possibleBiases[1]", "invalid_structure"],
    ["possibleBiases[2].confidence", "invalid_confidence"],
  ]);

  const quick = validQuick();
  quick.possibleBiases = ["niechęć do straty", "x", "zakotwiczenie", ""];
  throwingElement(quick.possibleBiases, 1);

  assertRejected(runQuick(quick), [
    ["possibleBiases[1]", "invalid_structure"],
    ["possibleBiases[3]", "invalid_bias"],
  ]);
});

test("K9 odczyt raz — każde pole kontraktu (i element tablicy) jest odczytywane dokładnie raz, w pełnej analizie i w quickChecku, także przy odrzuceniu", () => {
  for (const [path, install, value] of FULL_ACCESSOR_CASES) {
    const raw = validFull();
    let counter;
    install(raw, (target, key) => {
      counter = countingField(target, key, value);
    });

    assertAccepted(run(raw));
    assert.equal(counter.reads, 1, `${path} (przyjęcie)`);

    const rejected = validFull();
    install(rejected, (target, key) => {
      counter = countingField(target, key, 12345);
    });

    assert.equal(run(rejected).ok, false, path);
    assert.equal(counter.reads, 1, `${path} (odrzucenie)`);
  }

  for (const [path, install, value] of QUICK_ACCESSOR_CASES) {
    const raw = validQuick();
    let counter;
    install(raw, (target, key) => {
      counter = countingField(target, key, value);
    });

    assertAccepted(runQuick(raw));
    assert.equal(counter.reads, 1, `quickCheck ${path}`);
  }

  const elementReads = [];
  const lists = {
    observedPatterns: ["a", "b"],
    alternativeExplanations: ["c"],
    possibleBiases: [biasEntry(), biasEntry({ bias: "zakotwiczenie" })],
  };

  for (const [name, list] of Object.entries(lists)) {
    list.forEach((item, index) => {
      const counter = countingField(list, index, item);
      elementReads.push([`${name}[${index}]`, counter]);
    });
  }

  assertAccepted(run({ ...validFull(), ...lists }));

  for (const [path, counter] of elementReads) {
    assert.equal(counter.reads, 1, path);
  }

  const quickList = ["niechęć do straty", "zakotwiczenie"];
  const quickCounters = quickList.map((item, index) =>
    countingField(quickList, index, item),
  );

  assertAccepted(runQuick({ ...validQuick(), possibleBiases: quickList }));
  quickCounters.forEach((counter, index) =>
    assert.equal(counter.reads, 1, `quickCheck possibleBiases[${index}]`),
  );
});

test("K9 getter rzucający wyjątek — nie zmienia reguł: dla wspieranego wejścia nadal rzuca tylko nieznany lub brakujący `kind`, a wejście tekstowe i pola obce zachowują się jak dotąd", () => {
  const raw = validFull();
  Object.defineProperty(raw, "summary", {
    enumerable: true,
    get: throwingGetter,
  });

  assert.throws(() => validateAiResponse(raw, { kind: "nieznany" }), /kind/);
  assert.throws(() => validateAiResponse(raw), /kind/);

  // pole obce z getterem rzucającym nadal nie jest czytane — tylko ostrzeżenie
  const extra = validFull();
  Object.defineProperty(extra, "obcePole", {
    enumerable: true,
    get: throwingGetter,
  });
  const accepted = run(extra);

  assertAccepted(accepted);
  assert.deepEqual(warningPairs(accepted.warnings), [
    "obcePole | unknown_field_removed",
  ]);

  // ten sam obiekt jako tekst JSON daje wynik bez błędów
  assertAccepted(run(JSON.stringify(validFull())));
});

test("K9 pola dodatkowe — ostrzeżenia obejmują tylko własne, wyliczalne klucze tekstowe (Object.keys); klucze symboliczne i niewyliczalne nie są zgłaszane, a wynik i tak ich nie zawiera", () => {
  const full = validFull();
  full.obcePole = 1;
  full[Symbol("symboliczne")] = "x";
  Object.defineProperty(full, "niewyliczalne", {
    value: "y",
    enumerable: false,
  });

  const result = run(full);

  assertAccepted(result);
  assert.deepEqual(warningPairs(result.warnings), [
    "obcePole | unknown_field_removed",
  ]);
  assert.deepEqual(
    Reflect.ownKeys(result.value).sort(),
    [...REQUIRED_FIELDS].sort(),
  );

  const quick = validQuick();
  quick[Symbol("symboliczne")] = "x";
  Object.defineProperty(quick, "niewyliczalne", {
    value: "y",
    enumerable: false,
  });

  const quickResult = runQuick(quick);

  assertAccepted(quickResult);
  assert.deepEqual(quickResult.warnings, []);
  assert.deepEqual(
    Reflect.ownKeys(quickResult.value).sort(),
    [...QUICK_VALUE_KEYS].sort(),
  );
});

test("K8 nietypowe wejście — pole obce z odwołaniem cyklicznym lub bardzo głębokim zagnieżdżeniem nie jest przeglądane (brak przepełnienia stosu), a wejście przechodzi", () => {
  const cyclic = { name: "cykl" };
  cyclic.self = cyclic;

  let deep = {};
  const root = deep;
  for (let level = 0; level < 100000; level += 1) {
    deep.next = {};
    deep = deep.next;
  }

  const full = run({
    ...validFull(),
    cyklicznePole: cyclic,
    glebokiePole: root,
  });
  const quick = runQuick({
    ...validQuick(),
    cyklicznePole: cyclic,
    glebokiePole: root,
  });

  for (const result of [full, quick]) {
    assertAccepted(result);
    assert.deepEqual(warningPairs(result.warnings), [
      "cyklicznePole | unknown_field_removed",
      "glebokiePole | unknown_field_removed",
    ]);
    assertPlainResult(result.value);
  }
});

test("K8 dziedziczenie — pola kontraktu odziedziczone z prototypu nie są czytane (zanieczyszczony Object.prototype nie uzupełnia brakujących pól)", () => {
  const contractNames = [
    ...new Set([
      ...REQUIRED_FIELDS,
      "bias",
      "confidence",
      "supportingEvidence",
      "contradictingEvidence",
    ]),
  ];
  // withPrototypeMutations odtwarza pierwotne deskryptory w finally (także po wyjątku)
  const results = withPrototypeMutations(
    () => {
      for (const name of contractNames) {
        Object.defineProperty(Object.prototype, name, {
          value: name === "possibleBiases" ? [] : "odziedziczone",
          configurable: true,
          writable: true,
          enumerable: false,
        });
      }
    },
    () => ({
      fullObject: run({}),
      fullText: run("{}"),
      entry: runWithEntries([{}]),
      quick: runQuick({}),
    }),
  );

  assertPrototypesClean();

  const allMissing = REQUIRED_FIELDS.map((field) => [field, "missing_field"]);

  assertRejected(results.fullObject, allMissing);
  assertRejected(results.fullText, allMissing);
  assertRejected(results.entry, [
    ["possibleBiases[0].bias", "missing_field"],
    ["possibleBiases[0].confidence", "missing_field"],
    ["possibleBiases[0].supportingEvidence", "missing_field"],
  ]);
  assertRejected(results.quick, [
    ["summary", "missing_field"],
    ["possibleBiases", "missing_field"],
    ["limitations", "missing_field"],
  ]);
});

test("K8 dziedziczenie — obiekt z cudzym prototypem (także zadanym przez __proto__ w literale) nie jest zwykłym obiektem, więc dziedziczone pola go nie ratują", () => {
  const viaLiteral = { __proto__: validFull() };
  const viaCreate = Object.create(validFull());
  const quickViaLiteral = { __proto__: validQuick() };

  for (const input of [viaLiteral, viaCreate]) {
    assertRejected(run(input), [["$", "invalid_structure"]]);
  }

  assertRejected(runQuick(quickViaLiteral), [["$", "invalid_structure"]]);
  assertPrototypesClean();
});

/* ----------------- bezpieczeństwo: __proto__, constructor, prototype ----------------- */

test("K8 bezpieczeństwo — full, tekst JSON: każda specjalna nazwa osobno, na każdym poziomie (góra, wpis, pola obce, głębokie zagnieżdżenie) nie trafia do wyniku i nie zmienia prototypów", () => {
  for (const name of SPECIAL_KEYS) {
    const nestedForeign = `"obcePole":{"${name}":${POLLUTION_PAYLOAD},"w":[{"${name}":[1]}]}`;

    // poziom 1: góra odpowiedzi
    const topText = jsonWithSnippet(
      validFull(),
      `"${name}":${POLLUTION_PAYLOAD}`,
    );
    assert.ok(
      Object.hasOwn(JSON.parse(topText), name),
      `kontrola: ${name} jest własnym kluczem (góra)`,
    );

    const top = run(topText);
    assertAccepted(top);
    assert.deepEqual(warningPairs(top.warnings), [
      `${name} | unknown_field_removed`,
    ]);
    assert.deepEqual(Object.keys(top.value).sort(), FULL_TOP_KEYS);

    // poziom 2: wpis possibleBiases[]
    const entryJson = JSON.stringify({
      ...validFull(),
      possibleBiases: [{ __placeholder__: 1, ...biasEntry() }],
    }).replace(PLACEHOLDER, `"${name}":${POLLUTION_PAYLOAD}`);
    assert.ok(
      Object.hasOwn(JSON.parse(entryJson).possibleBiases[0], name),
      `kontrola: ${name} jest własnym kluczem (wpis)`,
    );

    const entry = run(entryJson);
    assertAccepted(entry);
    assert.deepEqual(warningPairs(entry.warnings), [
      `possibleBiases[0].${name} | unknown_field_removed`,
    ]);
    assert.deepEqual(
      Object.keys(entry.value.possibleBiases[0]).sort(),
      FULL_ENTRY_KEYS,
    );

    // poziom 3: zagnieżdżone w polach obcych (góra i wpis)
    const foreignTop = run(jsonWithSnippet(validFull(), nestedForeign));
    assertAccepted(foreignTop);
    assert.deepEqual(warningPairs(foreignTop.warnings), [
      "obcePole | unknown_field_removed",
    ]);

    const foreignEntryJson = JSON.stringify({
      ...validFull(),
      possibleBiases: [{ __placeholder__: 1, ...biasEntry() }],
    }).replace(PLACEHOLDER, nestedForeign);
    const foreignEntry = run(foreignEntryJson);
    assertAccepted(foreignEntry);
    assert.deepEqual(warningPairs(foreignEntry.warnings), [
      "possibleBiases[0].obcePole | unknown_field_removed",
    ]);

    // wynik po usunięciu pól jest identyczny z wynikiem czystego wejścia
    const cleanTop = run(validFull()).value;
    const cleanEntry = runWithEntries([biasEntry()]).value;

    for (const [result, clean] of [
      [top, cleanTop],
      [entry, cleanEntry],
      [foreignTop, cleanTop],
      [foreignEntry, cleanEntry],
    ]) {
      assertPlainResult(result.value);

      for (const [path, node] of collectNodes(result.value)) {
        assert.equal(
          Object.hasOwn(node, name),
          false,
          `${path} ma pole ${name}`,
        );
      }

      assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS);
      assert.deepEqual(
        Object.keys(result.value.possibleBiases[0]).sort(),
        FULL_ENTRY_KEYS,
      );
      assert.deepEqual(result.value, clean);
    }

    assertPrototypesClean();
  }
});

test("K8 bezpieczeństwo — full, wejście obiektowe z własnym kluczem o specjalnej nazwie (nie literał): na górze i we wpisie jest usuwane, bez zmiany prototypu wyniku", () => {
  for (const name of SPECIAL_KEYS) {
    const entry = withOwnKey(biasEntry(), name, { polluted: true, x: 1 });
    const raw = withOwnKey({ ...validFull(), possibleBiases: [entry] }, name, {
      polluted: true,
      x: 1,
    });

    assert.ok(
      Object.hasOwn(raw, name) && Object.hasOwn(entry, name),
      "kontrola: klucze są własne",
    );

    const result = run(raw);

    assertAccepted(result);
    assert.deepEqual(
      warningPairs(result.warnings),
      [
        `${name} | unknown_field_removed`,
        `possibleBiases[0].${name} | unknown_field_removed`,
      ].sort(),
    );
    assert.deepEqual(Object.keys(result.value).sort(), FULL_TOP_KEYS);
    assert.deepEqual(
      Object.keys(result.value.possibleBiases[0]).sort(),
      FULL_ENTRY_KEYS,
    );
    assertPlainResult(result.value);
    assertNoSharedReferences(raw, result.value);
    assertPrototypesClean();
  }
});

test("K8 bezpieczeństwo — full: specjalne nazwy w miejscu pola kontraktu (obiekt zamiast tekstu lub listy) dają zwykłe błędy typu i nic nie zmieniają", () => {
  for (const name of SPECIAL_KEYS) {
    const payload = `"${name}":${POLLUTION_PAYLOAD}`;

    const asSummary = run(
      JSON.stringify({ ...validFull(), summary: "__S__" }).replace(
        '"__S__"',
        `{${payload}}`,
      ),
    );
    assertRejected(asSummary, [["summary", "invalid_type"]]);

    const asList = run(
      JSON.stringify({ ...validFull(), possibleBiases: "__L__" }).replace(
        '"__L__"',
        `{${payload}}`,
      ),
    );
    assertRejected(asList, [["possibleBiases", "invalid_type"]]);

    const asEntry = run(
      JSON.stringify({ ...validFull(), possibleBiases: ["__E__"] }).replace(
        '"__E__"',
        `{${payload}}`,
      ),
    );
    assertRejected(asEntry, [
      ["possibleBiases[0].bias", "missing_field"],
      ["possibleBiases[0].confidence", "missing_field"],
      ["possibleBiases[0].supportingEvidence", "missing_field"],
    ]);

    assertPrototypesClean();
  }
});

test("K8 bezpieczeństwo — quickCheck, tekst JSON i obiekt: każda specjalna nazwa osobno (góra, pola obce, element listy, obiekt w miejscu listy) nie trafia do wyniku i nie zmienia prototypów", () => {
  for (const name of SPECIAL_KEYS) {
    const payload = `"${name}":${POLLUTION_PAYLOAD}`;

    const topText = jsonWithSnippet(validQuick(), payload);
    assert.ok(
      Object.hasOwn(JSON.parse(topText), name),
      `kontrola: ${name} jest własnym kluczem`,
    );

    const foreignText = jsonWithSnippet(
      validQuick(),
      `"obcePole":{"${name}":${POLLUTION_PAYLOAD},"w":[{"${name}":[1]}]}`,
    );
    const objectInput = withOwnKey({ ...validQuick() }, name, {
      polluted: true,
      x: 1,
    });

    const accepted = [
      [runQuick(topText), [`${name} | unknown_field_removed`]],
      [runQuick(foreignText), ["obcePole | unknown_field_removed"]],
      [runQuick(objectInput), [`${name} | unknown_field_removed`]],
    ];

    for (const [result, warnings] of accepted) {
      assertAccepted(result);
      assert.deepEqual(warningPairs(result.warnings), warnings);
      assert.deepEqual(Object.keys(result.value).sort(), QUICK_VALUE_KEYS);
      assert.deepEqual(result.value, runQuick(validQuick()).value);
      assertPlainResult(result.value);

      for (const [path, node] of collectNodes(result.value)) {
        assert.equal(
          Object.hasOwn(node, name),
          false,
          `${path} ma pole ${name}`,
        );
      }
    }

    // element listy będący obiektem z taką nazwą: zwykły błąd, bez skutków ubocznych
    const elementText = JSON.stringify({
      ...validQuick(),
      possibleBiases: ["__E__", "FOMO"],
    }).replace('"__E__"', `{${payload}}`);
    assert.ok(Object.hasOwn(JSON.parse(elementText).possibleBiases[0], name));
    assertRejected(runQuick(elementText), [
      ["possibleBiases[0]", "invalid_bias"],
    ]);

    // obiekt w miejscu listy
    const listText = JSON.stringify({
      ...validQuick(),
      possibleBiases: "__L__",
    }).replace('"__L__"', `{${payload}}`);
    assertRejected(runQuick(listText), [["possibleBiases", "invalid_type"]]);

    assertPrototypesClean();
  }
});

test("K8 bezpieczeństwo — specjalne nazwy jako WARTOŚCI (nazwa biasu, etykieta, confidence) są zwykłym tekstem: nieznany bias z etykietą albo błąd, bez skutków ubocznych", () => {
  const names = [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "__defineGetter__",
    "__lookupGetter__",
  ];

  for (const name of names) {
    assert.deepEqual(
      resolveBias(name),
      { bias: OTHER_BIAS, match: "unknown", proposedLabel: name },
      name,
    );
  }

  // full: nazwa biasu
  const fullEntries = names.map((name) => biasEntry({ bias: name }));
  const fromObject = runWithEntries(fullEntries);
  const fromText = run(
    JSON.stringify({ ...validFull(), possibleBiases: fullEntries }),
  );

  for (const result of [fromObject, fromText]) {
    assertAccepted(result);
    assert.deepEqual(
      result.value.possibleBiases.map((entry) => [
        entry.bias,
        entry.proposedLabel,
      ]),
      names.map((name) => [OTHER_BIAS, name]),
    );
    assert.deepEqual(
      warningPairs(result.warnings),
      names
        .map((_, index) => `possibleBiases[${index}].bias | bias_unmapped`)
        .sort(),
    );
    assertPlainResult(result.value);
  }

  // full: confidence
  for (const name of names) {
    assertRejected(runWithEntries([biasEntry({ confidence: name })]), [
      ["possibleBiases[0].confidence", "invalid_confidence"],
    ]);
  }

  // quickCheck: nazwy i duplikat (po normalizacji wielkości liter)
  const quick = quickWith(names);

  assertAccepted(quick);
  assert.deepEqual(quick.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(quick.value.proposedBiasLabels, names);
  assert.deepEqual(
    warningPairs(quick.warnings),
    names.map((_, index) => `possibleBiases[${index}] | bias_unmapped`).sort(),
  );
  assertPlainResult(quick.value);

  const duplicate = quickWith(["__proto__", "__PROTO__"]);

  assertAccepted(duplicate);
  assert.deepEqual(duplicate.value.proposedBiasLabels, ["__proto__"]);
  assert.deepEqual(warningPairs(duplicate.warnings), [
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[1] | duplicate_bias",
  ]);

  assertPrototypesClean();
});

/* ------------------------- brak limitów (D5) ------------------------- */

const HUGE = 300000;
const bigText = (char) => char.repeat(HUGE);

test("K8 brak limitów (D5) — full: bardzo długie teksty we wszystkich polach tekstowych i długa nazwa nieznanego biasu są zachowane w całości (tylko przycięcie brzegów), bez ostrzeżeń z powodu długości", () => {
  const raw = {
    summary: `  ${bigText("S")}  `,
    observedPatterns: [bigText("O")],
    possibleBiases: [
      {
        bias: "niechęć do straty",
        confidence: "low",
        supportingEvidence: `\n${bigText("E")}\n`,
        contradictingEvidence: bigText("C"),
      },
      {
        bias: bigText("N"),
        confidence: "high",
        supportingEvidence: "krótki dowód",
      },
    ],
    alternativeExplanations: [bigText("A")],
    limitations: `a${" ".repeat(HUGE)}b`,
    outcomeNote: bigText("W"),
  };

  for (const [source, result] of [
    ["obiekt", run(raw)],
    ["tekst JSON", run(JSON.stringify(raw))],
  ]) {
    assertAccepted(result);

    const { value } = result;

    assert.ok(value.summary === bigText("S"), `${source}: summary`);
    assert.ok(
      value.observedPatterns[0] === bigText("O"),
      `${source}: observedPatterns`,
    );
    assert.ok(
      value.possibleBiases[0].supportingEvidence === bigText("E"),
      `${source}: supportingEvidence`,
    );
    assert.ok(
      value.possibleBiases[0].contradictingEvidence === bigText("C"),
      `${source}: contradictingEvidence`,
    );
    assert.equal(value.possibleBiases[1].bias, OTHER_BIAS);
    assert.ok(
      value.possibleBiases[1].proposedLabel === bigText("N"),
      `${source}: proposedLabel`,
    );
    assert.ok(
      value.alternativeExplanations[0] === bigText("A"),
      `${source}: alternativeExplanations`,
    );
    assert.ok(
      value.limitations === raw.limitations,
      `${source}: limitations (odstępy wewnątrz bez zmian)`,
    );
    assert.ok(value.outcomeNote === bigText("W"), `${source}: outcomeNote`);

    // jedyne ostrzeżenie dotyczy nieznanego biasu; rozmiar nie wywołuje żadnego
    assert.deepEqual(warningPairs(result.warnings), [
      "possibleBiases[1].bias | bias_unmapped",
    ]);
    assert.ok(result.warnings.every((warning) => warning.message.length < 200));
  }
});

test("K8 brak limitów (D5) — full: kilka tysięcy elementów w każdej liście; normalizacja i duplikaty działają jak zwykle, a liczba elementów nie daje ostrzeżeń", () => {
  const COUNT = 5000;
  const ENTRIES = 3000;
  const patterns = Array.from(
    { length: COUNT },
    (_, index) => `wzorzec ${index}`,
  );
  const alternatives = Array.from(
    { length: COUNT },
    (_, index) => `alternatywa ${index}`,
  );
  const names = Array.from(
    { length: ENTRIES },
    (_, index) => `nieznany bias ${index}`,
  );

  const unknown = run({
    ...validFull(),
    observedPatterns: patterns,
    alternativeExplanations: alternatives,
    possibleBiases: names.map((bias) => biasEntry({ bias })),
  });

  assertAccepted(unknown);
  assert.deepEqual(unknown.value.observedPatterns, patterns);
  assert.deepEqual(unknown.value.alternativeExplanations, alternatives);
  assert.deepEqual(
    unknown.value.possibleBiases.map((entry) => entry.proposedLabel),
    names,
  );
  assert.deepEqual(countByCode(unknown.warnings), { bias_unmapped: ENTRIES });

  // ten sam bias zapisany na trzy sposoby: wszystkie wpisy zostają, duplikat dostaje każde późniejsze
  const spellings = ["Loss Aversion", "niechęć do straty", " LOSS   AVERSION "];
  const repeated = Array.from({ length: ENTRIES }, (_, index) =>
    biasEntry({ bias: spellings[index % 3] }),
  );
  const raw = { ...validFull(), possibleBiases: repeated };

  const fromObject = run(raw);
  const fromText = run(JSON.stringify(raw));

  for (const result of [fromObject, fromText]) {
    assertAccepted(result);
    assert.equal(result.value.possibleBiases.length, ENTRIES);
    assert.ok(
      result.value.possibleBiases.every(
        (entry) => entry.bias === "niechęć do straty",
      ),
    );
    assert.deepEqual(countByCode(result.warnings), {
      duplicate_bias: ENTRIES - 1,
    });
    assert.equal(result.warnings[0].path, "possibleBiases[1].bias");
    assert.equal(
      result.warnings.at(-1).path,
      `possibleBiases[${ENTRIES - 1}].bias`,
    );
  }

  assert.ok(
    JSON.stringify(fromObject) === JSON.stringify(fromText),
    "obiekt i tekst JSON dają ten sam wynik",
  );
});

test("K8 brak limitów (D5) — quickCheck: ostrzeżenia wynikają tylko z treści (nie z rozmiaru), a dedupe i normalizacja działają na dużych listach i długich nazwach", () => {
  const COUNT = 5000;
  const names = Array.from(
    { length: COUNT },
    (_, index) => `nieznany bias numer ${index}`,
  );
  const distinct = quickWith(names);

  assertAccepted(distinct);
  assert.deepEqual(distinct.value.possibleBiases, [OTHER_BIAS]);
  assert.deepEqual(distinct.value.proposedBiasLabels, names);
  assert.deepEqual(countByCode(distinct.warnings), { bias_unmapped: COUNT });

  const cycle = ["FOMO", "Anchoring", "confirmation loop"];
  const repeated = Array.from({ length: 6000 }, (_, index) => cycle[index % 3]);
  const deduped = quickWith(repeated);

  assertAccepted(deduped);
  assert.deepEqual(deduped.value.possibleBiases, [OTHER_BIAS, "zakotwiczenie"]);
  assert.deepEqual(deduped.value.proposedBiasLabels, [
    "FOMO",
    "confirmation loop",
  ]);
  assert.deepEqual(countByCode(deduped.warnings), {
    bias_unmapped: 2,
    duplicate_bias: 6000 - 3,
  });

  const raw = {
    summary: `  ${bigText("S")}  `,
    possibleBiases: [bigText("N"), "Anchoring"],
    limitations: `a${" ".repeat(HUGE)}b`,
  };

  for (const [source, result] of [
    ["obiekt", runQuick(raw)],
    ["tekst JSON", runQuick(JSON.stringify(raw))],
  ]) {
    assertAccepted(result);
    assert.ok(result.value.summary === bigText("S"), `${source}: summary`);
    assert.ok(
      result.value.limitations === raw.limitations,
      `${source}: limitations`,
    );
    assert.ok(
      result.value.proposedBiasLabels[0] === bigText("N"),
      `${source}: etykieta`,
    );
    assert.equal(result.value.proposedBiasLabels.length, 1);
    assert.deepEqual(result.value.possibleBiases, [
      OTHER_BIAS,
      "zakotwiczenie",
    ]);
    assert.deepEqual(warningPairs(result.warnings), [
      "possibleBiases[0] | bias_unmapped",
    ]);
  }
});

/* -------------------- wiele problemów naraz, bez utraty informacji -------------------- */

test("K8 wiele problemów — full: odrzucenie zgłasza wszystkie błędy (bez ostrzeżeń), a po naprawieniu samych błędów te same pola obce, normalizacje i duplikaty dają komplet ostrzeżeń", () => {
  const broken = {
    observedPatterns: ["ok", 5, ""],
    possibleBiases: [
      {
        bias: "FOMO",
        confidence: "very high",
        supportingEvidence: "   ",
        extra: 1,
      },
      null,
      {
        bias: "",
        confidence: "MEDIUM",
        supportingEvidence: "x",
        analyzedAt: "x",
      },
      "tekst",
    ],
    alternativeExplanations: "nie lista",
    limitations: 5,
    obcePole: 1,
    inputSnapshot: {},
  };

  const rejected = run(structuredClone(broken));

  assertRejected(rejected, [
    ["summary", "missing_field"],
    ["observedPatterns[1]", "invalid_type"],
    ["observedPatterns[2]", "empty_value"],
    ["possibleBiases[0].confidence", "invalid_confidence"],
    ["possibleBiases[0].supportingEvidence", "empty_value"],
    ["possibleBiases[1]", "invalid_type"],
    ["possibleBiases[2].bias", "invalid_bias"],
    ["possibleBiases[3]", "invalid_type"],
    ["alternativeExplanations", "invalid_type"],
    ["limitations", "invalid_type"],
    ["outcomeNote", "missing_field"],
  ]);
  assert.equal(Object.hasOwn(rejected, "warnings"), false);
  assert.equal(Object.hasOwn(rejected, "value"), false);

  // te same pola obce / backendu / normalizacje co wyżej, ale bez błędów
  const repaired = {
    summary: "Podsumowanie.",
    observedPatterns: ["ok", "drugi", "trzeci"],
    possibleBiases: [
      {
        bias: "FOMO",
        confidence: "high",
        supportingEvidence: "dowód",
        extra: 1,
      },
      { bias: "Anchoring", confidence: "low", supportingEvidence: "dowód" },
      {
        bias: "Loss Aversion",
        confidence: "MEDIUM",
        supportingEvidence: "x",
        analyzedAt: "x",
      },
      { bias: "niechęć do straty", confidence: "low", supportingEvidence: "y" },
    ],
    alternativeExplanations: ["a"],
    limitations: "l",
    outcomeNote: "o",
    obcePole: 1,
    inputSnapshot: {},
  };

  const accepted = run(repaired);

  assertAccepted(accepted);
  assert.deepEqual(warningPairs(accepted.warnings), [
    "inputSnapshot | backend_field_removed",
    "obcePole | unknown_field_removed",
    "possibleBiases[0].bias | bias_unmapped",
    "possibleBiases[0].extra | unknown_field_removed",
    "possibleBiases[2].analyzedAt | backend_field_removed",
    "possibleBiases[2].confidence | confidence_normalized",
    "possibleBiases[3].bias | duplicate_bias",
  ]);
  assert.deepEqual(
    accepted.value.possibleBiases.map((entry) => entry.bias),
    [OTHER_BIAS, "zakotwiczenie", "niechęć do straty", "niechęć do straty"],
  );
});

test("K8 wiele problemów — quickCheck: odrzucenie zgłasza wszystkie błędy (bez ostrzeżeń), a po naprawieniu samych błędów komplet ostrzeżeń i poprawny wynik", () => {
  const rejected = runQuick({
    summary: 5,
    possibleBiases: ["FOMO", 7, "", "Anchoring", "anchoring"],
    analyzedAt: "x",
    obcePole: 1,
  });

  assertRejected(rejected, [
    ["summary", "invalid_type"],
    ["possibleBiases[1]", "invalid_bias"],
    ["possibleBiases[2]", "invalid_bias"],
    ["limitations", "missing_field"],
  ]);
  assert.equal(Object.hasOwn(rejected, "warnings"), false);

  const accepted = runQuick({
    summary: "Ocena.",
    possibleBiases: ["FOMO", "Loss Aversion", "FOMO", "Anchoring", "anchoring"],
    limitations: "l",
    analyzedAt: "x",
    obcePole: 1,
  });

  assertAccepted(accepted);
  assert.deepEqual(accepted.value.possibleBiases, [
    OTHER_BIAS,
    "niechęć do straty",
    "zakotwiczenie",
  ]);
  assert.deepEqual(accepted.value.proposedBiasLabels, ["FOMO"]);
  assert.deepEqual(warningPairs(accepted.warnings), [
    "analyzedAt | backend_field_removed",
    "obcePole | unknown_field_removed",
    "possibleBiases[0] | bias_unmapped",
    "possibleBiases[2] | duplicate_bias",
    "possibleBiases[4] | duplicate_bias",
  ]);
});

test("K9 pomocnik prototypów — wykrywa dodanie, usunięcie, zmianę wartości i deskryptora (także symboli), zmianę prototypu prototypu i utratę rozszerzalności; cofa to, co odwracalne (także po wyjątku), a zmian nieodwracalnych nie ukrywa", () => {
  const stringProbe = "__k9Probe__";
  const symbolProbe = Symbol("k9Probe");
  const original = {
    value: "oryginał",
    writable: false,
    enumerable: false,
    configurable: true,
  };

  const differencesAfter = (mutate, baseline) =>
    withPrototypeMutations(mutate, () =>
      diffPrototypeSnapshots(baseline, snapshotPrototypes()),
    );

  // właściwości istniejące na początku scenariusza: tekstowa (Object.prototype) i symboliczna (Array.prototype)
  withPrototypeMutations(
    () => {
      Object.defineProperty(Object.prototype, stringProbe, original);
      Object.defineProperty(Array.prototype, symbolProbe, original);
    },
    () => {
      const baseline = snapshotPrototypes();

      assert.deepEqual(
        differencesAfter(() => {}, baseline),
        [],
        "brak zmian = brak różnic",
      );

      const scenarios = [
        [
          "dodanie właściwości tekstowej",
          () =>
            Object.defineProperty(Object.prototype, "__k9Added__", {
              value: 1,
              configurable: true,
            }),
          "Object.prototype: dodano właściwość __k9Added__",
        ],
        [
          "dodanie właściwości symbolicznej",
          () =>
            Object.defineProperty(Array.prototype, Symbol.for("k9Added"), {
              value: 1,
              configurable: true,
            }),
          "Array.prototype: dodano właściwość Symbol(k9Added)",
        ],
        [
          "usunięcie właściwości tekstowej",
          () => delete Object.prototype[stringProbe],
          `Object.prototype: usunięto właściwość ${stringProbe}`,
        ],
        [
          "usunięcie właściwości symbolicznej",
          () => delete Array.prototype[symbolProbe],
          "Array.prototype: usunięto właściwość Symbol(k9Probe)",
        ],
        [
          "zmiana wartości (ta sama flaga)",
          () =>
            Object.defineProperty(Object.prototype, stringProbe, {
              value: "podmieniona",
            }),
          `Object.prototype: zmieniono deskryptor lub wartość właściwości ${stringProbe}`,
        ],
        [
          "zmiana wartości właściwości symbolicznej",
          () =>
            Object.defineProperty(Array.prototype, symbolProbe, {
              value: "podmieniona",
            }),
          "Array.prototype: zmieniono deskryptor lub wartość właściwości Symbol(k9Probe)",
        ],
        [
          "zmiana samej flagi (enumerable) przy tej samej wartości",
          () =>
            Object.defineProperty(Object.prototype, stringProbe, {
              enumerable: true,
            }),
          `Object.prototype: zmieniono deskryptor lub wartość właściwości ${stringProbe}`,
        ],
        [
          "zamiana właściwości danych na akcesor",
          () =>
            Object.defineProperty(Object.prototype, stringProbe, {
              get: () => "oryginał",
              set: undefined,
              enumerable: false,
              configurable: true,
            }),
          `Object.prototype: zmieniono deskryptor lub wartość właściwości ${stringProbe}`,
        ],
      ];

      for (const [name, mutate, expected] of scenarios) {
        assert.deepEqual(differencesAfter(mutate, baseline), [expected], name);
      }

      // po każdym scenariuszu stan jest odtworzony — migawka nadal równa bazowej
      assert.deepEqual(
        diffPrototypeSnapshots(baseline, snapshotPrototypes()),
        [],
      );
    },
  );

  // pierwotne deskryptory wracają po zmianie, a właściwości dodane w trakcie znikają
  withPrototypeMutations(
    () => Object.defineProperty(Object.prototype, stringProbe, original),
    () => {
      withPrototypeMutations(
        () => {
          Object.defineProperty(Object.prototype, stringProbe, {
            value: "zmieniona",
            writable: true,
            enumerable: true,
          });
          Object.defineProperty(Object.prototype, "__k9Added__", {
            value: 1,
            configurable: true,
          });
          Array.prototype[symbolProbe] = "dodana symboliczna";
        },
        () => {
          assert.equal(
            Object.getOwnPropertyDescriptor(Object.prototype, stringProbe)
              .value,
            "zmieniona",
          );
        },
      );

      assert.deepEqual(
        Object.getOwnPropertyDescriptor(Object.prototype, stringProbe),
        original,
      );
      assert.equal(Object.hasOwn(Object.prototype, "__k9Added__"), false);
      assert.equal(Object.hasOwn(Array.prototype, symbolProbe), false);
    },
  );

  // wyjątek w akcji albo w samej zmianie nie zostawia śladów
  assert.throws(
    () =>
      withPrototypeMutations(
        () => {
          Object.defineProperty(Object.prototype, stringProbe, {
            value: 1,
            configurable: true,
          });
          Array.prototype[symbolProbe] = 1;
        },
        () => {
          throw new Error("test przerwany w akcji");
        },
      ),
    /test przerwany w akcji/,
  );
  assertPrototypesClean();

  assert.throws(
    () =>
      withPrototypeMutations(
        () => {
          Object.defineProperty(Object.prototype, stringProbe, {
            value: 1,
            configurable: true,
          });
          throw new Error("test przerwany w zmianie");
        },
        () => assert.fail("akcja nie powinna się wykonać"),
      ),
    /test przerwany w zmianie/,
  );
  assertPrototypesClean();

  // zmiana prototypu prototypu: wykrywana i (jako zmiana odwracalna) cofana
  const parentBefore = Object.getPrototypeOf(Array.prototype);
  const parentBaseline = snapshotPrototypes();
  const parentDifferences = withPrototypeMutations(
    () =>
      Object.setPrototypeOf(Array.prototype, Object.create(Object.prototype)),
    () => diffPrototypeSnapshots(parentBaseline, snapshotPrototypes()),
  );

  assert.deepEqual(parentDifferences, [
    "Array.prototype: zmieniony prototyp prototypu",
  ]);
  assert.equal(Object.getPrototypeOf(Array.prototype), parentBefore);
  assertPrototypesClean();

  // zmian nieodwracalnych nie da się cofnąć, więc nie sprawdzamy ich na prawdziwych
  // prototypach — tylko na obiekcie jednorazowym: pomocnik je wykrywa, odwraca resztę
  // i zgłasza błąd zamiast udawać, że stan został odtworzony
  const OBJECT_NAME = "obiekt jednorazowy";
  const snapshotOf = (target) => snapshotPrototypes([[OBJECT_NAME, target]]);

  {
    const target = { zachowana: 1 };
    const snapshot = snapshotOf(target);

    target.zachowana = 2; // zmiana odwracalna, wykonana jeszcze przed utratą rozszerzalności
    Object.preventExtensions(target);

    assert.deepEqual(diffPrototypeSnapshots(snapshot, snapshotOf(target)), [
      `${OBJECT_NAME}: zmieniona rozszerzalność`,
      `${OBJECT_NAME}: zmieniono deskryptor lub wartość właściwości zachowana`,
    ]);
    assert.throws(
      () => restorePrototypes(snapshot),
      /utraty rozszerzalności nie da się cofnąć/,
    );
    assert.equal(
      target.zachowana,
      1,
      "to, co dało się odwrócić, zostało odtworzone",
    );
    assert.equal(
      Object.isExtensible(target),
      false,
      "utrata rozszerzalności pozostaje widoczna",
    );
    assert.notDeepEqual(
      diffPrototypeSnapshots(snapshot, snapshotOf(target)),
      [],
    );
  }

  {
    const target = {};
    Object.defineProperty(target, "flaga", {
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const snapshot = snapshotOf(target);

    Object.defineProperty(target, "flaga", { value: 2, configurable: false });
    Object.defineProperty(target, "dodana", { value: 1, configurable: false });

    assert.deepEqual(diffPrototypeSnapshots(snapshot, snapshotOf(target)), [
      `${OBJECT_NAME}: zmieniono deskryptor lub wartość właściwości flaga`,
      `${OBJECT_NAME}: dodano właściwość dodana`,
    ]);
    assert.throws(
      () => restorePrototypes(snapshot),
      /nie udało się usunąć właściwości dodana.*nie udało się odtworzyć właściwości flaga/,
    );
    assert.notDeepEqual(
      diffPrototypeSnapshots(snapshot, snapshotOf(target)),
      [],
      "różnica pozostaje widoczna",
    );
  }

  // sama kontrola też reaguje: celowo zostawione zanieczyszczenie jest wykrywane, po czym sprzątane
  const leftover = snapshotPrototypes();
  Object.defineProperty(Array.prototype, stringProbe, {
    value: 1,
    configurable: true,
  });

  try {
    assert.throws(
      () => assertPrototypesClean(),
      /Object\.prototype lub Array\.prototype/,
    );
  } finally {
    restorePrototypes(leftover);
  }

  assertPrototypesClean();
});

test("K8 — na koniec żaden test nie zostawił zmian w Object.prototype ani Array.prototype", () => {
  assertPrototypesClean();
});
