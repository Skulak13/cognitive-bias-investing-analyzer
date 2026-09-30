import { getOrSet, keys } from "./cacheService.js";
import {
  formatDateOnly,
  latestCompletedTradingDate,
  shiftTradingDays,
  toTradingDateString,
} from "../utils/tradingCalendar.js";

/**
 * historyPriceService.js — Etap 5.
 *
 * Dzienna historia notowań (OHLCV) z Twelve Data, zawsze przez cacheService.
 *
 * Podział ról, taki sam jak w currentPriceService:
 *   - funkcje `fetch*` rozmawiają z dostawcą i nic nie wiedzą o cache,
 *   - cacheService.getOrSet odpowiada za cache i za deduplikację
 *     równoczesnych zapytań o ten sam klucz.
 *
 * Darmowy plan Twelve Data to 800 kredytów dziennie i 8 zapytań na minutę,
 * a jedno zapytanie o serię czasową = 1 kredyt. Dlatego okno danych jest
 * budowane tak, żeby WSZYSTKIE akcje jednej pozycji w ciągu doby trafiały
 * w ten sam klucz cache (szczegóły przy getMarketContext) — jedna pozycja
 * to wtedy jedno zapytanie dziennie, a nie jedno na akcję.
 */

const TWELVE_DATA_URL = "https://api.twelvedata.com/time_series";
const HISTORY_TIMEOUT_MS = 10000;
const DAILY_INTERVAL = "1day";

/**
 * Ile sesji wstecz pobierać, gdy nie wiadomo, od kiedy liczyć historię.
 * ~120 sesji to mniej więcej pół roku notowań.
 */
export const DEFAULT_LOOKBACK_SESSIONS = 120;

/**
 * Ile sesji PRZED otwarciem pozycji dołożyć do okna.
 *
 * Bez tego bufora AI widziałaby wykres zaczynający się dokładnie w dniu
 * zakupu i nie miałaby jak ocenić, czy użytkownik kupował po spadku, czy
 * w środku rajdu — a to jest dokładnie ten kontekst, który odróżnia
 * hipotezę o pogoni za wzrostami od zwykłego zakupu.
 */
export const DEFAULT_CONTEXT_BUFFER_SESSIONS = 10;

/**
 * Klucz API czytamy dopiero w momencie realnego zapytania — tak samo jak
 * w currentPriceService — żeby moduł nie zależał od kolejności importów
 * i wcześniejszego wykonania dotenv.
 */
export function getTwelveDataApiKey() {
  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Brak TWELVE_DATA_API_KEY w pliku .env");
  }

  return apiKey;
}

function normalizeTicker(ticker) {
  if (typeof ticker !== "string" || !ticker.trim()) {
    throw new Error("Ticker jest wymagany");
  }

  return ticker.trim().toUpperCase();
}

/**
 * Zamienia tekst na liczbę albo null.
 *
 * Twelve Data zwraca liczby jako stringi ("250.50"), a wolumen potrafi
 * być pusty dla niektórych instrumentów. Nie podstawiamy zera — zero to
 * konkretna informacja ("nie było obrotu"), a brak danych to brak danych.
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sprawdza odpowiedź Twelve Data i przerabia ją na naszą postać.
 *
 * Wydzielone jako osobna, eksportowana funkcja, bo to jedyny fragment tego
 * modułu z prawdziwą logiką — i jedyny, który da się przetestować bez
 * sieci i bez bazy (patrz tests/historyPriceService.test.js).
 *
 * Twelve Data często odpowiada kodem HTTP 200 i jednocześnie treścią
 * `{code, message, status: "error"}`, więc samo `response.ok` NIE wystarcza
 * do stwierdzenia, że zapytanie się udało.
 *
 * @param {any} payload odpowiedź sparsowana z JSON
 * @param {string} symbol do czytelnych komunikatów błędów
 * @returns {Array<{date: string, open: number|null, high: number|null,
 *                  low: number|null, close: number|null, volume: number|null}>}
 */
