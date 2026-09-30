import "dotenv/config";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import CacheEntry from "../models/CacheEntry.js";
import {
  getDailyHistory,
  getMarketContext,
} from "../services/historyPriceService.js";
import { latestCompletedTradingDate } from "../utils/tradingCalendar.js";

/**
 * Test integracyjny Etapu 5 — wymaga MONGODB_URI w .env (tak samo jak
 * currentPriceService.integration.test.js). Twelve Data jest podmieniane
 * atrapą globalThis.fetch, więc test nie zużywa ani jednego kredytu API.
 *
 * Najważniejsze pytanie, na które ten plik odpowiada: czy jedna pozycja
 * naprawdę kosztuje jedno zapytanie dziennie, niezależnie od tego, ile ma
 * akcji.
 */

const originalFetch = globalThis.fetch;

const MONGO_URI = process.env.MONGODB_URI;

// Klucz jest czytany przed wysłaniem zapytania, więc musi istnieć —
// ale ponieważ fetch i tak jest podmieniony, jego wartość nie ma znaczenia.
const originalApiKey = process.env.TWELVE_DATA_API_KEY;

const BARS = [
  {
    datetime: "2026-09-14",
    open: "245",
    high: "248",
    low: "244",
    close: "247",
    volume: "40000000",
  },
  {
    datetime: "2026-09-15",
    open: "247",
    high: "250",
    low: "246",
    close: "249",
    volume: "41000000",
  },
  {
    datetime: "2026-09-16",
    open: "249",
    high: "251",
    low: "248",
    close: "250",
    volume: "39000000",
  },
  {
    datetime: "2026-09-17",
    open: "250",
    high: "253",
    low: "249",
    close: "252",
    volume: "43000000",
  },
  {
    datetime: "2026-09-18",
    open: "252",
    high: "255",
    low: "251",
    close: "254",
    volume: "48000000",
  },
];

let fetchCalls = 0;

