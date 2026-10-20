import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_INPUT_LIMITS,
  NEWS_DATETIME_MAX_SECONDS,
  NEWS_DATETIME_MIN_SECONDS,
  filterNews,
} from "../services/aiInputBuilder.js";
import {
  IDS,
  TEXT,
  collectKeys,
  makeBars,
  makeFixture,
  seconds,
} from "./helpers/aiInputKit.js";

/* ------------------------------------------------------------------ *
 * Etap 8.7.1–8.7.2 — składanie modelInput i filtr wiadomości
 * (bez bazy i bez sieci: atrapy modeli i usług rynkowych)
 * ------------------------------------------------------------------ */

const ids = (overrides = {}) => ({
  positionId: String(IDS.position),
  userId: String(IDS.userA),
  ...overrides,
});

const FORBIDDEN_KEYS = [
  "_id",
  "id",
  "userId",
  "positionId",
  "earlyAiCheck",
  "url",
  "email",
  "createdAt",
  "updatedAt",
  "__v",
  "inputSnapshot",
  "analysisRunId",
];

/* ----------------------------- 8.7.1 pełna analiza ----------------------------- */

test("pełna analiza: struktura wymagana w planie, akcje posortowane po actionDate z numerem kolejnym", async () => {
  const { builder } = makeFixture();
  const built = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.modelInput), [
    "ticker",
    "positionStatus",
    "openedAt",
    "closedAt",
    "actions",
    "marketContext",
    "news",
    "dataCoverage",
  ]);

  const { modelInput } = built;

  assert.equal(modelInput.ticker, "AAPL");
  assert.equal(modelInput.positionStatus, "closed");
  assert.equal(modelInput.openedAt, "2026-10-13T14:00:00.000Z");
  assert.equal(modelInput.closedAt, "2026-10-19T16:00:00.000Z");

  assert.deepEqual(
    modelInput.actions.map((a) => [a.sequenceNo, a.actionType]),
    [
      [1, "open"],
      [2, "add"],
      [3, "close"],
    ],
  );
  assert.deepEqual(Object.keys(modelInput.actions[0]), [
    "sequenceNo",
    "actionType",
    "quantity",
    "executionPrice",
    "marketPriceAtDecision",
    "actionDate",
    "tradingDateRef",
    "statedMotivation",
    "reasoning",
    "reasoningAddedAt",
    "expectedOutcome",
  ]);
  assert.equal(modelInput.actions[0].reasoning, TEXT.r1);
  assert.equal(modelInput.actions[0].expectedOutcome, TEXT.e1);
  assert.equal(modelInput.actions[0].tradingDateRef, "2026-10-13");
  assert.equal(modelInput.actions[1].expectedOutcome, "");
});

test("modelInput jest czystym JSON-em (daty jako tekst ISO) — zapis i odczyt nie zmieniają go", async () => {
  const { builder } = makeFixture();
  const { modelInput } = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.deepEqual(JSON.parse(JSON.stringify(modelInput)), modelInput);
});

test("pola wewnętrzne backendu i identyfikatory nie trafiają do modelInput ani do meta (poza actionRefs)", async () => {
  const { builder } = makeFixture({
    news: [
      {
        datetime: seconds("2026-10-14T10:00:00.000Z"),
        headline: "Nagłówek",
        summary: "Streszczenie",
        source: "Źródło",
        url: "https://example.com/news/1?token=SEKRET",
      },
    ],
  });
  const built = await builder.buildModelInput({ ...ids(), kind: "full" });
  const keys = collectKeys(built.modelInput);

  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `modelInput zawiera klucz „${forbidden}”`);
  }

  const serialized = JSON.stringify(built.modelInput);

  assert.ok(!serialized.includes(String(IDS.userA)));
  assert.ok(!serialized.includes(String(IDS.position)));
  assert.ok(!serialized.includes("WCZESNA-ANALIZA-NIE-DLA-MODELU"));
  assert.ok(!serialized.includes("example.com"));
  assert.ok(!serialized.includes("SEKRET"));
  assert.ok(!serialized.includes("CUDZE-UZASADNIENIE"));
  assert.ok(!serialized.includes("OBCY-UZYTKOWNIK-W-TEJ-POZYCJI"), "akcja innego użytkownika w tej samej pozycji");
  assert.equal(built.modelInput.actions.length, 3);

  const metaKeys = collectKeys({ market: built.market });

  assert.equal(metaKeys.has("userId"), false);
  assert.equal(metaKeys.has("positionId"), false);
  assert.deepEqual(
    built.actionRefs.map((r) => [r.sequenceNo, r.actionId]),
    [
      [1, String(IDS.action1)],
      [2, String(IDS.action2)],
      [3, String(IDS.action3)],
    ],
  );
});