export function normalizeTimeSeries(payload, symbol) {
  if (!payload || typeof payload !== "object") {
    throw new Error(`Nieczytelna odpowiedź Twelve Data dla ${symbol}`);
  }

  if (payload.status === "error") {
    const code = payload.code;
    const message = payload.message || "brak szczegółów";

    if (code === 429) {
      throw new Error(
        `Wyczerpany limit zapytań Twelve Data (${message}). Spróbuj ponownie za chwilę.`,
      );
    }

    if (code === 401 || code === 403) {
      throw new Error(`Twelve Data odrzuciła klucz API: ${message}`);
    }

    throw new Error(`Błąd Twelve Data dla ${symbol}: ${message}`);
  }

  if (!Array.isArray(payload.values)) {
    throw new Error(`Brak danych historycznych dla tickera: ${symbol}`);
  }

  const bars = payload.values
    .map((item) => {
      // Przy interwale 1day `datetime` to "YYYY-MM-DD"; przy krótszych
      // interwałach doklejona jest godzina, więc ucinamy ją na wszelki wypadek.
      const date = String(item?.datetime ?? "").slice(0, 10);

      return {
        date,
        open: toNumberOrNull(item?.open),
        high: toNumberOrNull(item?.high),
        low: toNumberOrNull(item?.low),
        close: toNumberOrNull(item?.close),
        volume: toNumberOrNull(item?.volume),
      };
    })
    // Świeca bez daty jest bezużyteczna. Wymagamy też kompletnego OHLC —
    // nie tylko `close` — bo `open`/`high`/`low` puste przy obecnym
    // zamkniętym `close` to sygnał uszkodzonych danych od dostawcy, a nie
    // coś, co ma sens wpuścić do cache'u albo pokazać AI jako `null`.
    // `volume` zostaje wyjątkiem — Twelve Data legalnie go czasem nie
    // podaje dla niektórych instrumentów, więc `null` tam jest prawdziwą
    // informacją, nie błędem.
    //
    // Celowo ODRZUCAMY pojedynczą wadliwą świecę, a nie CAŁY fetch: jeden
    // zepsuty dzień od dostawcy nie powinien blokować historii pozostałych
    // 100+ dni w tym samym oknie.
    .filter(
      (bar) =>
        /^\d{4}-\d{2}-\d{2}$/.test(bar.date) &&
        bar.open !== null &&
        bar.high !== null &&
        bar.low !== null &&
        bar.close !== null,
    );

  // Twelve Data domyślnie zwraca od najnowszej; my wszędzie dalej zakładamy
  // porządek chronologiczny, więc sortujemy u siebie zamiast ufać parametrowi.
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return bars;
}

/**
 * Surowe zapytanie do Twelve Data. Bez cache — od niego jest cacheService.
 */
async function fetchDailyHistoryFromTwelveData(symbol, startDate, endDate) {
  const url = new URL(TWELVE_DATA_URL);

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", DAILY_INTERVAL);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("order", "ASC");
  url.searchParams.set("apikey", getTwelveDataApiKey());

  // Świadomie BEZ `outputsize`. Gdy `start_date` i `end_date` są użyte
  // razem, Twelve Data traktuje je jako granice żądanego zakresu i zwraca
  // WSZYSTKIE wartości między nimi. Oficjalny support Twelve Data wprost
  // ostrzega, że dodanie `outputsize` w tej sytuacji MOŻE OGRANICZYĆ liczbę
  // zwracanych rekordów — a nie tylko "nic nie zmienić", jak wcześniej
  // (błędnie) zakładał komentarz w tym miejscu. Potwierdzone:
  // support.twelvedata.com/en/articles/5214728-getting-historical-data
  // ("Note that the outputsize parameter is omitted in this case;
  // including it would restrict the output.").

  let response;

  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(
        "Przekroczono czas oczekiwania na historię z Twelve Data",
      );
    }

    throw error;
  }

  /*
   * Treść czytamy również przy statusie błędu HTTP: Twelve Data wkłada
   * w nią czytelny powód (np. wyczerpany limit), a sam kod HTTP mówi
   * znacznie mniej.
   */
  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `Błąd Twelve Data: ${response.status} ${response.statusText}`,
    );
  }

  return normalizeTimeSeries(payload, symbol);
}

/**
 * Sprawdza, że okno dat ma sens.
 */
function assertWindow(startDate, endDate) {
  if (startDate > endDate) {
    throw new Error("startDate nie może być późniejsze niż endDate");
  }
}

