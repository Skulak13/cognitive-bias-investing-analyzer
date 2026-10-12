import { test } from "node:test";
import assert from "node:assert/strict";
import { BIAS_LIST, OTHER_BIAS } from "../utils/biasList.js";
import { normalizeToken } from "../utils/validateAiResponse.js";

/* ------------------------------------------------------------------ *
 * Etap 7, krok 1 — spójność danych taksonomii (utils/biasList.js).
 *
 * Testy pilnują, żeby zamknięta lista 35 biasów i zamknięta lista aliasów
 * (Załącznik A planu Etapu 7, wersja 1.1) nie zmieniły się przypadkiem.
 * Zmiana składu listy albo aliasów to świadoma decyzja: wymaga zmiany
 * także oczekiwanych wartości poniżej.
 *
 * Tu sprawdzamy tylko DANE. Wymóg "nazwa i alias zapisane w postaci
 * znormalizowanej" jest sprawdzany lokalną funkcją pomocniczą ORAZ (od
 * kroku 4) porównaniem z prawdziwym normalizeToken() z walidatora.
 * ------------------------------------------------------------------ */

// Zatwierdzone nazwy kanoniczne, w zatwierdzonej kolejności (grupy A, B, C).
const EXPECTED_NAMES = [
  "nadmierna pewność siebie",
  "zakotwiczenie",
  "heurystyka reprezentatywności",
  "heurystyka dostępności",
  "błąd potwierdzenia",
  "konserwatyzm poznawczy",
  "iluzja kontroli",
  "błąd wstecznej wiedzy",
  "dysonans poznawczy",
  "błąd atrybucji własnych sukcesów",
  "błąd wyniku",
  "efekt świeżości",
  "efekt ramowania",
  "księgowanie mentalne",
  "awersja do niejednoznaczności",
  "niechęć do straty",
  "nadmierny optymizm",
  "brak samokontroli",
  "status quo",
  "efekt posiadania",
  "awersja do żalu",
  "stronniczość sympatii/afiliacji",
  "efekt dyspozycji",
  "efekt stadny",
  "bias znajomości",
  "bias krajowy",
  "bias lokalny",
  "podążanie za trendem",
  "preferencja akcji loteryjnych",
  "nadmierny handel",
  "niedostateczna dywersyfikacja",
  "ograniczona uwaga",
  "wąskie ramowanie decyzji",
  "efekt utopionych kosztów",
  "błąd hazardzisty",
];

// Zatwierdzona liczba aliasów (EN + PL) każdej pozycji, w tej samej kolejności.
const EXPECTED_ALIAS_COUNTS = [
  4, 8, 5, 4, 3, 1, 4, 3, 4, 5, 2, 4, 4, 4, 3, 6, 5, 4, 3, 2, 4, 3, 3, 7, 4, 3,
  3, 7, 2, 4, 5, 3, 4, 7, 6,
];
const EXPECTED_ALIAS_TOTAL = 143;

/**
 * Sprawdza, że tekst jest już w postaci znormalizowanej: Unicode NFC, małe
 * litery, bez spacji na brzegach, pojedyncze zwykłe spacje, zwykłe apostrofy
 * i myślniki. Zwraca listę naruszeń (pusta = w porządku).
 */
function normalizationProblems(text) {
  const problems = [];

  if (text.length === 0) problems.push("pusty");
  if (text !== text.normalize("NFC")) problems.push("nie-NFC");
  if (text !== text.toLowerCase()) problems.push("wielkie litery");
  if (text !== text.trim()) problems.push("spacje na brzegach");
  if (/[\t\n\r\u00a0]/.test(text)) problems.push("biały znak inny niż spacja");
  if (/ {2,}/.test(text)) problems.push("wielokrotne spacje");
  if (/[\u2018\u2019\u02bc]/.test(text)) problems.push("krzywy apostrof");
  if (/[\u2010-\u2015\u2212]/.test(text))
    problems.push("myślnik typograficzny");

  return problems;
}

const ALL_TERMS = BIAS_LIST.flatMap((bias) => [bias.name, ...bias.aliases]);

test("biasList — dokładnie 35 pozycji w zatwierdzonej kolejności", () => {
  assert.equal(BIAS_LIST.length, 35);
  assert.deepEqual(
    BIAS_LIST.map((bias) => bias.name),
    EXPECTED_NAMES,
  );
});

test("biasList — podział na grupy A/B/C wynosi 15/7/13 i pozycje są ułożone grupami", () => {
  const groups = BIAS_LIST.map((bias) => bias.group);

  assert.ok(groups.every((group) => ["A", "B", "C"].includes(group)));

  assert.equal(groups.filter((group) => group === "A").length, 15);
  assert.equal(groups.filter((group) => group === "B").length, 7);
  assert.equal(groups.filter((group) => group === "C").length, 13);

  assert.equal(groups.slice(0, 15).join(""), "A".repeat(15));
  assert.equal(groups.slice(15, 22).join(""), "B".repeat(7));
  assert.equal(groups.slice(22).join(""), "C".repeat(13));
});

test("biasList — każda pozycja ma tylko pola name, group, aliases (bez dodatkowych)", () => {
  for (const bias of BIAS_LIST) {
    assert.deepEqual(Object.keys(bias).sort(), ["aliases", "group", "name"]);
    assert.equal(typeof bias.name, "string");
    assert.ok(Array.isArray(bias.aliases));
  }
});

test("biasList — lista aliasów jest zamknięta: liczba aliasów każdej pozycji zgadza się z Załącznikiem A", () => {
  assert.deepEqual(
    BIAS_LIST.map((bias) => bias.aliases.length),
    EXPECTED_ALIAS_COUNTS,
  );

  const total = BIAS_LIST.reduce((sum, bias) => sum + bias.aliases.length, 0);
  assert.equal(total, EXPECTED_ALIAS_TOTAL);
});

