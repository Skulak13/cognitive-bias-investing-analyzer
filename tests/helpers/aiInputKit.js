/**
 * Wspólne środowisko testów Etapu 8.7 (dane wejściowe, migawka, prompt).
 * Bez bazy i bez sieci: modele są atrapami w pamięci (ta sama atrapa kolekcji
 * co w testach 8.6), a usługi rynkowe — funkcjami podstawianymi do buildera.
 */
import mongoose from "mongoose";
import { createFakePositionModel } from "./positionHarness.js";
import { filterBarsUpTo } from "../../services/historyPriceService.js";
import {
  isTradingDay,
  latestCompletedTradingDate,
} from "../../utils/tradingCalendar.js";
import { createAiInputBuilder } from "../../services/aiInputBuilder.js";

const oid = () => new mongoose.Types.ObjectId();

export const IDS = Object.freeze({
  userA: oid(),
  userB: oid(),
  position: oid(),
  otherPosition: oid(),
  action1: oid(),
  action2: oid(),
  action3: oid(),
});

export const TEXT = Object.freeze({
  r1: "UZASADNIENIE-1: wchodzę, bo spółka wybiła się z konsolidacji.",
  e1: "OCZEKIWANIE-1: wzrost o 10%.",
  r2: "UZASADNIENIE-2: dokupuję po spadku.",
  r3: "UZASADNIENIE-3: zamykam, bo osiągnąłem cel.",
});

/** Dzienne świece od 2026-10-01 do 2026-10-30 (tylko dni sesyjne). */
export function makeBars() {
  const bars = [];
  let price = 100;

  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;

    if (!isTradingDay(date)) continue;

    price += 1;
    bars.push({
      date,
      open: price,
      high: price + 2,
      low: price - 2,
      close: price + 1,
      volume: 1000 + day,
    });
  }

  return bars;
}

/** Atrapa `getMarketContext` o tym samym kształcie wyniku co prawdziwa. */
export function makeMarketContext({ bars = makeBars(), calls = [] } = {}) {
  return async (ticker, options = {}) => {
    calls.push({ ticker, ...options });

    const now = options.now ?? new Date();
    const endDate = latestCompletedTradingDate(now);
    const startDate = "2026-10-01";
    const windowBars = bars.filter(
      (b) => b.date >= startDate && b.date <= endDate,
    );

    return {
      ticker,
      interval: "1day",
      source: "twelve_data",
      window: { startDate, endDate },
      upTo: options.upTo ?? null,
      bars: options.upTo
        ? filterBarsUpTo(windowBars, options.upTo)
        : windowBars,
      fetchedAt: new Date("2026-10-21T12:00:00.000Z"),
      expiresAt: new Date("2026-10-22T00:00:00.000Z"),
      fromCache: false,
    };
  };
}

export const seconds = (iso) => Date.parse(iso) / 1000;