test("kontrola właściciela: cudza pozycja, cudza akcja i pozycja usunięta → ok:false bez żadnych danych", async () => {
  const { builder, positions } = makeFixture();

  const foreign = await builder.buildModelInput({
    positionId: String(IDS.position),
    userId: String(IDS.userB),
    kind: "full",
  });

  assert.deepEqual(foreign, { ok: false, reason: "position_not_found" });

  const foreignQuick = await builder.buildModelInput({
    positionId: String(IDS.otherPosition),
    userId: String(IDS.userB),
    kind: "quickCheck",
    actionId: String(IDS.action1), // akcja innej pozycji
  });

  assert.deepEqual(foreignQuick, { ok: false, reason: "action_not_found" });

  positions._docs.find((p) => String(p._id) === String(IDS.position)).deletedAt = new Date();

  const deleted = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.deepEqual(deleted, { ok: false, reason: "position_not_found" });
});

test("niepoprawny identyfikator → position_not_found (bez rzucania CastError); brak actionId w quickCheck to błąd programisty", async () => {
  const { builder } = makeFixture();

  assert.deepEqual(
    await builder.buildModelInput({ positionId: "nie-id", userId: String(IDS.userA), kind: "full" }),
    { ok: false, reason: "position_not_found" },
  );
  await assert.rejects(() => builder.buildModelInput({ ...ids(), kind: "quickCheck" }), TypeError);
  await assert.rejects(() => builder.buildModelInput({ ...ids(), kind: "zly" }), TypeError);
});

test("pozycja bez akcji → no_actions", async () => {
  const { builder, actions } = makeFixture();

  actions._docs.length = 0;

  assert.deepEqual(await builder.buildModelInput({ ...ids(), kind: "full" }), {
    ok: false,
    reason: "no_actions",
  });
});

test("builder nie zmienia danych zwróconych przez usługi (zamrożone wejście nie wywołuje błędu)", async () => {
  const frozenNews = Object.freeze([
    Object.freeze({
      datetime: seconds("2026-10-14T10:00:00.000Z"),
      headline: "A",
      summary: "B",
      source: "C",
      url: "https://x",
    }),
  ]);
  const { builder } = makeFixture({ news: frozenNews, bars: Object.freeze(makeBars().map(Object.freeze)) });

  const built = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.equal(built.ok, true);
  assert.equal(built.modelInput.news.length, 1);
});

/* ----------------------------- 8.7.1 quick-check ----------------------------- */

test("quick-check: tylko sprawdzana akcja i wcześniejsze; treść późniejszych akcji nie istnieje w danych", async () => {
  const { builder } = makeFixture();
  const built = await builder.buildModelInput({
    ...ids(),
    kind: "quickCheck",
    actionId: String(IDS.action2),
  });

  assert.equal(built.ok, true);
  assert.deepEqual(
    built.modelInput.actions.map((a) => a.actionType),
    ["open", "add"],
  );

  const serialized = JSON.stringify(built);

  assert.ok(!serialized.includes(TEXT.r3), "późniejsze uzasadnienie wyciekło");
  assert.ok(!serialized.includes(String(IDS.action3)));
  assert.equal(built.actionRefs.length, 2);
});

test("quick-check: stan pozycji jest „na moment decyzji” — późniejsze zamknięcie nie wycieka", async () => {
  const { builder } = makeFixture();
  const early = await builder.buildModelInput({
    ...ids(),
    kind: "quickCheck",
    actionId: String(IDS.action2),
  });

  assert.equal(early.modelInput.positionStatus, "open");
  assert.equal(early.modelInput.closedAt, null);

  const closing = await builder.buildModelInput({
    ...ids(),
    kind: "quickCheck",
    actionId: String(IDS.action3),
  });

  assert.equal(closing.modelInput.positionStatus, "closed");
  assert.equal(closing.modelInput.closedAt, "2026-10-19T16:00:00.000Z");
});

