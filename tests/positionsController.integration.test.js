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
  updateActionReasoning,
} from "../controllers/positionsController.js";

const originalFetch = globalThis.fetch;

const MONGO_URI = process.env.MONGODB_URI;

const TEST_USER_ID = new mongoose.Types.ObjectId();
// Do testów Parent-Child IDOR Guard (Etap 6) — akcja/pozycja NALEŻĄCA DO
// KOGOŚ INNEGO, żeby sprawdzić, że TEST_USER_ID nie może jej dotknąć.
const OTHER_USER_ID = new mongoose.Types.ObjectId();

const OPEN_TICKER = "IBM";
const ADD_TICKER = "ORCL";
const REASONING_TICKER = "CSCO";

// Klucze cache dla intraday zależą od dokładnego okna czasowego (wynik
// wewnętrznej matematyki intradayPriceService.js), więc zamiast trzymać
// jeden dokładny string, czyścimy po prefiksie tickera.
const PRICE_CACHE_KEY_PATTERN = new RegExp(
  `^intraday:(${OPEN_TICKER}|${ADD_TICKER}|INTC):`,
);

const TEST_ACTION_DATE = "2026-09-18T15:00:00.000Z";

const TEST_MOTIVATION = "spodziewam się wzrostu ceny";

let createdPositionId = null;

/**
 * Tworzy minimalną, poprawną parę Position+Action bezpośrednio przez
 * Mongoose — bez przechodzenia przez createPosition (a więc bez żadnego
 * zapytania o cenę rynkową).
 * Testy PATCH .../reasoning nie potrzebują pełnego flow otwarcia pozycji,
 * tylko istniejącego dokumentu Action do edycji.
 */
async function createTestPosition({
  reasoning = "",
  expectedOutcome = "",
  reasoningAddedAt = null,
  userId = TEST_USER_ID,
} = {}) {
  const position = await Position.create({
    userId,
    ticker: REASONING_TICKER,
    status: "open",
    openedAt: new Date(TEST_ACTION_DATE),
    currentQuantity: 10,
  });

  const action = await Action.create({
    positionId: position._id,
    userId,
    actionType: "open",
    quantity: 10,
    executionPrice: 100,
    actionDate: new Date(TEST_ACTION_DATE),
    tradingDateRef: new Date("2026-09-18T00:00:00.000Z"),
    statedMotivation: TEST_MOTIVATION,
    reasoning,
    expectedOutcome,
    reasoningAddedAt,
  });

  return { position, action };
}

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

/**
 * Atrapa Twelve Data (interval=1min), używana zamiast dawnego mocka
 * Finnhub (Etap 5: marketPriceAtDecision liczy się teraz z actionDate,
 * nie z chwili zapisu — patrz intradayPriceService.js).
 *
 * Zwraca DOKŁADNIE jedną świecę, ustawioną na `end_date` z zapytania —
 * czyli granicę, którą intradayPriceService.js sam wylicza jako "ostatnia
 * na pewno zamknięta minuta". Dzięki temu test nie musi duplikować
 * wewnętrznej matematyki okna (floor-to-minute, LOOKBACK_MINUTES) — po
 * prostu dostaje z powrotem świecę na granicy, jakiej by nie zapytał.
 *
 * @param {number} closePrice cena, którą ma zwrócić ta świeca
 * @param {{ tickerPattern?: RegExp, onCall?: (url: string) => void }} [options]
 */