export function makeFixture({
  bars,
  news = [],
  now = new Date("2026-10-21T21:00:00.000Z"),
  newsError = null,
  marketError = null,
  logs = [],
} = {}) {
  const positions = createFakePositionModel();
  const actions = createFakePositionModel();
  const marketCalls = [];
  const newsCalls = [];

  positions._docs.push(
    {
      _id: IDS.position,
      userId: IDS.userA,
      ticker: "AAPL",
      status: "closed",
      openedAt: new Date("2026-10-13T14:00:00.000Z"),
      closedAt: new Date("2026-10-19T16:00:00.000Z"),
      currentQuantity: 0,
      deletedAt: null,
    },
    {
      _id: IDS.otherPosition,
      userId: IDS.userB,
      ticker: "MSFT",
      status: "open",
      openedAt: new Date("2026-10-13T14:00:00.000Z"),
      closedAt: null,
      currentQuantity: 1,
      deletedAt: null,
    },
  );

  const base = (overrides) => ({
    positionId: IDS.position,
    userId: IDS.userA,
    statedMotivation: "technical",
    earlyAiCheck: {
      summary: "WCZESNA-ANALIZA-NIE-DLA-MODELU",
      analyzedAt: new Date(),
    },
    ...overrides,
  });

  // Celowo wstawione w złej kolejności (3, 1, 2) — builder ma posortować.
  actions._docs.push(
    base({
      _id: IDS.action3,
      actionType: "close",
      quantity: 20,
      executionPrice: 112,
      marketPriceAtDecision: 111.5,
      actionDate: new Date("2026-10-19T16:00:00.000Z"),
      tradingDateRef: new Date("2026-10-19T00:00:00.000Z"),
      reasoning: TEXT.r3,
      reasoningAddedAt: new Date("2026-10-19T16:05:00.000Z"),
      createdAt: new Date("2026-10-19T16:00:01.000Z"),
    }),
    base({
      _id: IDS.action1,
      actionType: "open",
      quantity: 10,
      executionPrice: 100,
      marketPriceAtDecision: 100.2,
      actionDate: new Date("2026-10-13T14:00:00.000Z"),
      tradingDateRef: new Date("2026-10-13T00:00:00.000Z"),
      reasoning: TEXT.r1,
      reasoningAddedAt: new Date("2026-10-13T14:01:00.000Z"),
      expectedOutcome: TEXT.e1,
      createdAt: new Date("2026-10-13T14:00:01.000Z"),
    }),
    base({
      _id: IDS.action2,
      actionType: "add",
      quantity: 10,
      executionPrice: 98,
      marketPriceAtDecision: 98.4,
      actionDate: new Date("2026-10-15T15:30:00.000Z"),
      tradingDateRef: new Date("2026-10-15T00:00:00.000Z"),
      reasoning: TEXT.r2,
      reasoningAddedAt: new Date("2026-10-15T15:31:00.000Z"),
      createdAt: new Date("2026-10-15T15:30:01.000Z"),
    }),
    // akcja z tej samej pozycji, ale należąca do INNEGO użytkownika (dane
    // sprzeczne z inwariantem) — Parent-Child Guard {positionId, userId} ma ją odciąć
    {
      _id: oid(),
      positionId: IDS.position,
      userId: IDS.userB,
      actionType: "add",
      quantity: 1,
      executionPrice: 1,
      actionDate: new Date("2026-10-14T15:00:00.000Z"),
      tradingDateRef: new Date("2026-10-14T00:00:00.000Z"),
      statedMotivation: "technical",
      reasoning: "OBCY-UZYTKOWNIK-W-TEJ-POZYCJI",
    },
    // akcja cudzej pozycji innego użytkownika — nigdy nie może trafić do wejścia
    {
      _id: oid(),
      positionId: IDS.otherPosition,
      userId: IDS.userB,
      actionType: "open",
      quantity: 1,
      executionPrice: 300,
      actionDate: new Date("2026-10-13T14:00:00.000Z"),
      tradingDateRef: new Date("2026-10-13T00:00:00.000Z"),
      statedMotivation: "technical",
      reasoning: "CUDZE-UZASADNIENIE",
    },
  );

  const clock = { now };

  const builder = createAiInputBuilder({
    PositionModel: positions,
    ActionModel: actions,
    getMarketContext: marketError
      ? async () => {
          throw marketError;
        }
      : makeMarketContext({ bars, calls: marketCalls }),
    getCompanyNews: async (ticker, from, to) => {
      newsCalls.push({ ticker, from, to });

      if (newsError) throw newsError;

      return news;
    },
    now: () => clock.now,
    log: (event, fields) => logs.push({ event, ...fields }),
  });

  return { builder, positions, actions, marketCalls, newsCalls, logs, clock };
}

/** Wszystkie klucze obiektu (rekurencyjnie, także w tablicach). */
export function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      collectKeys(inner, keys);
    }
  }

  return keys;
}
