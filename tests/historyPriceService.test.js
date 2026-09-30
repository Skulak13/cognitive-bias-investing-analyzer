import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterBarsUpTo,
  normalizeTimeSeries,
} from "../services/historyPriceService.js";
import { toTradingDateRef } from "../utils/tradingCalendar.js";

/**
 * Testy bez sieci i bez bazy — sprawdzają samo czytanie odpowiedzi
 * Twelve Data i cięcie serii po dniu sesji. Zachowanie cache'u jest
 * testowane osobno, w historyPriceService.integration.test.js.
 */

const okPayload = {
  meta: { symbol: "AAPL", interval: "1day", currency: "USD" },
  values: [
    {
      datetime: "2026-09-18",
      open: "252.00",
      high: "255.10",
      low: "251.40",
      close: "254.20",
      volume: "48123000",
    },
    {
      datetime: "2026-09-17",
      open: "249.00",
      high: "253.00",
      low: "248.10",
      close: "252.10",
      volume: "51200000",
    },
  ],
  status: "ok",
};

test("normalizeTimeSeries — zamienia stringi na liczby", () => {
  const bars = normalizeTimeSeries(okPayload, "AAPL");

  assert.equal(bars.length, 2);

  assert.deepEqual(bars[1], {
    date: "2026-09-18",
    open: 252,
    high: 255.1,
    low: 251.4,
    close: 254.2,
    volume: 48123000,
  });
});

test("normalizeTimeSeries — porządkuje chronologicznie", () => {
  // Twelve Data domyślnie zwraca od najnowszej — my zakładamy dalej
  // porządek rosnący, więc sortujemy u siebie.
  const bars = normalizeTimeSeries(okPayload, "AAPL");

  assert.deepEqual(
    bars.map((bar) => bar.date),
    ["2026-09-17", "2026-09-18"],
  );
});

test("normalizeTimeSeries — brak wolumenu daje null, nie zero", () => {
  const bars = normalizeTimeSeries(
    {
      status: "ok",
      values: [
        {
          datetime: "2026-09-18",
          open: "1",
          high: "2",
          low: "1",
          close: "2",
          volume: "",
        },
      ],
    },
    "AAPL",
  );

  assert.equal(bars[0].volume, null);
});

test("normalizeTimeSeries — odrzuca świece bez daty lub bez ceny zamknięcia", () => {
  const bars = normalizeTimeSeries(
    {
      status: "ok",
      values: [
        {
          datetime: "2026-09-18",
          open: "252",
          high: "255",
          low: "251",
          close: "254.20",
        },
        { datetime: "", close: "1" },
        { datetime: "2026-09-17", close: null },
      ],
    },
    "AAPL",
  );

  assert.deepEqual(
    bars.map((bar) => bar.date),
    ["2026-09-18"],
  );
});

test("normalizeTimeSeries — błąd w treści przy HTTP 200 też jest błędem", () => {
  // Typowa pułapka Twelve Data: kod HTTP 200, a w środku status "error".
  assert.throws(
    () =>
      normalizeTimeSeries(
        {
          code: 400,
          message: "Invalid **interval** provided",
          status: "error",
        },
        "AAPL",
      ),
    /Błąd Twelve Data dla AAPL/,
  );
});

test("normalizeTimeSeries — wyczerpany limit ma własny, czytelny komunikat", () => {
  assert.throws(
    () =>
      normalizeTimeSeries(
        {
          code: 429,
          message: "You have run out of API credits",
          status: "error",
        },
        "AAPL",
      ),
    /Wyczerpany limit zapytań Twelve Data/,
  );
});

test("normalizeTimeSeries — świeca z obecnym close, ale brakującym open/high/low jest odrzucana", () => {
  // Wcześniej wymagaliśmy tylko `close` — taka świeca przechodziłaby z
  // `open: null`, co mogło po cichu trafić do cache'u i do AI.
  const bars = normalizeTimeSeries(
    {
      status: "ok",
      values: [
        {
          datetime: "2026-09-18",
          open: "252",
          high: "255",
          low: "251",
          close: "254.20",
        }, // OK, kompletna
        { datetime: "2026-09-17", high: "253", low: "248.10", close: "252.10" }, // brak open
      ],
    },
    "AAPL",
  );

  assert.deepEqual(
    bars.map((bar) => bar.date),
    ["2026-09-18"],
  );
});

test("normalizeTimeSeries — jedna wadliwa świeca nie psuje pozostałych w tym samym oknie", () => {
  const bars = normalizeTimeSeries(
    {
      status: "ok",
      values: [
        { datetime: "2026-09-16", open: "1", high: "2", low: "1", close: "2" },
        { datetime: "2026-09-17" }, // cała świeca pusta
        { datetime: "2026-09-18", open: "3", high: "4", low: "3", close: "4" },
      ],
    },
    "AAPL",
  );

  assert.deepEqual(
    bars.map((bar) => bar.date),
    ["2026-09-16", "2026-09-18"],
  );
});

test("normalizeTimeSeries — odpowiedź bez values jest odrzucana", () => {
  assert.throws(
    () => normalizeTimeSeries({ status: "ok" }, "AAPL"),
    /Brak danych historycznych/,
  );

  assert.throws(
    () => normalizeTimeSeries(null, "AAPL"),
    /Nieczytelna odpowiedź/,
  );
});

/* ------------------------------------------------------------------ *
 * Separacja danych dla quick-checku (sekcja 6.1)
 * ------------------------------------------------------------------ */

const bars = [
  { date: "2026-09-16", close: 10 },
  { date: "2026-09-17", close: 11 },
  { date: "2026-09-18", close: 12 },
];

test("filterBarsUpTo — przyjmuje tradingDateRef prosto z bazy (Date, północ UTC)", () => {
  const ref = toTradingDateRef("2026-09-17T18:00:00Z");

  assert.deepEqual(
    filterBarsUpTo(bars, ref).map((bar) => bar.date),
    ["2026-09-16", "2026-09-17"],
  );
});

test("filterBarsUpTo — przyjmuje też zwykły tekst YYYY-MM-DD", () => {
  assert.deepEqual(
    filterBarsUpTo(bars, "2026-09-16").map((bar) => bar.date),
    ["2026-09-16"],
  );
});

test("filterBarsUpTo — dzień sesji jest granicą WŁĄCZNIE", () => {
  assert.equal(filterBarsUpTo(bars, "2026-09-18").length, 3);
});