test("quick-check: granica danych to latestCompletedTradingDate(actionDate), a NIE tradingDateRef", async () => {
  const { builder, marketCalls } = makeFixture();
  const built = await builder.buildModelInput({
    ...ids(),
    kind: "quickCheck",
    actionId: String(IDS.action2), // czwartek 15.10, 11:30 ET; tradingDateRef = 2026-10-15
  });

  assert.equal(marketCalls.length, 1);
  assert.equal(marketCalls[0].upTo, "2026-10-14");
  assert.equal(marketCalls[0].since.toISOString(), "2026-10-13T14:00:00.000Z");

  const dates = built.modelInput.marketContext.bars.map((b) => b.date);

  assert.equal(dates.at(-1), "2026-10-14");
  assert.ok(!dates.includes("2026-10-15"), "świeca z dnia decyzji nie może trafić do modelu");
  assert.equal(built.modelInput.dataCoverage.dataCutoffDate, "2026-10-14");
  assert.equal(built.modelInput.dataCoverage.currentSessionCandleMissing, true);
  assert.equal(built.modelInput.dataCoverage.analysisMoment, "2026-10-15T15:30:00.000Z");
});

test("quick-check powtórzony później daje te same dane rynkowe (granica zależy tylko od actionDate)", async () => {
  const first = makeFixture({ now: new Date("2026-10-15T16:00:00.000Z") });
  const later = makeFixture({ now: new Date("2026-10-28T21:00:00.000Z") });

  const a = await first.builder.buildModelInput({ ...ids(), kind: "quickCheck", actionId: String(IDS.action2) });
  const b = await later.builder.buildModelInput({ ...ids(), kind: "quickCheck", actionId: String(IDS.action2) });

  assert.deepEqual(a.modelInput.marketContext, b.modelInput.marketContext);
  assert.deepEqual(a.modelInput.actions, b.modelInput.actions);
  assert.deepEqual(a.modelInput.news, b.modelInput.news);
});

test("quick-check nie dostaje bieżącej ceny: builder nie ma do niej dostępu, a dane zawierają tylko cenę z chwili decyzji", async () => {
  const { builder } = makeFixture();
  const built = await builder.buildModelInput({
    ...ids(),
    kind: "quickCheck",
    actionId: String(IDS.action1),
  });
  const keys = collectKeys(built.modelInput);

  assert.equal(keys.has("currentPrice"), false);
  assert.equal(keys.has("quote"), false);
  assert.equal(built.modelInput.actions[0].marketPriceAtDecision, 100.2);
});

/* ----------------------------- dataCoverage ----------------------------- */

const cases = [
  {
    name: "w trakcie sesji (środa 11:00 ET) — ostrzeżenie o braku dzisiejszej świecy",
    now: "2026-10-21T15:00:00.000Z",
    cutoff: "2026-10-20",
    missing: true,
  },
  {
    name: "po zamknięciu sesji (środa 17:00 ET) — dzisiejsza świeca jest kompletna",
    now: "2026-10-21T21:00:00.000Z",
    cutoff: "2026-10-21",
    missing: false,
  },
  {
    name: "przed otwarciem (środa 08:00 ET)",
    now: "2026-10-21T12:00:00.000Z",
    cutoff: "2026-10-20",
    missing: false,
  },
  {
    name: "weekend (sobota)",
    now: "2026-10-24T12:00:00.000Z",
    cutoff: "2026-10-23",
    missing: false,
  },
  {
    name: "okno niezgodności zmiany czasu PL/USA (wtorek 27.10, Polska już na czasie zimowym, USA jeszcze nie; 15:30 ET = 19:30Z)",
    now: "2026-10-27T19:30:00.000Z",
    cutoff: "2026-10-26",
    missing: true,
  },
  {
    name: "po przejściu USA na czas zimowy (poniedziałek 2.11, 16:30 EST = 21:30Z)",
    now: "2026-11-02T21:30:00.000Z",
    cutoff: "2026-11-02",
    missing: false,
  },
];

