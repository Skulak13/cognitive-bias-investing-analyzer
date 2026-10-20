/**
 * Strażnik odpowiedzi AI (Etap 7) — kroki 2–7 planu v1.1 (walidator,
 * normalizacja i rozpoznawanie biasów, lista dozwolonych pól, kontrakt
 * quickCheck).
 *
 * Dostaje surową odpowiedź Gemini i albo oddaje czysty, sprawdzony obiekt,
 * albo odrzuca odpowiedź z listą błędów:
 *
 *   validateAiResponse(raw, { kind: "full" })
 *
 *   sukces:  { ok: true,  value, warnings: [{ path, code, message }] }
 *   porażka: { ok: false, errors:          [{ path, code, message }] }
 *
 * Funkcja NIE łączy się z bazą ani siecią, NIE dopisuje metadanych backendu
 * (analyzedAt, aiModelVersion, snapshoty itd. — to Etap 8) i NIE zmienia
 * obiektu wejściowego: `value` jest budowany od zera z samych pól kontraktu.
 *
 * Dozwolone formy wejścia (sekcja 7.0 planu):
 *   - zwykły obiekt JS (nie tablica, nie null, nie instancja klasy),
 *   - czysty tekst zawierający poprawny JSON (jedno parsowanie).
 * Walidator NIE usuwa Markdown fences, NIE wycina JSON-u z tekstu, NIE
 * parsuje po raz drugi i NIE "ratuje" odpowiedzi heurystykami — każda
 * taka odpowiedź jest odrzucana (decyzja o ponowieniu to Etap 8).
 *
 * Ścieżki błędów (`path`) wskazują miejsce problemu, np. "summary",
 * "possibleBiases[0].confidence". Błąd dotyczący całej odpowiedzi
 * (zły JSON, zły kształt) ma ścieżkę "$".
 *
 * Zasada D4: backend może normalizować JEDNOZNACZNE różnice zapisu (wielkość
 * liter, odstępy, krzywe apostrofy i myślniki), ale nie zgaduje znaczenia
 * wartości. Najpierw normalizacja, potem ścisła walidacja.
 *
 * Zasada D3: nazwy biasów są rozpoznawane wyłącznie przez dokładne trafienie
 * (po normalizacji) w nazwę kanoniczną lub zatwierdzony alias z biasList.js.
 * Żadnego dopasowania "na podobieństwo". Nieznany bias → fallback
 * "inne / nieskatalogowane" + `proposedLabel` z oryginalną nazwą. Pole
 * `proposedLabel` wylicza WYŁĄCZNIE ten walidator — nie należy do kontraktu
 * Gemini.
 *
 * Etap 7 jest wykonany (kroki 2–9: implementacja, testy bezpieczeństwa
 * i przypadków brzegowych, skrypty, dokumentacja). Walidator nie jest jeszcze
 * podłączony do aiAnalysisService — to zadanie Etapu 8. Zakres implementacji:
 *   - Krok 2: wejście, struktura, wymagane pola, typy, puste wartości,
 *     zbieranie wszystkich błędów, budowa nowego `value`.
 *   - Krok 4: normalizeToken, normalizacja i sprawdzanie `confidence`.
 *   - Krok 5: resolveBias, proposedLabel, other_bias_no_label,
 *     duplicate_bias (pełna analiza).
 *   - Krok 6: lista dozwolonych pól, ostrzeżenia unknown_field_removed
 *     i backend_field_removed (pola backendu i pola wyliczane).
 *   - Krok 7: kind "quickCheck" (osobny kontrakt: summary, possibleBiases jako
 *     lista nazw, limitations; proposedBiasLabels; deduplikacja po
 *     znormalizowanej nazwie wejściowej).
 * Brak limitów długości i liczby elementów to zatwierdzona decyzja D5.
 */

import { BIAS_LIST, OTHER_BIAS } from "./biasList.js";

const ROOT_PATH = "$";

const CONFIDENCE_VALUES = Object.freeze(["low", "medium", "high"]);