function mockIntradayPrice(closePrice, options = {}) {
  let fetchCalls = 0;

  globalThis.fetch = async (url) => {
    fetchCalls += 1;

    const params = new URL(url).searchParams;

    if (options.tickerPattern) {
      assert.match(String(url), options.tickerPattern);
    }

    assert.equal(params.get("interval"), "1min");

    options.onCall?.(String(url));

    const endDate = params.get("end_date"); // "YYYY-MM-DDTHH:MM:SS"
    const candle = {
      datetime: endDate.replace("T", " "),
      open: String(closePrice - 0.5),
      high: String(closePrice + 0.5),
      low: String(closePrice - 1),
      close: String(closePrice),
      volume: "5000",
    };

    return new Response(
      JSON.stringify({ meta: {}, values: [candle], status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  return {
    get fetchCalls() {
      return fetchCalls;
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
    userId: { $in: [TEST_USER_ID, OTHER_USER_ID] },
  });

  await Action.deleteMany({
    userId: { $in: [TEST_USER_ID, OTHER_USER_ID] },
  });

  await CacheEntry.deleteMany({
    key: PRICE_CACHE_KEY_PATTERN,
  });
});

after(async () => {
  await Action.deleteMany({
    userId: { $in: [TEST_USER_ID, OTHER_USER_ID] },
  });

  await Position.deleteMany({
    userId: { $in: [TEST_USER_ID, OTHER_USER_ID] },
  });

  await CacheEntry.deleteMany({
    key: PRICE_CACHE_KEY_PATTERN,
  });

  globalThis.fetch = originalFetch;

  await mongoose.disconnect();
});

test("open — odrzuca actionDate bez jawnej strefy czasowej (Etap 5: naprawa niejednoznacznego actionDate)", async () => {
  // "2026-09-22T15:00" bez "Z" jest w JavaScript odczytywane jako czas
  // LOKALNY PROCESU, nie UTC — ten sam string mógłby więc dać inny
  // tradingDateRef zależnie od strefy czasowej serwera. Kontrakt wejściowy
  // musi to odrzucić, zanim dojdzie do tradingCalendar.js.
  const req = {
    userId: TEST_USER_ID,
    body: {
      ticker: OPEN_TICKER,
      quantity: 10,
      executionPrice: 200.5,
      actionDate: "2026-09-22T15:00", // brak "Z" / offsetu — celowo niepoprawne
      statedMotivation: TEST_MOTIVATION,
    },
  };

  const res = createMockResponse();

  await assert.rejects(
    () => createPosition(req, res),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /jawną strefą czasową/);
      return true;
    },
  );

  // Walidacja rzuca PRZED jakimkolwiek zapisem do bazy — więc nie powinien
  // powstać żaden dokument.
  const created = await Position.findOne({
    userId: TEST_USER_ID,
    ticker: OPEN_TICKER,
  }).lean();

  assert.equal(created, null);
});

test("open — odrzuca actionDate z przyszłości (dziennik rejestruje decyzje, które już zapadły)", async () => {
  const jutro = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const req = {
    userId: TEST_USER_ID,
    body: {
      ticker: OPEN_TICKER,
      quantity: 10,
      executionPrice: 200.5,
      actionDate: jutro,
      statedMotivation: TEST_MOTIVATION,
    },
  };

  const res = createMockResponse();

  await assert.rejects(
    () => createPosition(req, res),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /nie może wskazywać przyszłości/);
      return true;
    },
  );

  const created = await Position.findOne({
    userId: TEST_USER_ID,
    ticker: OPEN_TICKER,
  }).lean();

  assert.equal(created, null);
});