for (const c of cases) {
  test(`pełna analiza, dataCoverage: ${c.name}`, async () => {
    const { builder } = makeFixture({ now: new Date(c.now), bars: extendedBars() });
    const built = await builder.buildModelInput({ ...ids(), kind: "full" });
    const coverage = built.modelInput.dataCoverage;

    assert.equal(coverage.dataCutoffDate, c.cutoff);
    assert.equal(coverage.currentSessionCandleMissing, c.missing);
    assert.equal(coverage.analysisMoment, c.now);
    assert.equal(
      coverage.notes.some((n) => n.includes("w trakcie sesji") && n.includes("jeszcze nie istnieje")),
      c.missing,
    );
    assert.equal(built.modelInput.marketContext.bars.at(-1).date <= c.cutoff, true);
  });
}

function extendedBars() {
  // atrapa z kitu kończy się na 30.10 — dla testów listopadowych dołóż 2 i 3.11
  return [
    ...makeBars(),
    ...["2026-11-02", "2026-11-03"].map((date, i) => ({
      date,
      open: 140 + i,
      high: 142 + i,
      low: 138 + i,
      close: 141 + i,
      volume: 2000 + i,
    })),
  ];
}

test("pozycja zamknięta w trakcie sesji, analiza końcowa tego samego dnia: ostrzeżenie w dataCoverage", async () => {
  const { builder, positions, actions } = makeFixture({ now: new Date("2026-10-21T15:00:00.000Z") });

  positions._docs[0].closedAt = new Date("2026-10-21T14:30:00.000Z");
  actions._docs.find((a) => String(a._id) === String(IDS.action3)).actionDate = new Date("2026-10-21T14:30:00.000Z");

  const built = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.equal(built.modelInput.dataCoverage.currentSessionCandleMissing, true);
  assert.match(built.modelInput.dataCoverage.notes[0], /Analiza wykonana w trakcie sesji 2026-10-21/);
  assert.equal(built.modelInput.marketContext.bars.at(-1).date, "2026-10-20");
});

test("dataCoverage opisuje brak świec i świecę wcześniejszą niż granica", async () => {
  const none = makeFixture({ bars: [] });
  const noBars = await none.builder.buildModelInput({ ...ids(), kind: "full" });

  assert.equal(noBars.modelInput.dataCoverage.barCount, 0);
  assert.equal(noBars.modelInput.dataCoverage.firstBarDate, null);
  assert.ok(noBars.modelInput.dataCoverage.notes.includes("Brak danych dziennych w badanym oknie."));

  const stale = makeFixture({ bars: makeBars().filter((b) => b.date <= "2026-10-16") });
  const staleBuilt = await stale.builder.buildModelInput({ ...ids(), kind: "full" });

  assert.equal(staleBuilt.modelInput.dataCoverage.lastBarDate, "2026-10-16");
  assert.ok(
    staleBuilt.modelInput.dataCoverage.notes.some((n) => n.includes("sprzed granicy danych 2026-10-21")),
  );
});

/* ----------------------------- 8.7.2 filtr wiadomości ----------------------------- */

const MOMENT = "2026-10-15T15:30:00.000Z"; // akcja nr 2
const MOMENT_S = seconds(MOMENT);
const LOWER_MS = Date.parse("2026-10-12T14:00:00.000Z");
const UPPER_MS = Date.parse(MOMENT);

const item = (datetime, extra = {}) => ({
  datetime,
  headline: `Nagłówek ${String(datetime)}`,
  summary: "Streszczenie",
  source: "Źródło",
  url: "https://example.com",
  ...extra,
});

const filter = (raw, limits) => filterNews(raw, { lowerMs: LOWER_MS, upperMs: UPPER_MS, limits });

test("filtr: wiadomość dokładnie w momencie decyzji zostaje, o sekundę późniejsza jest odrzucona", () => {
  const { items, stats } = filter([item(MOMENT_S), item(MOMENT_S + 1), item(MOMENT_S - 1)]);

  assert.deepEqual(
    items.map((i) => i.publishedAt),
    ["2026-10-15T15:29:59.000Z", "2026-10-15T15:30:00.000Z"],
  );
  assert.equal(stats.droppedLater, 1);
  assert.equal(stats.droppedNoTime, 0);
});

