import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import CacheEntry from "../models/CacheEntry.js";
import {
  getCurrentPrice,
  getCompanyNews,
} from "../services/currentPriceService.js";

const originalFetch = globalThis.fetch;

const MONGO_URI = process.env.MONGODB_URI;

const TEST_KEYS = [
  "quote:AAPL",
  "quote:MSFT",
  "quote:TSLA",
  "news:AAPL:2026-09-01:2026-09-19",
];

before(async () => {
  if (!MONGO_URI) {
    throw new Error(
      "Brak MONGO_URI lub MONGODB_URI — test integracyjny wymaga połączenia z MongoDB.",
    );
  }

  await mongoose.connect(MONGO_URI);

  await CacheEntry.deleteMany({
    key: {
      $in: TEST_KEYS,
    },
  });
});

after(async () => {
  await CacheEntry.deleteMany({
    key: {
      $in: TEST_KEYS,
    },
  });

  await mongoose.disconnect();

  globalThis.fetch = originalFetch;
});

test("getCurrentPrice — cache miss pobiera Finnhub i zapisuje cache", async () => {
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return new Response(
      JSON.stringify({
        c: 250.5,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const price = await getCurrentPrice("AAPL");

  assert.equal(price, 250.5);
  assert.equal(fetchCalls, 1);

  const cached = await CacheEntry.findOne({
    key: "quote:AAPL",
  }).lean();

  assert.ok(cached);

  assert.equal(cached.data, 250.5);
  assert.equal(cached.type, "quote");
  assert.equal(cached.source, "finnhub");

  assert.ok(cached.fetchedAt instanceof Date);
  assert.ok(cached.expiresAt instanceof Date);

  assert.ok(cached.expiresAt > cached.fetchedAt);
});

test("getCurrentPrice — cache hit nie odpytuje Finnhub", async () => {
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return new Response(
      JSON.stringify({
        c: 999,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const price = await getCurrentPrice("AAPL");

  assert.equal(price, 250.5);

  // Najważniejsza asercja Etapu 4:
  // cena pochodzi z cache, więc Finnhub nie powinien
  // zostać ponownie wywołany.
  assert.equal(fetchCalls, 0);
});

test("getCurrentPrice — ticker jest normalizowany", async () => {
  await CacheEntry.deleteOne({
    key: "quote:MSFT",
  });

  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return new Response(
      JSON.stringify({
        c: 500,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const price = await getCurrentPrice("  msft  ");

  assert.equal(price, 500);
  assert.equal(fetchCalls, 1);

  const cached = await CacheEntry.findOne({
    key: "quote:MSFT",
  }).lean();

  assert.ok(cached);
  assert.equal(cached.data, 500);

  // Upewniamy się, że nie powstał klucz
  // zawierający małe litery lub spacje.
  const wronglyFormattedCache = await CacheEntry.findOne({
    key: "quote:  msft  ",
  }).lean();

  assert.equal(wronglyFormattedCache, null);

  await CacheEntry.deleteOne({
    key: "quote:MSFT",
  });
});

test("getCompanyNews — cache miss pobiera newsy i zapisuje cache", async () => {
  await CacheEntry.deleteOne({
    key: "news:AAPL:2026-09-01:2026-09-19",
  });

  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return new Response(
      JSON.stringify([
        {
          datetime: 1758200000,
          headline: "Test headline",
          summary: "Test summary",
          source: "Test Source",
          url: "https://example.com/test",
        },
      ]),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const news = await getCompanyNews("AAPL", "2026-09-01", "2026-09-19");

  assert.equal(fetchCalls, 1);

  assert.equal(news.length, 1);
  assert.equal(news[0].headline, "Test headline");

  const cached = await CacheEntry.findOne({
    key: "news:AAPL:2026-09-01:2026-09-19",
  }).lean();

  assert.ok(cached);

  assert.equal(cached.type, "news");
  assert.equal(cached.source, "finnhub");

  assert.deepEqual(cached.data, news);
});

test("getCompanyNews — nie pozwala na odwrócony zakres dat", async () => {
  await assert.rejects(
    () => getCompanyNews("AAPL", "2026-09-20", "2026-09-19"),
    /from nie może być późniejsze niż to/,
  );
});

test("getCurrentPrice — równoczesne cache missy współdzielą jedno żądanie Finnhub", async () => {
  await CacheEntry.deleteOne({
    key: "quote:TSLA",
  });

  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    // Sztuczne opóźnienie pozwala zasymulować sytuację,
    // w której dwa requesty przychodzą jednocześnie.
    await new Promise((resolve) => setTimeout(resolve, 50));

    return new Response(
      JSON.stringify({
        c: 300,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const [priceA, priceB] = await Promise.all([
    getCurrentPrice("TSLA"),
    getCurrentPrice("TSLA"),
  ]);

  assert.equal(priceA, 300);
  assert.equal(priceB, 300);

  // Dwa requesty aplikacji powinny spowodować
  // tylko jedno rzeczywiste żądanie do Finnhub.
  assert.equal(fetchCalls, 1);

  await CacheEntry.deleteOne({
    key: "quote:TSLA",
  });
});