test("open — akceptuje actionDate kilka sekund w przyszłości (tolerancja na rozjechany zegar klienta)", async () => {
  let fetchCalls = 0;

  // actionDate tutaj to "prawie teraz" w chwili URUCHOMIENIA testu — może
  // wypaść w trakcie sesji albo poza nią, zależnie od pory dnia. Ten test
  // sprawdza tolerancję na rozjazd zegara, nie semantykę ceny, więc mock
  // obsługuje oba możliwe zapytania (1min i 1day) tym samym, poprawnym
  // kształtem odpowiedzi.
  globalThis.fetch = async (url) => {
    fetchCalls += 1;

    const params = new URL(url).searchParams;
    const interval = params.get("interval");
    const endDate = params.get("end_date");

    const candle =
      interval === "1min"
        ? {
            datetime: endDate.replace("T", " "),
            open: "199.5",
            high: "200.5",
            low: "199",
            close: "200",
            volume: "5000",
          }
        : {
            datetime: endDate,
            open: "199",
            high: "201",
            low: "198",
            close: "200",
            volume: "5000000",
          };

    return new Response(
      JSON.stringify({ meta: {}, values: [candle], status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  // 30 sekund w przyszłości — dużo mniej niż tolerancja 5 minut, symuluje
  // zwykłe niedopasowanie zegara klienta, nie prawdziwą przyszłą datę.
  const prawieTeraz = new Date(Date.now() + 30 * 1000).toISOString();

  const req = {
    userId: TEST_USER_ID,
    body: {
      ticker: OPEN_TICKER,
      quantity: 3,
      executionPrice: 199,
      actionDate: prawieTeraz,
      statedMotivation: TEST_MOTIVATION,
    },
  };

  const res = createMockResponse();

  await createPosition(req, res);

  assert.equal(res.statusCode, 201);

  await Position.deleteOne({ _id: res.body.position._id });
  await Action.deleteOne({ _id: res.body.action._id });
  await CacheEntry.deleteMany({ key: PRICE_CACHE_KEY_PATTERN });

  globalThis.fetch = originalFetch;
});

test('open — akceptuje actionDate z jawnym offsetem (nie tylko z "Z")', async () => {
  mockIntradayPrice(200, { tickerPattern: /symbol=IBM/ });

  const req = {
    userId: TEST_USER_ID,
    body: {
      ticker: OPEN_TICKER,
      quantity: 5,
      executionPrice: 199.9,
      actionDate: "2026-09-18T17:00:00+02:00", // to samo co 15:00:00Z
      statedMotivation: TEST_MOTIVATION,
    },
  };

  const res = createMockResponse();

  await createPosition(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(
    new Date(res.body.action.actionDate).toISOString(),
    "2026-09-18T15:00:00.000Z",
  );

  // Sprzątanie — ta pozycja nie jest częścią sekwencji pozostałych testów.
  // WAŻNE: czyścimy też cache ceny — inaczej kolejny test ("open —
  // zapisuje executionPrice...") mógłby dostać z cache'u cenę zapisaną
  // przez TEN test (200) zamiast wywołać własny mock (201.75), bo między
  // testami w tym pliku nie ma osobnego czyszczenia cache'u (tylko raz,
  // w after() na końcu całego pliku).
  await Position.deleteOne({ _id: res.body.position._id });
  await Action.deleteOne({ _id: res.body.action._id });
  await CacheEntry.deleteMany({ key: PRICE_CACHE_KEY_PATTERN });

  globalThis.fetch = originalFetch;
});

test("open — zapisuje executionPrice osobno od marketPriceAtDecision i korzysta z Twelve Data intraday", async () => {
  const mock = mockIntradayPrice(201.75, { tickerPattern: /symbol=IBM/ });

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
   * marketPriceAtDecision pochodzi z Twelve Data, dla actionDate
   * (nie z chwili zapisu).
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
   * dlatego Twelve Data powinno zostać wywołane dokładnie raz.
   */
  assert.equal(mock.fetchCalls, 1);

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
   * Sprawdzamy również cache. Zawężone do IBM (nie PRICE_CACHE_KEY_PATTERN,
   * który pasuje też do ORCL/INTC) — inaczej wynik zależałby od kolejności
   * wykonania testów, nie od samej poprawności kodu.
   */
  const cached = await CacheEntry.findOne({
    key: new RegExp(`^intraday:${OPEN_TICKER}:`),
  }).lean();

  assert.ok(cached);

  assert.equal(cached.data.at(-1).close, 201.75);

  assert.equal(cached.type, "price_intraday");

  assert.equal(cached.source, "twelve_data");
});

test("add — pobiera marketPriceAtDecision przez cache i nie wykonuje drugiego fetch dla tego samego tickera", async () => {
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

  const mock = mockIntradayPrice(101.25, { tickerPattern: /symbol=ORCL/ });

  await createPosition(createReq, createRes);

  assert.equal(createRes.statusCode, 201);

  assert.equal(createRes.body.action.marketPriceAtDecision, 101.25);

  /*
   * OPEN wykonał jeden fetch.
   */
  assert.equal(mock.fetchCalls, 1);

  const positionId = createRes.body.position._id;

  /*
   * Teraz wykonujemy ADD tej samej pozycji, z TYM SAMYM actionDate —
   * więc trafia w dokładnie ten sam klucz cache co OPEN.
   *
   * Cena rynkowa 101.25 powinna zostać pobrana
   * z cache, a nie ponownie z Twelve Data.
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
  assert.equal(mock.fetchCalls, 1);

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
   *
   * WAŻNE: pytamy tu WYŁĄCZNIE o klucz ORCL, nie o PRICE_CACHE_KEY_PATTERN
   * (który celowo pasuje też do IBM/INTC — służy do sprzątania, nie do
   * precyzyjnych odczytów). Wcześniejszy test w tym pliku zostawia w bazie
   * wpis cache dla IBM; `findOne` bez zawężenia do ORCL i bez sortowania
   * mógłby zwrócić TEN wpis zamiast właściwego — dokładnie to się stało
   * (dostawaliśmy 201.75 z IBM zamiast 101.25 z ORCL).
   */
  const cached = await CacheEntry.findOne({
    key: new RegExp(`^intraday:${ADD_TICKER}:`),
  }).lean();

  assert.ok(cached);

  assert.equal(cached.data.at(-1).close, 101.25);
});

test("open — marketPriceAtDecision nie pochodzi z req.body", async () => {
  const ticker = "INTC";

  await CacheEntry.deleteMany({ key: PRICE_CACHE_KEY_PATTERN });

  const mock = mockIntradayPrice(55.5, { tickerPattern: /symbol=INTC/ });

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
   * Powinna zostać zapisana cena z Twelve Data,
   * a nie 999999 z requestu.
   */
  assert.equal(res.body.action.marketPriceAtDecision, 55.5);

  assert.equal(res.body.action.executionPrice, 50);

  assert.equal(mock.fetchCalls, 1);

  await Action.deleteOne({
    _id: res.body.action._id,
  });

  await Position.deleteOne({
    _id: res.body.position._id,
  });

  await CacheEntry.deleteMany({ key: PRICE_CACHE_KEY_PATTERN });
});

/* ------------------------------------------------------------------ *
 * PATCH /api/positions/:id/actions/:actionId/reasoning — Etap 6
 *
 * updateActionReasoning + Parent-Child IDOR Guard (sekcja 8.5 planu v7).
 * ------------------------------------------------------------------ */

test("PATCH .../reasoning — aktualizuje reasoning i ustawia reasoningAddedAt", async () => {
  const { position, action } = await createTestPosition();

  const req = {
    userId: TEST_USER_ID,
    params: { id: String(position._id), actionId: String(action._id) },
    body: { reasoning: "Kupiłem po dobrym raporcie kwartalnym." },
  };
  const res = createMockResponse();

  await updateActionReasoning(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reasoning, "Kupiłem po dobrym raporcie kwartalnym.");
  assert.ok(res.body.reasoningAddedAt);

  const fromDb = await Action.findById(action._id).lean();

  assert.equal(fromDb.reasoning, "Kupiłem po dobrym raporcie kwartalnym.");
  assert.ok(fromDb.reasoningAddedAt);
});

test("PATCH .../reasoning — aktualizuje TYLKO expectedOutcome, reasoning zostaje bez zmian", async () => {
  const { position, action } = await createTestPosition({
    reasoning: "stary powód",
  });

  const req = {
    userId: TEST_USER_ID,
    params: { id: String(position._id), actionId: String(action._id) },
    body: { expectedOutcome: "Oczekuję wzrostu o 10% w ciągu kwartału." },
  };
  const res = createMockResponse();

  await updateActionReasoning(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reasoning, "stary powód"); // niezmienione
  assert.equal(
    res.body.expectedOutcome,
    "Oczekuję wzrostu o 10% w ciągu kwartału.",
  );
});

test("PATCH .../reasoning — odrzuca puste ciało żądania (brak reasoning i expectedOutcome)", async () => {
  const { position, action } = await createTestPosition();

  const req = {
    userId: TEST_USER_ID,
    params: { id: String(position._id), actionId: String(action._id) },
    body: {},
  };
  const res = createMockResponse();

  await assert.rejects(
    () => updateActionReasoning(req, res),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("PATCH .../reasoning — odrzuca reasoning niebędące tekstem", async () => {
  const { position, action } = await createTestPosition();

  const req = {
    userId: TEST_USER_ID,
    params: { id: String(position._id), actionId: String(action._id) },
    body: { reasoning: 12345 },
  };
  const res = createMockResponse();

  await assert.rejects(
    () => updateActionReasoning(req, res),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("PATCH .../reasoning — Parent-Child IDOR Guard: actionId z INNEJ WŁASNEJ pozycji zostaje odrzucony", async () => {
  // To jest dokładnie scenariusz z sekcji 8.5 planu: dwie pozycje NALEŻĄ
  // do tego samego usera, ale actionId musi zgadzać się z KONKRETNYM
  // positionId z URL — nie wystarczy, że obie "są moje".
  const pozycjaA = await createTestPosition({ reasoning: "A" });
  const pozycjaB = await createTestPosition({ reasoning: "B" });

  const req = {
    userId: TEST_USER_ID,
    params: {
      id: String(pozycjaA.position._id), // URL wskazuje na A...
      actionId: String(pozycjaB.action._id), // ...ale akcja należy do B
    },
    body: { reasoning: "próba podmiany" },
  };
  const res = createMockResponse();

  await assert.rejects(
    () => updateActionReasoning(req, res),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /w kontekście tej pozycji/);
      return true;
    },
  );

  // Akcja B musi zostać kompletnie nietknięta.
  const wciazB = await Action.findById(pozycjaB.action._id).lean();

  assert.equal(wciazB.reasoning, "B");
});

test("PATCH .../reasoning — akcja innego użytkownika zwraca 404, nie 403 (nie zdradza istnienia)", async () => {
  const { position, action } = await createTestPosition({
    userId: OTHER_USER_ID,
    reasoning: "cudza notatka",
  });

  const req = {
    userId: TEST_USER_ID, // NIE właściciel
    params: { id: String(position._id), actionId: String(action._id) },
    body: { reasoning: "próba nieautoryzowanej edycji" },
  };
  const res = createMockResponse();

  await assert.rejects(
    () => updateActionReasoning(req, res),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    },
  );

  const wciazNietknieta = await Action.findById(action._id).lean();

  assert.equal(wciazNietknieta.reasoning, "cudza notatka");
});

test("PATCH .../reasoning — nieistniejący actionId zwraca 404", async () => {
  const { position } = await createTestPosition();
  const bogusActionId = new mongoose.Types.ObjectId();

  const req = {
    userId: TEST_USER_ID,
    params: { id: String(position._id), actionId: String(bogusActionId) },
    body: { reasoning: "cokolwiek" },
  };
  const res = createMockResponse();

  await assert.rejects(
    () => updateActionReasoning(req, res),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("PATCH .../reasoning — czyszczenie na pusty string nadal aktualizuje reasoningAddedAt", async () => {
  const staraData = new Date("2020-01-01T00:00:00.000Z");
  const { position, action } = await createTestPosition({
    reasoning: "coś",
    reasoningAddedAt: staraData,
  });

  const req = {
    userId: TEST_USER_ID,
    params: { id: String(position._id), actionId: String(action._id) },
    body: { reasoning: "" },
  };
  const res = createMockResponse();

  await updateActionReasoning(req, res);

  assert.equal(res.body.reasoning, "");
  assert.ok(
    new Date(res.body.reasoningAddedAt).getTime() > staraData.getTime(),
  );
});