test("filtr: granica z ułamkiem sekundy w actionDate — wiadomość z tej samej sekundy zostaje, z następnej odpada", () => {
  const upperMs = Date.parse("2026-10-15T15:30:00.500Z");
  const { items } = filterNews([item(MOMENT_S), item(MOMENT_S + 1)], { lowerMs: LOWER_MS, upperMs });

  assert.deepEqual(items.map((i) => i.publishedAt), ["2026-10-15T15:30:00.000Z"]);
});

test("filtr: dolna granica (otwarcie pozycji minus margines) — równo na granicy zostaje, sekundę wcześniej odpada", () => {
  const lowerS = LOWER_MS / 1000;
  const { items, stats } = filter([item(lowerS), item(lowerS - 1)]);

  assert.deepEqual(items.map((i) => i.publishedAt), ["2026-10-12T14:00:00.000Z"]);
  assert.equal(stats.droppedEarlier, 1);
});

test("filtr: brak datetime, null, tekst, NaN, Infinity, liczba ujemna, zero, ułamek, obiekt i element nie-obiekt są odrzucane jako brak poprawnego czasu", () => {
  const bad = [
    { headline: "bez pola datetime", summary: "x", source: "s" },
    item(null),
    item(undefined),
    item(String(MOMENT_S)),
    item("2026-10-15T15:00:00Z"),
    item(Number.NaN),
    item(Number.POSITIVE_INFINITY),
    item(-1),
    item(0),
    item(MOMENT_S - 0.5),
    item({ seconds: MOMENT_S }),
    item([MOMENT_S]),
    null,
    undefined,
    "tekst",
    42,
  ];
  const { items, stats } = filter([...bad, item(MOMENT_S - 60)]);

  assert.equal(items.length, 1);
  assert.equal(stats.fetched, bad.length + 1);
  assert.equal(stats.droppedNoTime, bad.length);
});

test("filtr: milisekundy zamiast sekund są odrzucane jako błędny format (nie jako „przyszłość”)", () => {
  const { items, stats } = filter([item(MOMENT_S * 1000), item((MOMENT_S - 60) * 1000), item(MOMENT_S - 60)]);

  assert.equal(items.length, 1);
  assert.equal(stats.droppedNoTime, 2);
  assert.equal(stats.droppedLater, 0);
  assert.ok(NEWS_DATETIME_MAX_SECONDS < MOMENT_S * 1000);
  assert.ok(NEWS_DATETIME_MIN_SECONDS < MOMENT_S);
});

test("filtr: wartości z krańców zakresu — zbyt stare sekundy (np. rok 1970) to błędny czas", () => {
  const { items, stats } = filter([item(NEWS_DATETIME_MIN_SECONDS - 1), item(1)]);

  assert.equal(items.length, 0);
  assert.equal(stats.droppedNoTime, 2);
});

test("filtr: nadmierna długość tekstu jest skracana (nagłówek 200, streszczenie 500, źródło 60) bez dzielenia znaków wielobajtowych", () => {
  const emoji = "😀";
  const long = item(MOMENT_S - 10, {
    headline: `${"a".repeat(199)}${emoji}${"b".repeat(50)}`,
    summary: "ś".repeat(900),
    source: "z".repeat(200),
  });
  const { items, stats } = filter([long]);

  assert.equal(Array.from(items[0].headline).length, AI_INPUT_LIMITS.maxHeadlineChars);
  assert.equal(Array.from(items[0].summary).length, AI_INPUT_LIMITS.maxSummaryChars);
  assert.equal(Array.from(items[0].source).length, AI_INPUT_LIMITS.maxSourceChars);
  assert.ok(items[0].headline.endsWith("…"));
  assert.ok(items[0].headline.isWellFormed(), "uciętą parę zastępczą");
  assert.equal(stats.truncatedTexts, 3);

  const emojiCut = filter([item(MOMENT_S - 10, { headline: `${"a".repeat(198)}${emoji}${emoji}` })]);

  assert.equal(Array.from(emojiCut.items[0].headline).length, AI_INPUT_LIMITS.maxHeadlineChars);
  assert.doesNotThrow(() => JSON.stringify(emojiCut.items[0]));
  assert.ok(emojiCut.items[0].headline.isWellFormed(), "uciętą parę zastępczą");
});

