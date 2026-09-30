import "dotenv/config";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import CacheEntry from "../models/CacheEntry.js";
import { getPriceAtMoment } from "../services/intradayPriceService.js";

/**
 * Test integracyjny — wymaga MONGODB_URI w .env (tak samo jak
 * historyPriceService.integration.test.js). Twelve Data jest podmieniane
 * atrapą globalThis.fetch, więc test nie zużywa ani jednego kredytu API.
 *
 * Najważniejsze pytania, na które ten plik odpowiada:
 *   1. Czy dla decyzji w środku minuty (np. 15:37:42) cena NIGDY nie
 *      pochodzi ze świecy, która w tamtej chwili jeszcze się budowała.
 *   2. Czy wyszukiwanie ostatniej świecy jest odporne na przerwę w
 *      notowaniach (nie tylko na kilkanaście minut ciszy).
 */

const originalFetch = globalThis.fetch;
const MONGO_URI = process.env.MONGODB_URI;
const originalApiKey = process.env.TWELVE_DATA_API_KEY;

// Świece co minutę, wtorek 15.09.2026, 15:20–15:40 UTC (11:20–11:40 ET —
// w środku regularnej sesji). close rośnie o 0.01 na minutę, żeby łatwo
// rozpoznać, KTÓRA świeca została wybrana.
function buildOneMinuteCandles() {
  const candles = [];

  for (let minute = 20; minute <= 40; minute += 1) {
    const mm = String(minute).padStart(2, "0");

    candles.push({
      datetime: `2026-09-15 15:${mm}:00`,
      open: (250 + minute * 0.01).toFixed(2),
      high: (250.5 + minute * 0.01).toFixed(2),
      low: (249.5 + minute * 0.01).toFixed(2),
      close: (250.2 + minute * 0.01).toFixed(2),
      volume: "10000",
    });
  }

  return candles;
}

const ONE_MIN_CANDLES = buildOneMinuteCandles();

// Dwa dni historii dziennej — dla ścieżki fallback poza sesją. Różne ceny
// na różnych dniach, żeby test faktycznie sprawdzał, że pobrano WŁAŚCIWY
// dzień, a nie tylko "jakiekolwiek" dane dzienne.
const DAILY_BARS = [
  {
    datetime: "2026-09-14", // poniedziałek — poprzednia sesja względem 15.09 przed otwarciem
    open: "248",
    high: "251",
    low: "247",
    close: "249.50",
    volume: "40000000",
  },
  {
    datetime: "2026-09-18", // piątek — ostatnia sesja przed weekendem 19–20.09
    open: "252",
    high: "254",
    low: "251",
    close: "253.75",
    volume: "41000000",
  },
];

let fetchCalls = 0;
let lastUrl = null;

