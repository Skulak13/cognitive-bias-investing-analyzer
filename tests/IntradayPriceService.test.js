import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntradaySeries } from "../services/intradayPriceService.js";

/**
 * Testy bez sieci i bez bazy — sprawdzają samo czytanie odpowiedzi
 * Twelve Data dla danych intraday. Zachowanie cache'u i wybór świecy
 * "bez wglądu w przyszłość" są testowane w
 * intradayPriceService.integration.test.js.
 */

const okPayload = {
  meta: { symbol: "AAPL", interval: "1min" },
  values: [
    {
      datetime: "2026-09-15 15:37:00",
      open: "251.10",
      high: "251.30",
      low: "250.90",
      close: "251.20",
      volume: "12000",
    },
    {
      datetime: "2026-09-15 15:36:00",
      open: "250.90",
      high: "251.15",
      low: "250.80",
      close: "251.10",
      volume: "11000",
    },
  ],
  status: "ok",
};

test("normalizeIntradaySeries — zachowuje PEŁNY znacznik czasu (nie tylko dzień)", () => {
  const bars = normalizeIntradaySeries(okPayload, "AAPL");

  assert.equal(bars.length, 2);
  assert.ok(bars[0].datetime instanceof Date);
  // Posortowane chronologicznie: 15:36 przed 15:37.
  assert.equal(bars[0].datetime.toISOString(), "2026-09-15T15:36:00.000Z");
  assert.equal(bars[1].datetime.toISOString(), "2026-09-15T15:37:00.000Z");
});

test("normalizeIntradaySeries — zamienia stringi OHLCV na liczby", () => {
  const bars = normalizeIntradaySeries(okPayload, "AAPL");

  assert.deepEqual(
    { ...bars[1], datetime: undefined },
    {
      datetime: undefined,
      open: 251.1,
      high: 251.3,
      low: 250.9,
      close: 251.2,
      volume: 12000,
    },
  );
});

test("normalizeIntradaySeries — format datetime ze spacją ('YYYY-MM-DD HH:MM:SS'), nie 'T'", () => {
  // To jest dokładnie format, jaki zwraca Twelve Data dla interwałów
  // intraday — inny niż "YYYY-MM-DD" dla danych dziennych.
  const bars = normalizeIntradaySeries(
    {
      status: "ok",
      values: [
        {
          datetime: "2026-09-15 09:30:00",
          open: "1",
          high: "2",
          low: "1",
          close: "2",
          volume: "100",
        },
      ],
    },
    "AAPL",
  );

  assert.equal(bars[0].datetime.toISOString(), "2026-09-15T09:30:00.000Z");
});

test("normalizeIntradaySeries — odrzuca świecę z nierozpoznawalnym formatem datetime", () => {
  const bars = normalizeIntradaySeries(
    {
      status: "ok",
      values: [
        {
          datetime: "2026-09-15T15:37:00Z",
          open: "1",
          high: "2",
          low: "1",
          close: "2",
        }, // "T" zamiast spacji
        { datetime: "nie-data", open: "1", high: "2", low: "1", close: "2" },
        {
          datetime: "2026-09-15 15:36:00",
          open: "1",
          high: "2",
          low: "1",
          close: "2",
        },
      ],
    },
    "AAPL",
  );

  assert.equal(bars.length, 1);
  assert.equal(bars[0].datetime.toISOString(), "2026-09-15T15:36:00.000Z");
});

test("normalizeIntradaySeries — wymaga kompletnego OHLC (tak samo jak historia dzienna)", () => {
  const bars = normalizeIntradaySeries(
    {
      status: "ok",
      values: [
        { datetime: "2026-09-15 15:36:00", close: "251.10" }, // brak open/high/low
        {
          datetime: "2026-09-15 15:37:00",
          open: "251.10",
          high: "251.30",
          low: "250.90",
          close: "251.20",
        },
      ],
    },
    "AAPL",
  );

  assert.equal(bars.length, 1);
  assert.equal(bars[0].datetime.toISOString(), "2026-09-15T15:37:00.000Z");
});

test("normalizeIntradaySeries — brak wolumenu daje null, nie zero", () => {
  const bars = normalizeIntradaySeries(
    {
      status: "ok",
      values: [
        {
          datetime: "2026-09-15 15:36:00",
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

test("normalizeIntradaySeries — błąd w treści przy HTTP 200 też jest błędem", () => {
  assert.throws(
    () =>
      normalizeIntradaySeries(
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

test("normalizeIntradaySeries — odpowiedź bez values jest odrzucana", () => {
  assert.throws(
    () => normalizeIntradaySeries({ status: "ok" }, "AAPL"),
    /Brak danych intraday/,
  );
  assert.throws(
    () => normalizeIntradaySeries(null, "AAPL"),
    /Nieczytelna odpowiedź/,
  );
});