test("filtr: tekst krótszy niż limit nie jest zmieniany poza przycięciem białych znaków; nietekstowe pola → pusty tekst", () => {
  const { items } = filter([
    item(MOMENT_S - 5, { headline: "  Krótki  ", summary: 123, source: null }),
  ]);

  assert.deepEqual(items[0], {
    publishedAt: "2026-10-15T15:29:55.000Z",
    headline: "Krótki",
    summary: "",
    source: "",
  });
});

test("filtr: element bez nagłówka i bez streszczenia jest odrzucany; z samym streszczeniem zostaje", () => {
  const { items, stats } = filter([
    item(MOMENT_S - 5, { headline: "", summary: "" }),
    item(MOMENT_S - 4, { headline: undefined, summary: "Tylko streszczenie" }),
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].summary, "Tylko streszczenie");
  assert.equal(stats.droppedEmpty, 1);
});

test("filtr: limit liczby — zostaje 20 najnowszych w kolejności chronologicznej, reszta liczona jako odrzucona z powodu limitu", () => {
  const raw = Array.from({ length: 25 }, (_, i) => item(MOMENT_S - 3000 + i * 10));
  const shuffled = [...raw].reverse();
  const { items, stats } = filter(shuffled);

  assert.equal(items.length, 20);
  assert.equal(stats.droppedOverLimit, 5);
  assert.equal(items[0].publishedAt, new Date((MOMENT_S - 3000 + 5 * 10) * 1000).toISOString());
  assert.equal(items.at(-1).publishedAt, new Date((MOMENT_S - 3000 + 24 * 10) * 1000).toISOString());

  const sorted = items.map((i) => i.publishedAt);

  assert.deepEqual(sorted, [...sorted].sort());
});

test("filtr: zwracane elementy mają tylko dozwolone pola (bez url i obcych pól); wejście nie jest mutowane", () => {
  const original = Object.freeze(
    item(MOMENT_S - 5, { id: 99, related: "AAPL", image: "https://img", category: "x" }),
  );
  const { items } = filter(Object.freeze([original]));

  assert.deepEqual(Object.keys(items[0]), ["publishedAt", "headline", "summary", "source"]);
});

test("filtr: wejście niebędące listą → pusty wynik z zerowymi licznikami", () => {
  for (const raw of [null, undefined, {}, "x", 5]) {
    const { items, stats } = filter(raw);

    assert.deepEqual(items, []);
    assert.equal(stats.fetched, 0);
  }
});

/* ----------------------------- 8.7.2 w builderze ----------------------------- */

test("builder: zapytanie o newsy jest szersze o dzień z obu stron, a filtr tnie dokładnie do momentu akcji (quick-check)", async () => {
  const news = [
    item(MOMENT_S, { headline: "równo w momencie" }),
    item(MOMENT_S + 1, { headline: "sekunda później" }),
    item(seconds("2026-10-16T10:00:00.000Z"), { headline: "dzień później" }),
    item(seconds("2026-10-14T10:00:00.000Z"), { headline: "wcześniej" }),
    item(seconds("2026-10-01T10:00:00.000Z"), { headline: "dawno przed otwarciem" }),
    { headline: "bez czasu", summary: "x", source: "s" },
  ];
  const { builder, newsCalls } = makeFixture({ news });
  const built = await builder.buildModelInput({
    ...ids(),
    kind: "quickCheck",
    actionId: String(IDS.action2),
  });

  assert.deepEqual(newsCalls, [{ ticker: "AAPL", from: "2026-10-11", to: "2026-10-16" }]);
  assert.deepEqual(
    built.modelInput.news.map((n) => n.headline),
    ["wcześniej", "równo w momencie"],
  );

  const { news: stats } = built.market;

  assert.deepEqual(
    [stats.fetched, stats.kept, stats.droppedNoTime, stats.droppedLater, stats.droppedEarlier],
    [6, 2, 1, 2, 1],
  );
  assert.equal(stats.available, true);
  assert.equal(stats.rangeFrom, "2026-10-11");
  assert.equal(stats.rangeTo, "2026-10-16");

  const serialized = JSON.stringify(built.modelInput);

  assert.ok(!serialized.includes("sekunda później"));
  assert.ok(!serialized.includes("dzień później"));
});