function mockTwelveData() {
  fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    lastUrl = String(url);

    const params = new URL(url).searchParams;
    const interval = params.get("interval");

    if (interval === "1min") {
      const startDate = params.get("start_date");
      const endDate = params.get("end_date");

      const values = ONE_MIN_CANDLES.filter((bar) => {
        const iso = `${bar.datetime.replace(" ", "T")}Z`;

        return iso >= `${startDate}Z` && iso <= `${endDate}Z`;
      });

      return new Response(
        JSON.stringify({
          meta: {},
          values: [...values].reverse(),
          status: "ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // interval === "1day" (fallback poza sesją) — filtrujemy tak jak
    // prawdziwe Twelve Data, żeby test naprawdę sprawdzał, KTÓRY dzień
    // został poproszony, a nie tylko "czy dostaliśmy jakieś dane".
    const startDate = params.get("start_date");
    const endDate = params.get("end_date");
    const values = DAILY_BARS.filter(
      (bar) => bar.datetime >= startDate && bar.datetime <= endDate,
    );

    return new Response(
      JSON.stringify({ meta: {}, values: [...values].reverse(), status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

async function clearCache() {
  await CacheEntry.deleteMany({
    key: { $regex: "^(intraday|history):(AAPL):" },
  });
}

before(async () => {
  if (!MONGO_URI) {
    throw new Error(
      "Brak MONGODB_URI — test integracyjny wymaga połączenia z MongoDB.",
    );
  }

  process.env.TWELVE_DATA_API_KEY = originalApiKey || "test-key";

  await mongoose.connect(MONGO_URI);
  await clearCache();
});

beforeEach(() => {
  mockTwelveData();
});

after(async () => {
  await clearCache();
  await mongoose.disconnect();

  globalThis.fetch = originalFetch;

  if (originalApiKey === undefined) {
    delete process.env.TWELVE_DATA_API_KEY;
  } else {
    process.env.TWELVE_DATA_API_KEY = originalApiKey;
  }
});

test("getPriceAtMoment — decyzja w środku minuty NIGDY nie dostaje świecy, która w tej chwili jeszcze się budowała", async () => {
  await clearCache();

  // 15:37:42 UTC — w środku minuty "15:37". Ta świeca zamyka się dopiero
  // o 15:38:00, więc NIE WOLNO jej użyć.
  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T15:37:42Z"),
  );

  assert.equal(wynik.source, "twelve_data_intraday");
  // Ostatnia W PEŁNI zamknięta świeca to "15:36" (otwarcie), a więc jej
  // ZAMKNIĘCIE (asOf) to 15:37:00 — nie "15:37" (to byłaby wciąż budująca
  // się świeca).
  assert.equal(wynik.asOf.toISOString(), "2026-09-15T15:37:00.000Z");
  assert.equal(wynik.price, 250.56); // close świecy "15:36" (250.2 + 36*0.01)
  assert.ok(
    wynik.asOf.getTime() <= new Date("2026-09-15T15:37:42Z").getTime(),
    "asOf nie może być późniejsze niż moment decyzji",
  );
});

test("getPriceAtMoment — decyzja dokładnie na granicy minuty (15:37:00.000) też nie bierze świecy 15:37", async () => {
  await clearCache();

  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T15:37:00.000Z"),
  );

  // O 15:37:00.000 świeca "15:37" DOPIERO się zaczyna — nadal nie jest
  // zamknięta. Bierzemy więc close świecy "15:36" (asOf = 15:37:00).
  assert.equal(wynik.asOf.toISOString(), "2026-09-15T15:37:00.000Z");
});

test("getPriceAtMoment — decyzja tuż po zamknięciu minuty bierze WŁAŚNIE tę świecę", async () => {
  await clearCache();

  // 15:37:59.999 to WCIĄŻ w obrębie świecy "15:37" (trwa do < 15:38:00) —
  // nadal niekompletna, więc dalej bierzemy "15:36" (asOf = 15:37:00).
  const jeszczeWTrakcie = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T15:37:59.999Z"),
  );

  assert.equal(jeszczeWTrakcie.asOf.toISOString(), "2026-09-15T15:37:00.000Z");

  // 15:38:00.000 — świeca "15:37" jest już w pełni zamknięta, jej
  // zamknięcie (asOf) to 15:38:00.
  const juzZamknieta = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T15:38:00.000Z"),
  );

  assert.equal(juzZamknieta.asOf.toISOString(), "2026-09-15T15:38:00.000Z");
});

test("getPriceAtMoment — powtórzone zapytanie dla tej samej decyzji to cache hit, nie nowy fetch", async () => {
  await clearCache();

  const moment = new Date("2026-09-15T15:37:42Z");

  const pierwszy = await getPriceAtMoment("AAPL", moment);

  assert.equal(fetchCalls, 1);
  assert.equal(pierwszy.fromCache, false);

  const drugi = await getPriceAtMoment("AAPL", moment);

  assert.equal(fetchCalls, 1, "drugie zapytanie nie powinno zużyć kredytu API");
  assert.equal(drugi.fromCache, true);
  assert.equal(drugi.price, pierwszy.price);
});

test("getPriceAtMoment — poza godzinami sesji spada na ostatnie zamknięcie dzienne", async () => {
  await clearCache();

  // Sobota — żadna świeca "dzisiejszej sesji" nie istnieje. Ostatnia
  // zakończona sesja to piątek 18.09.
  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-19T15:00:00Z"),
  );

  assert.equal(wynik.source, "twelve_data_daily_close");
  assert.equal(wynik.asOf, "2026-09-18");
  assert.equal(wynik.price, 253.75);
  assert.match(lastUrl, /interval=1day/);
});

test("getPriceAtMoment — przed otwarciem sesji też spada na poprzednie zamknięcie dzienne", async () => {
  await clearCache();

  // 8:00 ET, przed otwarciem 9:30 ET — ostatnia zakończona sesja to
  // poprzedni dzień, poniedziałek 14.09.
  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T12:00:00Z"),
  );

  assert.equal(wynik.source, "twelve_data_daily_close");
  assert.equal(wynik.asOf, "2026-09-14");
  assert.equal(wynik.price, 249.5);
});

/* ------------------------------------------------------------------ *
 * Odporność na przerwę w notowaniach (halt / mało płynny instrument) —
 * sedno poprawki: okno od OTWARCIA sesji, nie stałe kilkanaście minut
 * wstecz. Scenariusz: ostatni handel był o 9:35 ET, decyzja zapada o
 * 11:00 ET — to 85 minut ciszy, więcej niż jakiekolwiek rozsądne stałe
 * okno wstecz by objęło.
 * ------------------------------------------------------------------ */

test("getPriceAtMoment — znajduje ostatnią świecę mimo długiej przerwy w notowaniach (85 minut ciszy)", async () => {
  await clearCache();

  // Podmieniamy atrapę na tę specyficzną sytuację: świece istnieją TYLKO
  // na samym początku sesji (9:30–9:35 ET = 13:30–13:35 UTC), potem nic
  // aż do końca dnia — symuluje halt albo bardzo cichy instrument.
  const earlySessionCandles = [
    {
      datetime: "2026-09-15 13:30:00",
      open: "100",
      high: "101",
      low: "99.5",
      close: "100.10",
      volume: "5000",
    },
    {
      datetime: "2026-09-15 13:34:00",
      open: "100.10",
      high: "100.60",
      low: "99.9",
      close: "100.42", // ostatnia dostępna cena przed ciszą
      volume: "3000",
    },
  ];

  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    lastUrl = String(url);

    const params = new URL(url).searchParams;
    const startDate = params.get("start_date");
    const endDate = params.get("end_date");

    const values = earlySessionCandles.filter((bar) => {
      const iso = `${bar.datetime.replace(" ", "T")}Z`;

      return iso >= `${startDate}Z` && iso <= `${endDate}Z`;
    });

    return new Response(
      JSON.stringify({ meta: {}, values: [...values].reverse(), status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  // Decyzja o 11:00 ET (15:00 UTC) — 85 minut po ostatniej świecy (9:35 ET).
  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T15:00:00Z"),
  );

  assert.equal(
    wynik.source,
    "twelve_data_intraday",
    "z całą sesją w oknie powinniśmy ZNALEŹĆ ostatnią świecę, nie spaść na fallback dzienny",
  );
  assert.equal(wynik.price, 100.42);
  assert.equal(wynik.asOf.toISOString(), "2026-09-15T13:35:00.000Z"); // 13:34 + 1 minuta

  // Zapytanie musiało objąć okno od otwarcia sesji (13:30 UTC), nie
  // stałe kilkanaście minut przed 15:00.
  assert.match(lastUrl, /start_date=2026-09-15T13%3A30%3A00/);

  mockTwelveData();
});

test("getPriceAtMoment — dokładnie w chwili otwarcia sesji (9:30:00.000 ET) nie próbuje pytać o odwrócone okno", async () => {
  await clearCache();

  // Okno [windowStart, lastClosedCandleStart] wyszłoby odwrócone
  // (lastClosedCandleStart = 9:29, czyli PRZED otwarciem) — kod musi to
  // wykryć i przejść od razu do fallbacku, bez wysyłania błędnego
  // zapytania do Twelve Data.
  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T13:30:00.000Z"),
  );

  assert.equal(wynik.source, "twelve_data_daily_close");
  assert.equal(
    fetchCalls,
    1,
    "tylko fallback dzienny, żadnego (błędnego) zapytania intraday",
  );
});

/* ------------------------------------------------------------------ *
 * Regresja: sekundy w actionDate nie mogą psuć początku okna.
 * Wcześniej regularSessionOpenUtc zwracała 09:30:SS zamiast 09:30:00,
 * więc decyzja o 9:31:05 ET dostawała okno [09:30:05, 09:30:00] (odwrócone)
 * i błędnie spadała na wczorajsze zamknięcie dzienne.
 * ------------------------------------------------------------------ */

test("getPriceAtMoment — decyzja o 9:31:05 ET używa świecy 9:30, nie spada na fallback dzienny", async () => {
  await clearCache();

  const firstCandle = [
    {
      datetime: "2026-09-15 13:30:00", // 9:30 ET
      open: "100",
      high: "101",
      low: "99.5",
      close: "100.50",
      volume: "5000",
    },
  ];

  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    lastUrl = String(url);

    const params = new URL(url).searchParams;
    const startDate = params.get("start_date");
    const endDate = params.get("end_date");

    const values = firstCandle.filter((bar) => {
      const iso = `${bar.datetime.replace(" ", "T")}Z`;

      return iso >= `${startDate}Z` && iso <= `${endDate}Z`;
    });

    return new Response(JSON.stringify({ meta: {}, values, status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const wynik = await getPriceAtMoment(
    "AAPL",
    new Date("2026-09-15T13:31:05Z"),
  );

  assert.equal(wynik.source, "twelve_data_intraday");
  assert.equal(wynik.price, 100.5);
  assert.equal(wynik.asOf.toISOString(), "2026-09-15T13:31:00.000Z");
});

test("getPriceAtMoment — start_date zapytania to dokładnie 09:30:00, niezależnie od sekund w actionDate", async () => {
  await clearCache();

  await getPriceAtMoment("AAPL", new Date("2026-09-15T15:37:42.123Z"));

  // %3A = ":" — URLSearchParams koduje dwukropki.
  assert.match(lastUrl, /start_date=2026-09-15T13%3A30%3A00(&|$)/);
});