/**
 * Pola, które ustawia backend — Gemini nie może ich dostarczać ani
 * nadpisywać (lista z sekcji 11 planu). Backend dopisze je dopiero po
 * pozytywnej walidacji (Etap 8).
 *
 * Etap 8.7.5: lista rozszerzona o identyfikatory uruchomienia analizy
 * (`analysisRunId`, `runStartedAt` — wpis `analyses[]` i `earlyAiCheck`;
 * `lastAnalysisRunId` — rezerwacja na `Position`). To ochrona dodatkowa:
 * pole nieznane i tak byłoby usunięte jako `unknown_field_removed`, ale pole
 * backendu ma dostać jednoznaczny kod `backend_field_removed`.
 */
export const BACKEND_OWNED_FIELDS = Object.freeze([
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
  "analysisRunId",
  "runStartedAt",
  "lastAnalysisRunId",
]);

/**
 * Pola wyliczane WYŁĄCZNIE przez ten walidator (z nieznanej nazwy biasu).
 * Nigdy nie należą do kontraktu Gemini — pole podane przez model jest
 * usuwane, a walidator wylicza własną wartość.
 */
export const DERIVED_FIELDS = Object.freeze([
  "proposedLabel",
  "proposedBiasLabels",
]);

const BACKEND_OWNED_SET = new Set(BACKEND_OWNED_FIELDS);
const DERIVED_SET = new Set(DERIVED_FIELDS);

// Lista dozwolonych pól każdego kontraktu. Wszystko spoza listy jest
// usuwane (wynik budowany od zera) i zgłaszane w ostrzeżeniach.
const FULL_FIELDS = new Set([
  "summary",
  "observedPatterns",
  "possibleBiases",
  "alternativeExplanations",
  "limitations",
  "outcomeNote",
]);

const QUICK_FIELDS = new Set(["summary", "possibleBiases", "limitations"]);

const FULL_ENTRY_FIELDS = new Set([
  "bias",
  "confidence",
  "supportingEvidence",
  "contradictingEvidence",
]);

// Rodzaje odpowiedzi: "full" (pełna analiza) i "quickCheck" (earlyAiCheck).
// To dwa OSOBNE kontrakty, a nie jeden uproszczony — każdy ma własną listę
// pól i własny kształt wyniku, ale ten sam mechanizm normalizacji i
// rozpoznawania biasów.
const KINDS = new Set(["full", "quickCheck"]);

function describeKind(kind) {
  // Nie wypisujemy wartości innych niż tekst (np. obiektów), żeby sam
  // komunikat błędu nie mógł rzucić wyjątku.
  return typeof kind === "string" ? `"${kind}"` : `(${typeof kind})`;
}

/**
 * Zły lub brakujący `kind` to błąd programisty, a nie złej odpowiedzi AI —
 * dlatego wyjątek, a nie `{ ok: false }`. Sprawdzany PRZED czytaniem wejścia.
 */
function assertKind(kind) {
  if (KINDS.has(kind)) return;

  throw new Error(
    `Nieznany kind ${describeKind(kind)}. Dozwolone wartości: "full", "quickCheck".`,
  );
}

/* ------------------------------------------------------------------ *
 * Normalizacja (D4, krok 1) — tylko zapis, nigdy znaczenie
 * ------------------------------------------------------------------ */

function assertString(value, functionName) {
  if (typeof value !== "string") {
    throw new TypeError(
      `${functionName}() przyjmuje tylko tekst (dostał: ${typeof value}). ` +
        "Sprawdzenie typu należy do wywołującego.",
    );
  }
}

/**
 * Normalizacja TOKENÓW (nazwy biasów, wartość `confidence`). Usuwa wyłącznie
 * różnice zapisu, co do których nie ma wątpliwości, że znaczenie zostaje to
 * samo:
 *   - Unicode NFC (zapis złożony i rozłożony "ę" to to samo),
 *   - krzywe apostrofy (’ ‘ ʼ) → zwykły apostrof,
 *   - warianty myślnika (‐ ‑ ‒ – — ― −) → zwykły łącznik,
 *   - dowolne ciągi odstępów (spacje, tabulatory, nowe linie, twarde spacje,
 *     inne spacje Unicode) → jedna spacja,
 *   - obcięcie odstępów na brzegach,
 *   - małe litery.
 *
 * NIE usuwa polskich znaków, NIE usuwa interpunkcji, NIE odmienia, NIE ucina
 * i NIE utożsamia łącznika ze spacją. Nie stosować do tekstów swobodnych
 * (summary, dowody itd.) — tam obowiązuje wyłącznie przycięcie na brzegach.
 */