/**
 * Historia dzienna wraz z metadanymi cache (fetchedAt / expiresAt / fromCache).
 *
 * Te metadane przydadzą się w Etapie 8 przy budowaniu
 * `marketContextSnapshot` — analiza ma pamiętać, z jak świeżych danych
 * korzystała.
 *
 * Domyślne `endDate` (gdy nie podano) to `latestCompletedTradingDate()` —
 * NIGDY `latestTradingDate()`. To jest ten sam mechanizm, który chroni
 * `getMarketContext` przed pobraniem i zacache'owaniem niepełnej,
 * dzisiejszej świecy (patrz duży komentarz przy `getMarketContext`). Bez
 * tego domyślnego zabezpieczenia tutaj, na tym niższym poziomie, każde
 * przyszłe wywołanie `getDailyHistory(ticker)` bez jawnego `endDate` (np.
 * w Etapie 8 albo w statystykach z Etapu 9) mogłoby po cichu wprowadzić
 * dokładnie ten sam błąd na nowo, inną ścieżką.
 *
 * @param {string} ticker
 * @param {object} [options]
 * @param {string} [options.startDate] "YYYY-MM-DD"
 * @param {string} [options.endDate] "YYYY-MM-DD"
 * @param {Date} [options.now] wstrzykiwane w testach — patrz `now` w
 *                             `getMarketContext`; wpływa tylko na domyślne
 *                             `endDate`, gdy nie podano go jawnie
 */
export const getDailyHistorySnapshot = async (ticker, options = {}) => {
  const symbol = normalizeTicker(ticker);

  const endDate = options.endDate
    ? formatDateOnly(options.endDate)
    : latestCompletedTradingDate(options.now);

  const startDate = options.startDate
    ? formatDateOnly(options.startDate)
    : shiftTradingDays(endDate, -DEFAULT_LOOKBACK_SESSIONS);

  assertWindow(startDate, endDate);

  return getOrSet({
    key: keys.priceHistory(symbol, DAILY_INTERVAL, startDate, endDate),
    type: "price_history",
    source: "twelve_data",
    fetcher: () => fetchDailyHistoryFromTwelveData(symbol, startDate, endDate),
  });
};

/**
 * Sama historia, bez metadanych cache.
 *
 * @returns {Promise<Array>}
 */
export const getDailyHistory = async (ticker, options = {}) => {
  const snapshot = await getDailyHistorySnapshot(ticker, options);

  return snapshot.data;
};

/**
 * Obcina serię do dnia sesji włącznie.
 *
 * TO JEST mechanizm z sekcji 6.1 planu: separacja danych dla quick-checku
 * musi być wymuszona w kodzie, a nie poleceniem w prompcie. Model nie może
 * „obiecać", że nie zajrzy w przyszłość — po prostu nie dostaje tych świec.
 *
 * WAŻNE: `upTo` to granica DOSTĘPNOŚCI danych, nie etykieta sesji. Dla
 * quick-checku podawaj tu `latestCompletedTradingDate(action.actionDate)`
 * z tradingCalendar.js — NIGDY `action.tradingDateRef`. `tradingDateRef`
 * odpowiada na pytanie „do której sesji należała decyzja” (próg: otwarcie
 * 9:30) i przy decyzji w trakcie dnia wskazuje sesję, która jeszcze się nie
 * domknęła. Użycie go tutaj przepuściłoby dokładnie tę świecę, którą ten
 * mechanizm ma odciąć — a przy powtórzeniu quick-checku po zamknięciu
 * sesji (albo następnego dnia) dostałaby ona już OSTATECZNY kurs
 * zamknięcia, czyli informację niedostępną w chwili decyzji.
 *
 * @param {Array} bars
 * @param {Date|string} upTo granica danych — zwykle `latestCompletedTradingDate(actionDate)`
 *                           (Date o północy UTC albo "YYYY-MM-DD")
 */
export function filterBarsUpTo(bars, upTo) {
  if (!Array.isArray(bars)) return [];

  const limit = formatDateOnly(upTo);

  return bars.filter((bar) => bar.date <= limit);
}