test("builder: pełna analiza tnie newsy do momentu analizy (now), nie do momentu ostatniej akcji", async () => {
  const now = new Date("2026-10-21T21:00:00.000Z");
  const news = [
    item(seconds("2026-10-21T20:59:59.000Z"), { headline: "tuż przed analizą" }),
    item(seconds("2026-10-21T21:00:00.000Z"), { headline: "równo w momencie analizy" }),
    item(seconds("2026-10-21T21:00:01.000Z"), { headline: "po analizie" }),
  ];
  const { builder, newsCalls } = makeFixture({ news, now });
  const built = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.deepEqual(
    built.modelInput.news.map((n) => n.headline),
    ["tuż przed analizą", "równo w momencie analizy"],
  );
  assert.equal(newsCalls[0].to, "2026-10-22");
});

test("builder: skrócenie treści wiadomości jest zgłoszone w dataCoverage (liczba wiadomości i limity); bez skrócenia — brak notatki", async () => {
  const long = [
    item(seconds("2026-10-14T10:00:00.000Z"), { headline: "N".repeat(400) }),
    item(seconds("2026-10-14T11:00:00.000Z"), { summary: "S".repeat(900), source: "Z".repeat(100) }),
    item(seconds("2026-10-14T12:00:00.000Z")),
  ];
  const { builder } = makeFixture({ news: long });
  const built = await builder.buildModelInput({ ...ids(), kind: "full" });
  const note = built.modelInput.dataCoverage.notes.find((n) => n.includes("została skrócona"));

  assert.ok(note, "brak notatki o skróceniu");
  assert.match(note, /\(2\)/);
  assert.match(note, /nagłówek do 200 znaków, streszczenie do 500, źródło do 60/);
  assert.equal(built.market.news.truncatedItems, 2);
  assert.equal(built.market.news.truncatedTexts, 3);

  const short = makeFixture({ news: [item(seconds("2026-10-14T10:00:00.000Z"))] });
  const plain = await short.builder.buildModelInput({ ...ids(), kind: "full" });

  assert.ok(!plain.modelInput.dataCoverage.notes.some((n) => n.includes("skrócona")));
});

test("builder: awaria newsów nie przerywa budowania — pusta lista, newsAvailable:false, ostrzeżenie w dataCoverage; log bez komunikatu błędu", async () => {
  const secret = "KLUCZ-FINNHUB-123";
  const logs = [];
  const { builder } = makeFixture({
    logs,
    newsError: new Error(`fetch failed https://finnhub.io/api/v1/company-news?token=${secret}`),
  });
  const built = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.equal(built.ok, true);
  assert.deepEqual(built.modelInput.news, []);
  assert.equal(built.modelInput.dataCoverage.newsAvailable, false);
  assert.ok(built.modelInput.dataCoverage.notes.some((n) => n.includes("Nie udało się pobrać wiadomości")));
  assert.equal(built.market.news.available, false);

  const everything = JSON.stringify({ built, logs });

  assert.ok(!everything.includes(secret));
  assert.ok(logs.some((l) => l.event === "ai_input_news_unavailable" && l.errorName === "Error"));
});

test("builder: awaria danych rynkowych → ok:false/market_data_unavailable; log bez komunikatu błędu", async () => {
  const secret = "KLUCZ-TWELVE-456";
  const logs = [];
  const { builder } = makeFixture({
    logs,
    marketError: new Error(`Błąd Twelve Data apikey=${secret}`),
  });
  const result = await builder.buildModelInput({ ...ids(), kind: "full" });

  assert.deepEqual(result, { ok: false, reason: "market_data_unavailable" });
  assert.ok(!JSON.stringify({ result, logs }).includes(secret));
});

test("logi buildera zawierają wyłącznie rodzaje zdarzeń i liczby — bez treści uzasadnień i newsów", async () => {
  const logs = [];
  const { builder } = makeFixture({
    logs,
    news: [item(seconds("2026-10-14T10:00:00.000Z"), { headline: "TAJNY-NAGLOWEK" })],
  });

  await builder.buildModelInput({ ...ids(), kind: "full" });

  const serialized = JSON.stringify(logs);

  assert.ok(logs.some((l) => l.event === "ai_input_built"));
  for (const text of [TEXT.r1, TEXT.e1, TEXT.r2, TEXT.r3, "TAJNY-NAGLOWEK", String(IDS.userA), String(IDS.position)]) {
    assert.ok(!serialized.includes(text), `log zawiera „${text}”`);
  }
});