export function normalizeToken(value) {
  assertString(value, "normalizeToken");

  return value
    .normalize("NFC")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFC");
}

/**
 * Normalizacja ETYKIETY nieznanego biasu (U8): zachowuje oryginalną pisownię
 * i wielkość liter oraz znaki (także krzywe apostrofy i myślniki). Zbija
 * wyłącznie odstępy do jednej spacji, obcina je na brzegach i stosuje NFC.
 */
export function normalizeLabel(value) {
  assertString(value, "normalizeLabel");

  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Rozpoznawanie biasów (D3, krok 5)
 * ------------------------------------------------------------------ */

const OTHER_KEY = normalizeToken(OTHER_BIAS);

/**
 * Słownik: znormalizowana nazwa lub alias → nazwa kanoniczna. Budowany
 * z biasList.js (jedyne źródło prawdy). Powtórzona nazwa lub alias to błąd
 * danych, który ma wywalić się od razu przy wczytaniu modułu, a nie dawać
 * po cichu niejednoznaczne wyniki.
 */
const BIAS_LOOKUP = (() => {
  const lookup = new Map();

  const add = (term, bias, match) => {
    const key = normalizeToken(term);

    if (key === OTHER_KEY || lookup.has(key)) {
      throw new Error(
        `Taksonomia biasów (biasList.js): niejednoznaczna nazwa lub alias "${term}".`,
      );
    }

    lookup.set(key, { bias, match });
  };

  for (const entry of BIAS_LIST) {
    add(entry.name, entry.name, "canonical");

    for (const alias of entry.aliases) {
      add(alias, entry.name, "alias");
    }
  }

  return lookup;
})();

/**
 * Rozpoznaje nazwę biasu zwróconą przez Gemini. Dokładne trafienie po
 * normalizacji w nazwę kanoniczną lub zatwierdzony alias — nic więcej
 * (żadnego fuzzy matchingu).
 *
 * @returns {{ bias: string, match: "canonical" | "alias" | "other" | "unknown", proposedLabel?: string }}
 *   - "canonical" / "alias": `bias` to nazwa kanoniczna,
 *   - "other": model sam wskazał "inne / nieskatalogowane" (bez nazwy),
 *   - "unknown": `bias` to fallback, a `proposedLabel` to oryginalna nazwa.
 */
export function resolveBias(rawName) {
  assertString(rawName, "resolveBias");

  const key = normalizeToken(rawName);
  const hit = BIAS_LOOKUP.get(key);

  if (hit) {
    return { bias: hit.bias, match: hit.match };
  }

  if (key === OTHER_KEY) {
    return { bias: OTHER_BIAS, match: "other" };
  }

  return {
    bias: OTHER_BIAS,
    match: "unknown",
    proposedLabel: normalizeLabel(rawName),
  };
}

/** Klucz do wykrywania powtórzonego biasu w jednej odpowiedzi. */
function duplicateKey(resolution) {
  if (resolution.match === "unknown") {
    return `unknown:${normalizeToken(resolution.proposedLabel)}`;
  }

  if (resolution.match === "other") {
    return "other";
  }

  return `bias:${resolution.bias}`;
}

/* ------------------------------------------------------------------ *
 * Pomocnicze
 * ------------------------------------------------------------------ */

function issue(path, code, message) {
  return { path, code, message };
}

function joinPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Wykonuje JEDEN odczyt wartości (`read`). Wejście może być zwykłym obiektem
 * JavaScript, więc odczyt pola lub elementu może uruchomić getter, który rzuci
 * wyjątek. Dla wspieranego wejścia (zwykły obiekt albo tekst JSON) walidator
 * nie przepuszcza takiego wyjątku na zewnątrz, tylko zapisuje kontrolowany
 * błąd `invalid_structure` ze ścieżką pola. Treść wyjątku nie trafia do
 * komunikatu. Obiekty Proxy z rzucającymi pułapkami nie są wspieranym wejściem:
 * wyjątki z ich pułapek (np. w Object.getPrototypeOf() lub Object.keys())
 * nie są tu przechwytywane.
 */
function guardedRead(path, ctx, read) {
  try {
    return { ok: true, value: read() };
  } catch {
    ctx.errors.push(
      issue(
        path,
        "invalid_structure",
        `Pole "${path}" nie może zostać odczytane (dostęp do pola zgłosił wyjątek).`,
      ),
    );
    return { ok: false, value: undefined };
  }
}

/**
 * Czyta pole należące do samego obiektu (nie z prototypu), dokładnie raz.
 * Wartość `undefined` jest traktowana jak brak pola. Gdy odczyt rzuci wyjątek,
 * błąd `invalid_structure` jest już zapisany w `ctx`, a wynik ma
 * `unreadable: true` (wywołujący nie dopisuje wtedy `missing_field`).
 */
function readField(source, key, path, ctx) {
  const read = guardedRead(path, ctx, () =>
    Object.hasOwn(source, key) ? source[key] : undefined,
  );

  if (!read.ok) {
    return { present: false, unreadable: true, value: undefined };
  }

  return {
    present: read.value !== undefined,
    unreadable: false,
    value: read.value,
  };
}

/**
 * Czyta jeden element tablicy (dokładnie raz) z tą samą obsługą wyjątku co
 * readField. Zwraca { ok, value }; przy `ok: false` błąd jest już w `ctx`.
 */
function readElement(list, index, path, ctx) {
  return guardedRead(path, ctx, () => list[index]);
}

/**
 * Lista dozwolonych pól (krok 6): zgłasza pola obiektu spoza kontraktu, ale
 * tylko własne, wyliczalne klucze tekstowe, które zwraca `Object.keys()`.
 * Klucze symboliczne i właściwości niewyliczalne nie są zgłaszane (wynik
 * i tak powstaje od zera z pól kontraktu, więc nie trafiają do `value`).
 *   - pole backendu lub pole wyliczane przez walidator → backend_field_removed,
 *   - dowolne inne pole (także __proto__, constructor, prototype)
 *     → unknown_field_removed.
 * Wartości tych pól nie są odczytywane (gettery nie są uruchamiane), a sam
 * wynik jest budowany od zera z pól kontraktu — to tylko raport o tym, co
 * zostało pominięte.
 * Komunikat nie powtarza nazwy pola (wskazuje ją `path`).
 */
function reportExtraFields(source, allowedFields, parentPath, ctx) {
  for (const key of Object.keys(source)) {
    if (allowedFields.has(key)) continue;

    const path = joinPath(parentPath, key);

    if (BACKEND_OWNED_SET.has(key) || DERIVED_SET.has(key)) {
      ctx.warnings.push(
        issue(
          path,
          "backend_field_removed",
          "Pole należące do backendu (lub wyliczane przez walidator) zostało usunięte z odpowiedzi modelu.",
        ),
      );
    } else {
      ctx.warnings.push(
        issue(
          path,
          "unknown_field_removed",
          "Pole spoza kontraktu odpowiedzi zostało usunięte.",
        ),
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Wejście (sekcja 7.0)
 * ------------------------------------------------------------------ */

/**
 * Zwraca { object } albo { error }. Tekst jest parsowany dokładnie raz;
 * wynik parsowania musi być zwykłym obiektem (bez drugiego parsowania).
 */
function readInput(raw) {
  let candidate = raw;

  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return {
        error: issue(
          ROOT_PATH,
          "invalid_json",
          "Odpowiedź nie jest czystym, poprawnym JSON-em.",
        ),
      };
    }
  }

  if (!isPlainObject(candidate)) {
    return {
      error: issue(
        ROOT_PATH,
        "invalid_structure",
        "Odpowiedź musi być zwykłym obiektem JSON.",
      ),
    };
  }

  return { object: candidate };
}

/* ------------------------------------------------------------------ *
 * Czytniki pól — każdy zapisuje błędy i ostrzeżenia w `ctx`
 * ({ errors, warnings }) i zwraca wartość (albo undefined, gdy pole jest
 * niepoprawne)
 * ------------------------------------------------------------------ */

function missingField(path) {
  return issue(path, "missing_field", `Brak wymaganego pola "${path}".`);
}

/**
 * Sprawdza pojedynczą wartość tekstową i zwraca ją przyciętą na brzegach
 * (teksty swobodne: tylko obcięcie odstępów, bez zmiany treści).
 */
function checkText(value, path, ctx, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    ctx.errors.push(
      issue(path, "invalid_type", `Pole "${path}" musi być tekstem.`),
    );
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed === "" && !allowEmpty) {
    ctx.errors.push(
      issue(path, "empty_value", `Pole "${path}" nie może być puste.`),
    );
    return undefined;
  }

  return trimmed;
}

function readText(source, key, parentPath, ctx, options) {
  const path = joinPath(parentPath, key);
  const field = readField(source, key, path, ctx);

  if (field.unreadable) return undefined;

  if (!field.present) {
    ctx.errors.push(missingField(path));
    return undefined;
  }

  return checkText(field.value, path, ctx, options);
}

function readTextList(source, key, parentPath, ctx) {
  const path = joinPath(parentPath, key);
  const field = readField(source, key, path, ctx);

  if (field.unreadable) return undefined;

  if (!field.present) {
    ctx.errors.push(missingField(path));
    return undefined;
  }

  if (!Array.isArray(field.value)) {
    ctx.errors.push(
      issue(path, "invalid_type", `Pole "${path}" musi być listą tekstów.`),
    );
    return undefined;
  }

  const items = [];

  // Pętla po indeksach (a nie map/forEach), żeby puste miejsca w tablicy
  // (np. [ , "a" ]) były zgłoszone jako błąd, a nie pominięte.
  for (let index = 0; index < field.value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const element = readElement(field.value, index, itemPath, ctx);

    items.push(
      element.ok ? checkText(element.value, itemPath, ctx) : undefined,
    );
  }

  return items;
}

/**
 * `confidence` (D4): najpierw bezpieczna normalizacja zapisu, potem ścisła
 * walidacja — wynik musi być dokładnie "low", "medium" albo "high". Wszystko
 * inne ("very high", "0.8", 0.8, null, "", tablica...) to invalid_confidence;
 * backend nie zgaduje znaczenia. Ostrzeżenie confidence_normalized tylko
 * wtedy, gdy zapis wejściowy rzeczywiście został zmieniony.
 */
function readConfidence(value, path, ctx) {
  if (typeof value === "string") {
    const normalized = normalizeToken(value);

    if (CONFIDENCE_VALUES.includes(normalized)) {
      if (normalized !== value) {
        ctx.warnings.push(
          issue(
            path,
            "confidence_normalized",
            `Wartość "${path}" miała inny zapis i została znormalizowana.`,
          ),
        );
      }

      return normalized;
    }
  }

  ctx.errors.push(
    issue(
      path,
      "invalid_confidence",
      `Pole "${path}" musi mieć wartość low, medium lub high.`,
    ),
  );
  return undefined;
}

/**
 * Ostrzeżenia po rozpoznaniu biasu — wspólne dla obu kontraktów:
 *   - nieznany bias → bias_unmapped,
 *   - "inne / nieskatalogowane" podane wprost, bez własnej nazwy
 *     → other_bias_no_label.
 * `labelField` to nazwa pola z oryginalną nazwą (tylko do komunikatu).
 */
function warnAboutResolution(resolution, path, labelField, ctx) {
  if (resolution.match === "unknown") {
    ctx.warnings.push(
      issue(
        path,
        "bias_unmapped",
        `Bias spoza taksonomii zapisano jako "${OTHER_BIAS}"; oryginalna nazwa jest w polu ${labelField}.`,
      ),
    );
  } else if (resolution.match === "other") {
    ctx.warnings.push(
      issue(
        path,
        "other_bias_no_label",
        `Wskazano "${OTHER_BIAS}" bez własnej nazwy — nie ma etykiety do zachowania.`,
      ),
    );
  }
}

/**
 * Pojedynczy wpis possibleBiases. Zwraca { value, key } (key służy do
 * wykrywania duplikatów) albo undefined, gdy wpis nie jest obiektem.
 */
function readBiasEntry(entry, path, ctx) {
  if (!isPlainObject(entry)) {
    ctx.errors.push(
      issue(path, "invalid_type", `Pole "${path}" musi być obiektem.`),
    );
    return undefined;
  }

  // bias — niepusty tekst, potem rozpoznanie (nazwa / alias / fallback)
  let resolution;
  const biasPath = joinPath(path, "bias");
  const biasField = readField(entry, "bias", biasPath, ctx);

  if (biasField.unreadable) {
    // błąd invalid_structure jest już zapisany w ctx
  } else if (!biasField.present) {
    ctx.errors.push(missingField(biasPath));
  } else if (
    typeof biasField.value !== "string" ||
    biasField.value.trim() === ""
  ) {
    ctx.errors.push(
      issue(
        biasPath,
        "invalid_bias",
        `Pole "${biasPath}" musi być niepustym tekstem (nazwą biasu).`,
      ),
    );
  } else {
    resolution = resolveBias(biasField.value);
    warnAboutResolution(resolution, biasPath, "proposedLabel", ctx);
  }

  // confidence — normalizacja, potem ścisła walidacja
  let confidence;
  const confidencePath = joinPath(path, "confidence");
  const confidenceField = readField(entry, "confidence", confidencePath, ctx);

  if (confidenceField.unreadable) {
    // błąd invalid_structure jest już zapisany w ctx
  } else if (!confidenceField.present) {
    ctx.errors.push(missingField(confidencePath));
  } else {
    confidence = readConfidence(confidenceField.value, confidencePath, ctx);
  }

  const supportingEvidence = readText(entry, "supportingEvidence", path, ctx);

  // contradictingEvidence — opcjonalne; brak oznacza pusty tekst
  let contradictingEvidence = "";
  const contradictingPath = joinPath(path, "contradictingEvidence");
  const contradictingField = readField(
    entry,
    "contradictingEvidence",
    contradictingPath,
    ctx,
  );

  if (contradictingField.present) {
    contradictingEvidence = checkText(
      contradictingField.value,
      contradictingPath,
      ctx,
      { allowEmpty: true },
    );
  }

  // Pola spoza kontraktu wpisu (w tym backendu i `proposedLabel` podane przez
  // Gemini) są usuwane z ostrzeżeniem — wynik poniżej jest budowany od zera.
  reportExtraFields(entry, FULL_ENTRY_FIELDS, path, ctx);

  // `proposedLabel` jest wyliczane wyłącznie tutaj, z nieznanej nazwy biasu.
  // Pole o tej nazwie podane przez Gemini w ogóle nie jest czytane.
  const value = { bias: resolution?.bias };

  if (resolution?.match === "unknown") {
    value.proposedLabel = resolution.proposedLabel;
  }

  value.confidence = confidence;
  value.supportingEvidence = supportingEvidence;
  value.contradictingEvidence = contradictingEvidence;

  return { value, key: resolution ? duplicateKey(resolution) : undefined };
}

function readBiasEntries(source, key, parentPath, ctx) {
  const path = joinPath(parentPath, key);
  const field = readField(source, key, path, ctx);

  if (field.unreadable) return undefined;

  if (!field.present) {
    ctx.errors.push(missingField(path));
    return undefined;
  }

  if (!Array.isArray(field.value)) {
    ctx.errors.push(
      issue(path, "invalid_type", `Pole "${path}" musi być listą obiektów.`),
    );
    return undefined;
  }

  const entries = [];
  const firstSeen = new Map(); // klucz biasu -> indeks pierwszego wystąpienia

  for (let index = 0; index < field.value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const element = readElement(field.value, index, entryPath, ctx);
    const entry = element.ok
      ? readBiasEntry(element.value, entryPath, ctx)
      : undefined;

    entries.push(entry?.value);

    // Duplikat: wpisy ZOSTAJĄ oba (łączenie dowodów byłoby cichą zmianą
    // treści), ostrzeżenie dostaje każde późniejsze powtórzenie.
    if (entry?.key !== undefined) {
      if (firstSeen.has(entry.key)) {
        ctx.warnings.push(
          issue(
            joinPath(entryPath, "bias"),
            "duplicate_bias",
            `Bias powtórzony (pierwsze wystąpienie: ${path}[${firstSeen.get(entry.key)}]); oba wpisy zachowano.`,
          ),
        );
      } else {
        firstSeen.set(entry.key, index);
      }
    }
  }

  return entries;
}

/* ------------------------------------------------------------------ *
 * Kontrakt pełnej analizy (kind: "full", sekcja 7.1 planu)
 * ------------------------------------------------------------------ */

function validateFull(source) {
  const ctx = { errors: [], warnings: [] };

  // `value` powstaje od zera, z samych pól kontraktu. Pola spoza kontraktu
  // nie są przepisywane, a ich usunięcie jest zgłaszane w ostrzeżeniach.
  const value = {
    summary: readText(source, "summary", "", ctx),
    observedPatterns: readTextList(source, "observedPatterns", "", ctx),
    possibleBiases: readBiasEntries(source, "possibleBiases", "", ctx),
    alternativeExplanations: readTextList(
      source,
      "alternativeExplanations",
      "",
      ctx,
    ),
    limitations: readText(source, "limitations", "", ctx, {
      allowEmpty: true,
    }),
    outcomeNote: readText(source, "outcomeNote", "", ctx, {
      allowEmpty: true,
    }),
  };

  reportExtraFields(source, FULL_FIELDS, "", ctx);

  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }

  return { ok: true, value, warnings: ctx.warnings };
}

/* ------------------------------------------------------------------ *
 * Kontrakt quick-checka (kind: "quickCheck", sekcja 7.2 planu)
 * ------------------------------------------------------------------ */

/**
 * `possibleBiases` w quick-checku to lista SAMYCH NAZW (tekstów). Każda
 * nazwa przechodzi przez ten sam resolveBias() co w pełnej analizie.
 *
 * Wynik:
 *   - `possibleBiases` — nazwy kanoniczne lub fallback; "inne /
 *     nieskatalogowane" występuje najwyżej raz,
 *   - `proposedBiasLabels` — oryginalne nazwy nieznanych biasów (U8); wyliczane
 *     wyłącznie tutaj, po jednej dla każdej różnej nieznanej nazwy z wejścia.
 *
 * Powtórzeniem (ostrzeżenie duplicate_bias, zostaje pierwsze wystąpienie) jest
 * ta sama nazwa wejściowa po normalizacji (wielkość liter, odstępy, krzywe
 * apostrofy, warianty myślnika):
 *   - nazwa znana: ten sam bias kanoniczny (nazwa lub alias),
 *   - nazwa nieznana: ta sama znormalizowana etykieta,
 *   - fallback podany wprost: drugi taki sam fallback.
 * Dwie RÓŻNE nieznane etykiety NIE są powtórzeniem tylko dlatego, że obie
 * mapują się na wspólny fallback. Usunięty duplikat dostaje wyłącznie
 * duplicate_bias. Dowody nie istnieją, więc nic nie jest łączone.
 */
function readQuickBiases(source, key, parentPath, ctx) {
  const path = joinPath(parentPath, key);
  const field = readField(source, key, path, ctx);

  if (field.unreadable) return undefined;

  if (!field.present) {
    ctx.errors.push(missingField(path));
    return undefined;
  }

  if (!Array.isArray(field.value)) {
    ctx.errors.push(
      issue(path, "invalid_type", `Pole "${path}" musi być listą nazw biasów.`),
    );
    return undefined;
  }

  const possibleBiases = [];
  const proposedBiasLabels = [];
  const seenKeys = new Map(); // klucz powtórzenia -> indeks pierwszego wystąpienia
  const listedBiases = new Set(); // nazwy już dopisane do possibleBiases

  for (let index = 0; index < field.value.length; index += 1) {
    const namePath = `${path}[${index}]`;
    const element = readElement(field.value, index, namePath, ctx);

    if (!element.ok) continue;

    const name = element.value;

    if (typeof name !== "string" || name.trim() === "") {
      ctx.errors.push(
        issue(
          namePath,
          "invalid_bias",
          `Pole "${namePath}" musi być niepustym tekstem (nazwą biasu).`,
        ),
      );
      continue;
    }

    const resolution = resolveBias(name);

    // Powtórzenie to ta sama nazwa wejściowa po normalizacji (ten sam klucz co
    // w pełnej analizie), a NIE sam fakt, że dwie nieznane etykiety trafiają do
    // wspólnego fallbacku. Zostaje pierwsze wystąpienie.
    const key = duplicateKey(resolution);

    if (seenKeys.has(key)) {
      ctx.warnings.push(
        issue(
          namePath,
          "duplicate_bias",
          `Powtórzona pozycja na liście wynikowej (pierwsze wystąpienie: ${path}[${seenKeys.get(key)}]) — usunięto.`,
        ),
      );
      continue;
    }

    seenKeys.set(key, index);
    warnAboutResolution(resolution, namePath, "proposedBiasLabels", ctx);

    // Etykieta nieznanego biasu: pierwsze wystąpienie danego klucza, więc nie
    // wymaga osobnej deduplikacji.
    if (resolution.match === "unknown") {
      proposedBiasLabels.push(resolution.proposedLabel);
    }

    // Różne nieznane etykiety (i fallback podany wprost) dzielą jedną pozycję
    // "inne / nieskatalogowane" — na liście wynikowej trafia ona tylko raz.
    if (!listedBiases.has(resolution.bias)) {
      listedBiases.add(resolution.bias);
      possibleBiases.push(resolution.bias);
    }
  }

  return { possibleBiases, proposedBiasLabels };
}

function validateQuickCheck(source) {
  const ctx = { errors: [], warnings: [] };

  const summary = readText(source, "summary", "", ctx);
  const biases = readQuickBiases(source, "possibleBiases", "", ctx);
  const limitations = readText(source, "limitations", "", ctx, {
    allowEmpty: true,
  });

  // Pola spoza kontraktu quick-checka (także pola pełnej analizy, pola
  // backendu i `proposedBiasLabels` podane przez Gemini) są usuwane.
  reportExtraFields(source, QUICK_FIELDS, "", ctx);

  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }

  return {
    ok: true,
    value: {
      summary,
      possibleBiases: biases.possibleBiases,
      proposedBiasLabels: biases.proposedBiasLabels,
      limitations,
    },
    warnings: ctx.warnings,
  };
}

const VALIDATORS = {
  full: validateFull,
  quickCheck: validateQuickCheck,
};

/* ------------------------------------------------------------------ *
 * Interfejs publiczny
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} raw  odpowiedź Gemini: zwykły obiekt albo czysty tekst z JSON-em
 * @param {{ kind: "full" | "quickCheck" }} options
 * @returns {{ ok: true, value: object, warnings: object[] } | { ok: false, errors: object[] }}
 * @throws {Error} gdy `kind` jest nieznany lub go brakuje. Dla wspieranego
 *   wejścia (zwykły obiekt albo tekst JSON) to jedyny wyjątek; obiekty Proxy
 *   z rzucającymi pułapkami nie są obsługiwane.
 */
export function validateAiResponse(raw, options) {
  const kind = options?.kind;

  assertKind(kind);

  const input = readInput(raw);

  if (input.error) {
    return { ok: false, errors: [input.error] };
  }

  return VALIDATORS[kind](input.object);
}