test("biasList — nazwy kanoniczne i aliasy są niepuste i zapisane w postaci znormalizowanej", () => {
  for (const term of ALL_TERMS) {
    assert.deepEqual(
      normalizationProblems(term),
      [],
      `"${term}" nie jest w postaci znormalizowanej`,
    );
  }
});

test("biasList — nazwy kanoniczne są unikalne", () => {
  const names = BIAS_LIST.map((bias) => bias.name);
  assert.equal(new Set(names).size, names.length);
});

test("biasList — żaden alias nie powtarza się i żaden nie jest nazwą kanoniczną (własną ani cudzą)", () => {
  const seen = new Map(); // termin -> numer pozycji, w której wystąpił jako alias
  const names = new Set(BIAS_LIST.map((bias) => bias.name));

  BIAS_LIST.forEach((bias, index) => {
    for (const alias of bias.aliases) {
      assert.ok(
        !names.has(alias),
        `alias "${alias}" (pozycja ${index + 1}) jest nazwą kanoniczną`,
      );

      assert.ok(
        !seen.has(alias),
        `alias "${alias}" występuje w pozycjach ${seen.get(alias) + 1} i ${index + 1}`,
      );

      seen.set(alias, index);
    }
  });
});

test("biasList — OTHER_BIAS to fallback, a nie jedna z 35 kategorii", () => {
  assert.equal(OTHER_BIAS, "inne / nieskatalogowane");
  assert.deepEqual(normalizationProblems(OTHER_BIAS), []);

  assert.ok(!ALL_TERMS.includes(OTHER_BIAS));
  assert.ok(BIAS_LIST.every((bias) => bias.name !== OTHER_BIAS));
  assert.equal(BIAS_LIST.length, 35);
});

test("biasList — FOMO i preferencje ryzyka nie są kategoriami ani aliasami", () => {
  const forbidden = [
    /fomo/,
    /fear of missing out/,
    /risk aversion/,
    /risk-averse/,
    /awersja do ryzyka/,
    /niechęć do ryzyka/,
    /strach/,
    /\bfear\b/,
  ];

  for (const term of ALL_TERMS) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(term), `"${term}" pasuje do ${pattern}`);
    }
  }
});

test("biasList — polskie znaki diakrytyczne są zachowane w danych", () => {
  const find = (name) => BIAS_LIST.find((bias) => bias.name === name);

  assert.ok(find("niechęć do straty"));
  assert.ok(find("błąd hazardzisty"));
  assert.ok(find("efekt świeżości"));
  assert.ok(find("księgowanie mentalne"));
  assert.ok(find("stronniczość sympatii/afiliacji"));

  // aliasy polskie również z ogonkami
  assert.ok(find("błąd potwierdzenia").aliases.includes("efekt potwierdzania"));
  assert.ok(find("efekt stadny").aliases.includes("owczy pęd"));
  assert.ok(find("błąd hazardzisty").aliases.includes("złudzenie hazardzisty"));
});

test("biasList — aliasy z przykładów planu są przypisane do właściwych biasów", () => {
  const owner = new Map();
  for (const bias of BIAS_LIST) {
    owner.set(bias.name, bias.name);
    for (const alias of bias.aliases) owner.set(alias, bias.name);
  }

  assert.equal(owner.get("confirmation bias"), "błąd potwierdzenia");
  assert.equal(owner.get("efekt potwierdzania"), "błąd potwierdzenia");
  assert.equal(owner.get("disposition effect"), "efekt dyspozycji");
  assert.equal(owner.get("awersja do strat"), "niechęć do straty");
  assert.equal(owner.get("gambler's fallacy"), "błąd hazardzisty");
  assert.equal(owner.get("monte carlo fallacy"), "błąd hazardzisty");

  // Podobnie brzmiące, ale niezatwierdzone pojęcia NIE są aliasami.
  assert.equal(owner.get("awersja do ryzyka"), undefined);
  assert.equal(owner.get("fomo"), undefined);
  assert.equal(owner.get("confirmation"), undefined);
});

test("biasList — dane są głęboko zamrożone (ochrona przed przypadkową mutacją)", () => {
  assert.ok(Object.isFrozen(BIAS_LIST));

  for (const bias of BIAS_LIST) {
    assert.ok(
      Object.isFrozen(bias),
      `pozycja "${bias.name}" nie jest zamrożona`,
    );
    assert.ok(
      Object.isFrozen(bias.aliases),
      `aliasy "${bias.name}" nie są zamrożone`,
    );
  }

  // Moduły ES działają w trybie ścisłym, więc próba zmiany rzuca TypeError.
  assert.throws(() => BIAS_LIST.push({}), TypeError);
  assert.throws(() => {
    BIAS_LIST[0] = {};
  }, TypeError);
  assert.throws(() => {
    BIAS_LIST[0].name = "zmieniona";
  }, TypeError);
  assert.throws(() => {
    BIAS_LIST[0].group = "C";
  }, TypeError);
  assert.throws(() => BIAS_LIST[0].aliases.push("nowy alias"), TypeError);
  assert.throws(() => {
    BIAS_LIST[0].aliases[0] = "zmieniony";
  }, TypeError);

  assert.equal(BIAS_LIST.length, 35);
  assert.equal(BIAS_LIST[0].name, EXPECTED_NAMES[0]);
});

test("biasList — każda nazwa kanoniczna i każdy alias jest równy swojej normalizacji (normalizeToken)", () => {
  for (const term of ALL_TERMS) {
    assert.equal(
      normalizeToken(term),
      term,
      `"${term}" zmienia się po normalizeToken() — alias nigdy by nie zadziałał`,
    );
  }
});