function mockTwelveData(payload) {
  fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls += 1;

    if (payload) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Domyślnie: zachowuj się jak prawdziwe Twelve Data i zwracaj tylko
    // świece W OBRĘBIE żądanego start_date/end_date. Atrapa, która zawsze
    // zwraca wszystkie 5 świec bez względu na zapytany zakres, maskowałaby
    // dokładnie ten rodzaj błędu, który testujemy niżej (czy dzisiejszy
    // dzień naprawdę nie trafia do zapytania przed zamknięciem sesji).
    const params = new URL(url).searchParams;
    const startDate = params.get("start_date");
    const endDate = params.get("end_date");
    const values = BARS.filter(
      (bar) => bar.datetime >= startDate && bar.datetime <= endDate,
    );

    return new Response(
      JSON.stringify({ meta: {}, values: [...values].reverse(), status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

async function clearHistoryCache() {
  await CacheEntry.deleteMany({ key: { $regex: "^history:(AAPL|MSFT):" } });
}

before(async () => {
  if (!MONGO_URI) {
    throw new Error(
      "Brak MONGODB_URI — test integracyjny wymaga połączenia z MongoDB.",
    );
  }

  process.env.TWELVE_DATA_API_KEY = originalApiKey || "test-key";

  await mongoose.connect(MONGO_URI);
  await clearHistoryCache();
});

beforeEach(() => {
  mockTwelveData();
});

after(async () => {
  await clearHistoryCache();
  await mongoose.disconnect();

  globalThis.fetch = originalFetch;

  if (originalApiKey === undefined) {
    delete process.env.TWELVE_DATA_API_KEY;
  } else {
    process.env.TWELVE_DATA_API_KEY = originalApiKey;
  }
});

test("getDailyHistory — cache miss pobiera Twelve Data i zapisuje wynik", async () => {
  const bars = await getDailyHistory("aapl", {
    startDate: "2026-09-14",
    endDate: "2026-09-18",
  });

  assert.equal(fetchCalls, 1);
  assert.equal(bars.length, 5);
  assert.equal(bars[0].date, "2026-09-14");
  assert.equal(bars[4].close, 254);

  const cached = await CacheEntry.findOne({
    key: "history:AAPL:1day:2026-09-14:2026-09-18",
  }).lean();

  assert.ok(cached, "wpis cache powinien istnieć");
  assert.equal(cached.type, "price_history");
  assert.equal(cached.source, "twelve_data");
  assert.ok(cached.expiresAt > cached.fetchedAt);
});

test("getDailyHistory — cache hit nie odpytuje Twelve Data", async () => {
  const bars = await getDailyHistory("AAPL", {
    startDate: "2026-09-14",
    endDate: "2026-09-18",
  });

  assert.equal(fetchCalls, 0);
  assert.equal(bars.length, 5);
});

test("getDailyHistory — odwrócona kolejność dat jest odrzucana", async () => {
  await assert.rejects(
    () =>
      getDailyHistory("AAPL", {
        startDate: "2026-09-18",
        endDate: "2026-09-14",
      }),
    /startDate nie może być późniejsze niż endDate/,
  );
});

test("getDailyHistory — bez jawnego endDate, w trakcie sesji, nie pobiera dzisiejszego dnia (P1: ten sam kontrakt co getMarketContext)", async () => {
  // To jest dokładnie luka, przed którą ostrzegał recenzent:
  // getMarketContext było już naprawione, ale getDailyHistorySnapshot miało
  // OSOBNY, słabszy domyślny endDate (latestTradingDate — "sesja już
  // otwarta", nie "już zamknięta"). Ktoś wołający getDailyHistory(ticker)
  // bezpośrednio, bez przechodzenia przez getMarketContext (np. w
  // przyszłym Etapie 8 czy w statystykach z Etapu 9), mógłby po cichu
  // wprowadzić z powrotem ten sam błąd cache + niepełna świeca, inną
  // ścieżką. Ten test pilnuje, żeby default sam w sobie był bezpieczny.
  await clearHistoryCache();

  const bars = await getDailyHistory("AAPL", {
    now: new Date("2026-09-18T17:00:00Z"), // 13:00 ET, sesja w toku
  });

  assert.ok(
    !bars.some((bar) => bar.date === "2026-09-18"),
    "domyślny endDate nie powinien nigdy obejmować dzisiejszej, niedomkniętej sesji",
  );
  assert.deepEqual(
    bars.map((bar) => bar.date),
    ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
  );
});

test("getMarketContext — dwie akcje tej samej pozycji = jedno zapytanie do API", async () => {
  await clearHistoryCache();

  const now = new Date("2026-09-18T20:30:00Z"); // po zamknięciu sesji
  const since = "2026-09-14T14:00:00Z";

  // Quick-check pierwszej akcji: dane wyłącznie do 16 września.
  const pierwsza = await getMarketContext("AAPL", {
    since,
    upTo: "2026-09-16",
    now,
  });

  // Quick-check późniejszej akcji: ten sam ticker, inny dzień odniesienia.
  const druga = await getMarketContext("AAPL", {
    since,
    upTo: "2026-09-18",
    now,
  });

  // Sedno Etapu 5: okno zależy od pozycji i od dnia, nie od akcji,
  // więc druga akcja korzysta z tego samego wpisu cache.
  assert.equal(fetchCalls, 1);

  assert.equal(pierwsza.fromCache, false);
  assert.equal(druga.fromCache, true);

  assert.deepEqual(
    pierwsza.bars.map((bar) => bar.date),
    ["2026-09-14", "2026-09-15", "2026-09-16"],
  );

  assert.equal(druga.bars.length, 5);
  assert.equal(druga.window.endDate, "2026-09-18");
});

test("getMarketContext — bez upTo zwraca całą historię (analiza końcowa)", async () => {
  const context = await getMarketContext("AAPL", {
    since: "2026-09-14T14:00:00Z",
    now: new Date("2026-09-18T20:30:00Z"),
  });

  assert.equal(context.upTo, null);
  assert.equal(context.bars.length, 5);
  assert.equal(context.fromCache, true);
});

test("getMarketContext — w trakcie trwania sesji dzisiejszy dzień w ogóle nie wchodzi do okna", async () => {
  // Wcześniej: dzisiejsza świeca wchodziła do okna z flagą `isPartial:
  // true`. Teraz: w ogóle nie jest pobierana, dopóki sesja się nie
  // zamknie — patrz duży komentarz przy getMarketContext.
  await clearHistoryCache();

  const context = await getMarketContext("AAPL", {
    since: "2026-09-14T14:00:00Z",
    now: new Date("2026-09-18T17:00:00Z"), // 13:00 ET, sesja w toku
  });

  assert.equal(context.window.endDate, "2026-09-17");
  assert.deepEqual(
    context.bars.map((bar) => bar.date),
    ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"],
  );
});

test("getMarketContext — sesja w toku i sesja po zamknięciu trafiają w RÓŻNE klucze cache (naprawa: partial candle + 12h TTL price_history)", async () => {
  // To jest dokładnie scenariusz, który wcześniej psuł isPartial: świeca
  // pobrana o 15:00 (close = cena z 15:00) trafiała do CacheEntry; wpis o
  // 17:00 (po zamknięciu) dostawał z cache'u TEN SAM, już nieaktualny
  // rekord, a flaga liczona na nowo względem `now` wychodziła `false` —
  // AI dostawałoby świecę wyglądającą na kompletną, której close w
  // rzeczywistości był sprzed dwóch godzin.
  //
  // Naprawa: fetchEndDate przed zamknięciem to wczoraj, po zamknięciu —
  // dziś. To DWA RÓŻNE klucze cache, więc drugie zapytanie fizycznie nie
  // może dostać z cache'u danych zapisanych pod pierwszym kluczem —
  // musi polecieć świeże zapytanie po naprawdę kompletną świecę.
  await clearHistoryCache();

  const since = "2026-09-14T14:00:00Z";

  const wTrakcie = await getMarketContext("AAPL", {
    since,
    now: new Date("2026-09-18T19:00:00Z"), // 15:00 ET, sesja w toku
  });

  assert.equal(fetchCalls, 1);
  assert.equal(wTrakcie.window.endDate, "2026-09-17");
  assert.ok(
    !wTrakcie.bars.some((bar) => bar.date === "2026-09-18"),
    "dzisiejszy dzień nie powinien w ogóle zostać pobrany",
  );

  const poZamknieciu = await getMarketContext("AAPL", {
    since,
    now: new Date("2026-09-18T21:00:00Z"), // 17:00 ET, po zamknięciu
  });

  assert.equal(
    fetchCalls,
    2,
    "drugie zapytanie musi być NOWYM fetchem, nie cache hitem z pierwszego",
  );
  assert.equal(poZamknieciu.fromCache, false);
  assert.equal(poZamknieciu.window.endDate, "2026-09-18");
  assert.ok(poZamknieciu.bars.some((bar) => bar.date === "2026-09-18"));
});

test("getMarketContext — quick-check z latestCompletedTradingDate nie przecieka mimo powtórzenia po zamknięciu", async () => {
  await clearHistoryCache();

  // Decyzja: wtorek 15.09.2026, 11:00 ET (15:00 UTC) — sesja dopiero trwa.
  const actionDate = "2026-09-15T15:00:00Z";
  const upTo = latestCompletedTradingDate(actionDate); // "2026-09-14", nie "2026-09-15"

  assert.equal(upTo, "2026-09-14");

  // Pierwsza próba: quick-check tuż po decyzji.
  const zaraz = await getMarketContext("AAPL", {
    since: "2026-09-11T14:00:00Z",
    upTo,
    now: new Date("2026-09-15T15:05:00Z"),
  });

  // Druga próba: ten sam quick-check powtórzony PO zamknięciu wtorkowej
  // sesji — gdyby `upTo` liczyło się z `tradingDateRef` (otwarcie, nie
  // zamknięcie), ta wersja dostałaby już ostateczny kurs zamknięcia
  // wtorku, którego o 11:00 nikt nie znał.
  const wieczorem = await getMarketContext("AAPL", {
    since: "2026-09-11T14:00:00Z",
    upTo,
    now: new Date("2026-09-15T21:30:00Z"),
  });

  const ostatniaZaraz = zaraz.bars.at(-1);
  const ostatniaWieczorem = wieczorem.bars.at(-1);

  // Sedno testu: obie odpowiedzi kończą się na tej samej, poniedziałkowej
  // świecy — wtorek jest nieobecny w OBU, niezależnie od pory powtórzenia.
  assert.equal(ostatniaZaraz.date, "2026-09-14");
  assert.equal(ostatniaWieczorem.date, "2026-09-14");
  assert.deepEqual(
    zaraz.bars.map((bar) => bar.date),
    wieczorem.bars.map((bar) => bar.date),
  );
});

test("błąd Twelve Data nie trafia do cache", async () => {
  mockTwelveData({
    code: 404,
    message: "**symbol** not found",
    status: "error",
  });

  await assert.rejects(
    () =>
      getDailyHistory("MSFT", {
        startDate: "2026-09-14",
        endDate: "2026-09-18",
      }),
    /Błąd Twelve Data dla MSFT/,
  );

  const cached = await CacheEntry.findOne({
    key: "history:MSFT:1day:2026-09-14:2026-09-18",
  }).lean();

  assert.equal(cached, null, "nieudane pobranie nie może zostać zapamiętane");
});