/**
 * Kontekst rynkowy gotowy do podania AI.
 *
 * Jak dobierane jest okno:
 *
 *   startDate = sesja otwarcia pozycji − bufor sesji
 *   fetchEndDate = OSTATNIA ZAKOŃCZONA sesja (nie "dzisiaj" — patrz niżej)
 *
 * Oba końce zależą wyłącznie od pozycji i od dnia — NIE od konkretnej
 * akcji. Dzięki temu quick-check dla piątej akcji tej samej pozycji trafia
 * w ten sam klucz cache co quick-check dla pierwszej i nie kosztuje
 * kolejnego kredytu Twelve Data. Ograniczenie czasowe dla pojedynczej
 * akcji robimy dopiero na gotowej tablicy, przez filterBarsUpTo.
 *
 * DLACZEGO fetchEndDate = OSTATNIA ZAKOŃCZONA sesja, a nie "dzisiejsza":
 * ten serwis wcześniej pobierał dane do `latestTradingDate(now)` (sesja,
 * która się już ZACZĘŁA, choćby przed chwilą) i oznaczał dzisiejszą
 * świecę jako `isPartial: true`, jeśli sesja jeszcze trwała. To działało
 * w izolacji, ale psuło się w połączeniu z cache'em (`price_history` ma
 * TTL 12h): świeca pobrana o 15:00 (w trakcie sesji, `close` = cena z
 * 15:00) trafiała do CacheEntry. Zapytanie o TEN SAM klucz o 17:00 (po
 * zamknięciu) dostawało z cache dokładnie tamten, nieaktualny rekord z
 * 15:00 — ale flaga `isPartial` była liczona na nowo względem `now`=17:00,
 * więc wychodziła `false`. AI dostawałoby więc świecę WYGLĄDAJĄCĄ na
 * kompletną, której `close` w rzeczywistości był tylko zrzutem sprzed
 * dwóch godzin. Flaga nie kłamała w chwili pierwszego pobrania — kłamała
 * przy DRUGIM odczycie tych samych, już nieaktualnych danych z cache'u.
 *
 * Naprawa: nigdy nie pytamy Twelve Data o dzień, który jeszcze się nie
 * domknął. `fetchEndDate = latestCompletedTradingDate(now)` — przed
 * zamknięciem dzisiejszej sesji zwraca wczoraj (stabilne przez cały
 * dzień, jeden wspólny wpis cache), po zamknięciu przeskakuje na dziś,
 * pod NOWYM kluczem cache, więc pierwsze zapytanie po 16:00 i tak musi
 * pociągnąć świeży, już naprawdę kompletny wiersz. Niekompletna świeca
 * nigdy nie ląduje w CacheEntry, więc problem znika strukturalnie, a nie
 * przez pilnowanie flagi. Konsekwencja: `isPartial` był tu jedynym
 * konsumentem `isSessionClosed`/`now` — usunięty w całości. "Cena teraz"
 * i tak ma już lepsze źródło: `Action.marketPriceAtDecision`, liczone per
 * akcja z jej `actionDate` przez services/intradayPriceService.js.
 *
 * @param {string} ticker
 * @param {object} [options]
 * @param {Date|string} [options.since] `openedAt` pozycji — początek okna
 * @param {Date|string} [options.upTo] granica danych (quick-check) — zwykle
 *                                     `latestCompletedTradingDate(action.actionDate)`,
 *                                     NIGDY `action.tradingDateRef`;
 *                                     pominięty = pełna historia (analiza końcowa)
 * @param {number} [options.bufferSessions]
 * @param {number} [options.lookbackSessions] używane, gdy brak `since`
 * @param {Date} [options.now] wstrzykiwane w testach
 */
export const getMarketContext = async (ticker, options = {}) => {
  const {
    since,
    upTo,
    bufferSessions = DEFAULT_CONTEXT_BUFFER_SESSIONS,
    lookbackSessions = DEFAULT_LOOKBACK_SESSIONS,
    now = new Date(),
  } = options;

  const symbol = normalizeTicker(ticker);

  // Dokąd POBIERAMY dane — zawsze ostatnia ZAKOŃCZONA sesja, nigdy dzień
  // w trakcie. Patrz duży komentarz wyżej: to jest naprawa błędu
  // cache + niepełna świeca, nie tylko granica tego, co wolno POKAZAĆ
  // (od tego jest `dataCutoffDate` kilka linii niżej).
  const fetchEndDate = latestCompletedTradingDate(now);

  const anchor = since
    ? toTradingDateString(since)
    : shiftTradingDays(fetchEndDate, -lookbackSessions);

  // Pozycja otwarta dzisiaj przed otwarciem sesji może wskazywać dzień
  // późniejszy niż fetchEndDate — wtedy okno i tak kończy się na ostatniej
  // zakończonej sesji.
  const startDate = shiftTradingDays(
    anchor > fetchEndDate ? fetchEndDate : anchor,
    -Math.abs(bufferSessions),
  );

  const snapshot = await getDailyHistorySnapshot(symbol, {
    startDate,
    endDate: fetchEndDate,
  });

  // Dokąd WOLNO pokazać dane wywołującemu — patrz doc-block wyżej: dla
  // quick-checku to `latestCompletedTradingDate(action.actionDate)`,
  // NIGDY `action.tradingDateRef`.
  const dataCutoffDate = upTo ? formatDateOnly(upTo) : null;

  return {
    ticker: symbol,
    interval: DAILY_INTERVAL,
    source: "twelve_data",
    window: { startDate, endDate: fetchEndDate },
    upTo: dataCutoffDate,
    bars: dataCutoffDate
      ? filterBarsUpTo(snapshot.data, dataCutoffDate)
      : snapshot.data,
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
    fromCache: snapshot.fromCache,
  };
};
