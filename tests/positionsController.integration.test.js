import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Position from "../models/Position.js";
import Action from "../models/Action.js";
import CacheEntry from "../models/CacheEntry.js";
import {
  createPosition,
  addAction,
} from "../controllers/positionsController.js";

const originalFetch = globalThis.fetch;

const MONGO_URI = process.env.MONGODB_URI;

const TEST_USER_ID = new mongoose.Types.ObjectId();

const OPEN_TICKER = "IBM";
const ADD_TICKER = "ORCL";

const OPEN_CACHE_KEY = `quote:${OPEN_TICKER}`;
const ADD_CACHE_KEY = `quote:${ADD_TICKER}`;

const TEST_ACTION_DATE = "2026-09-18T15:00:00.000Z";

const TEST_MOTIVATION = "spodziewam się wzrostu ceny";

let createdPositionId = null;

function createMockResponse() {
  return {
    statusCode: null,
    body: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(data) {
      this.body = data;
      return this;
    },
  };
}

before(async () => {
  if (!MONGO_URI) {
    throw new Error(
      "Brak MONGO_URI lub MONGODB_URI — test integracyjny wymaga połączenia z MongoDB.",
    );
  }

  await mongoose.connect(MONGO_URI);

  await Position.deleteMany({
    userId: TEST_USER_ID,
  });

  await Action.deleteMany({
    userId: TEST_USER_ID,
  });

  await CacheEntry.deleteMany({
    key: {
      $in: [OPEN_CACHE_KEY, ADD_CACHE_KEY],
    },
  });
});

after(async () => {
  await Action.deleteMany({
    userId: TEST_USER_ID,
  });

  await Position.deleteMany({
    userId: TEST_USER_ID,
  });

  await CacheEntry.deleteMany({
    key: {
      $in: [OPEN_CACHE_KEY, ADD_CACHE_KEY],
    },
  });

  globalThis.fetch = originalFetch;

  await mongoose.disconnect();
});

