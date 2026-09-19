import { test } from "node:test";
import assert from "node:assert/strict";

import { CACHE_TTL_SECONDS, keys } from "../services/cacheService.js";

test("CACHE_TTL_SECONDS — zawiera TTL dla wszystkich typów cache", () => {
  assert.equal(CACHE_TTL_SECONDS.quote, 3 * 60);
  assert.equal(CACHE_TTL_SECONDS.news, 2 * 60 * 60);
  assert.equal(CACHE_TTL_SECONDS.price_history, 12 * 60 * 60);
});

test("CACHE_TTL_SECONDS — wszystkie TTL są dodatnie", () => {
  for (const ttl of Object.values(CACHE_TTL_SECONDS)) {
    assert.equal(typeof ttl, "number");
    assert.ok(ttl > 0);
  }
});

test("keys.quote — normalizuje ticker", () => {
  assert.equal(keys.quote("aapl"), "quote:AAPL");

  assert.equal(keys.quote("  msft  "), "quote:MSFT");
});

test("keys.quote — odrzuca pusty ticker", () => {
  assert.throws(() => keys.quote(""), /Ticker jest wymagany/);

  assert.throws(() => keys.quote("   "), /Ticker jest wymagany/);

  assert.throws(() => keys.quote(null), /Ticker jest wymagany/);
});

test("keys.news — tworzy klucz zależny od tickera i zakresu dat", () => {
  assert.equal(
    keys.news("aapl", "2026-09-01", "2026-09-19"),
    "news:AAPL:2026-09-01:2026-09-19",
  );
});

test("keys.news — normalizuje ticker", () => {
  assert.equal(
    keys.news("  msft  ", "2026-09-01", "2026-09-19"),
    "news:MSFT:2026-09-01:2026-09-19",
  );
});

test("keys.priceHistory — tworzy prawidłowy klucz", () => {
  assert.equal(
    keys.priceHistory("aapl", "1day", "2026-01-01", "2026-09-19"),
    "history:AAPL:1day:2026-01-01:2026-09-19",
  );
});

test("keys.priceHistory — obsługuje brak zakresu dat", () => {
  assert.equal(
    keys.priceHistory("aapl", "1day", undefined, undefined),
    "history:AAPL:1day:none:none",
  );
});

test("keys.priceHistory — normalizuje ticker", () => {
  assert.equal(
    keys.priceHistory("  tsla  ", "1day", "2026-01-01", "2026-09-19"),
    "history:TSLA:1day:2026-01-01:2026-09-19",
  );
});