test("open — zapisuje executionPrice osobno od marketPriceAtDecision i korzysta z Finnhub", async () => {
  let fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls += 1;

    assert.match(String(url), /symbol=IBM/);

    return new Response(
      JSON.stringify({
        c: 201.75,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const req = {
    userId: TEST_USER_ID,
    body: {
      ticker: "  ibm  ",
      quantity: 10,

      // Cena rzeczywistego wykonania transakcji.
      executionPrice: 200.5,

      actionDate: TEST_ACTION_DATE,

      statedMotivation: TEST_MOTIVATION,

      reasoning: "Testowa decyzja inwestycyjna.",

      expectedOutcome: "Wzrost ceny w kolejnych tygodniach.",
    },
  };

  const res = createMockResponse();

  await createPosition(req, res);

  assert.equal(res.statusCode, 201);

  assert.ok(res.body);
  assert.ok(res.body.position);
  assert.ok(res.body.action);

  createdPositionId = res.body.position._id;

  /*
   * Najważniejsza rzecz:
   *
   * executionPrice pochodzi z requestu użytkownika.
   * marketPriceAtDecision pochodzi z backendu/Finnhub.
   */
  assert.equal(res.body.action.executionPrice, 200.5);

  assert.equal(res.body.action.marketPriceAtDecision, 201.75);

  /*
   * Potwierdzamy również normalizację tickera.
   */
  assert.equal(res.body.position.ticker, "IBM");

  assert.equal(res.body.position.currentQuantity, 10);

  assert.equal(res.body.action.actionType, "open");

  /*
   * Pierwsze pobranie IBM nie miało jeszcze cache,
   * dlatego Finnhub powinien zostać wywołany dokładnie raz.
   */
  assert.equal(fetchCalls, 1);

  /*
   * Sprawdzamy rzeczywisty dokument Action zapisany w MongoDB.
   */
  const savedAction = await Action.findOne({
    positionId: res.body.position._id,
    actionType: "open",
  }).lean();

  assert.ok(savedAction);

  assert.equal(savedAction.executionPrice, 200.5);

  assert.equal(savedAction.marketPriceAtDecision, 201.75);

  /*
   * Sprawdzamy również cache.
   */
  const cached = await CacheEntry.findOne({
    key: OPEN_CACHE_KEY,
  }).lean();

  assert.ok(cached);

  assert.equal(cached.data, 201.75);

  assert.equal(cached.type, "quote");

  assert.equal(cached.source, "finnhub");
});

test("add — pobiera marketPriceAtDecision przez cache i nie wykonuje drugiego fetch dla tego samego tickera", async () => {
  let fetchCalls = 0;

  /*
   * Najpierw przygotowujemy pozycję ORCL.
   *
   * Dzięki temu test add jest niezależny od testu open.
   */
  const createReq = {
    userId: TEST_USER_ID,

    body: {
      ticker: ADD_TICKER,
      quantity: 20,
      executionPrice: 100,

      actionDate: TEST_ACTION_DATE,

      statedMotivation: TEST_MOTIVATION,
    },
  };

  const createRes = createMockResponse();

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return new Response(
      JSON.stringify({
        c: 101.25,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  await createPosition(createReq, createRes);

  assert.equal(createRes.statusCode, 201);

  assert.equal(createRes.body.action.marketPriceAtDecision, 101.25);

  /*
   * OPEN wykonał jeden fetch.
   */
  assert.equal(fetchCalls, 1);

  const positionId = createRes.body.position._id;

  /*
   * Teraz wykonujemy ADD tej samej pozycji.
   *
   * Cena rynkowa 101.25 powinna zostać pobrana
   * z cache, a nie ponownie z Finnhub.
   */
  const addReq = {
    userId: TEST_USER_ID,

    params: {
      id: positionId,
    },

    body: {
      actionType: "add",
      quantity: 5,

      // Cena wykonania ADD — inna niż cena rynkowa.
      executionPrice: 102.5,

      actionDate: TEST_ACTION_DATE,

      statedMotivation: TEST_MOTIVATION,

      reasoning: "Dokupienie pozycji — test Etapu 4.",

      expectedOutcome: "Kontynuacja wzrostu.",
    },
  };

  const addRes = createMockResponse();

  await addAction(addReq, addRes);

  assert.equal(addRes.statusCode, 201);

  assert.ok(addRes.body);
  assert.ok(addRes.body.action);
  assert.ok(addRes.body.position);

  /*
   * Najważniejszy test cache:
   *
   * OPEN  → 1 fetch
   * ADD   → 0 dodatkowych fetchy
   *
   * Łącznie nadal dokładnie 1.
   */
  assert.equal(fetchCalls, 1);

  /*
   * executionPrice pochodzi z requestu ADD.
   */
  assert.equal(addRes.body.action.executionPrice, 102.5);

  /*
   * marketPriceAtDecision pochodzi z cache.
   */
  assert.equal(addRes.body.action.marketPriceAtDecision, 101.25);

  assert.equal(addRes.body.action.actionType, "add");

  /*
   * ADD zwiększył ilość:
   *
   * 20 + 5 = 25
   */
  assert.equal(addRes.body.position.currentQuantity, 25);

  /*
   * Sprawdzamy rzeczywisty dokument Action
   * zapisany w MongoDB.
   */
  const savedAddAction = await Action.findOne({
    positionId,
    actionType: "add",
  })
    .sort({ createdAt: -1 })
    .lean();

  assert.ok(savedAddAction);

  assert.equal(savedAddAction.executionPrice, 102.5);

  assert.equal(savedAddAction.marketPriceAtDecision, 101.25);

  /*
   * Cache nadal zawiera tę samą cenę.
   */
  const cached = await CacheEntry.findOne({
    key: ADD_CACHE_KEY,
  }).lean();

  assert.ok(cached);

  assert.equal(cached.data, 101.25);
});

test("open — marketPriceAtDecision nie pochodzi z req.body", async () => {
  const ticker = "INTC";
  const cacheKey = `quote:${ticker}`;

  await CacheEntry.deleteOne({
    key: cacheKey,
  });

  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return new Response(
      JSON.stringify({
        c: 55.5,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const req = {
    userId: TEST_USER_ID,

    body: {
      ticker,
      quantity: 3,

      executionPrice: 50,

      /*
       * Użytkownik próbuje przesłać własne
       * marketPriceAtDecision.
       *
       * Kontroler powinien to zignorować.
       */
      marketPriceAtDecision: 999999,

      actionDate: TEST_ACTION_DATE,

      statedMotivation: TEST_MOTIVATION,
    },
  };

  const res = createMockResponse();

  await createPosition(req, res);

  assert.equal(res.statusCode, 201);

  /*
   * Powinna zostać zapisana cena z Finnhub,
   * a nie 999999 z requestu.
   */
  assert.equal(res.body.action.marketPriceAtDecision, 55.5);

  assert.equal(res.body.action.executionPrice, 50);

  assert.equal(fetchCalls, 1);

  await Action.deleteOne({
    _id: res.body.action._id,
  });

  await Position.deleteOne({
    _id: res.body.position._id,
  });

  await CacheEntry.deleteOne({
    key: cacheKey,
  });
});
