import { getOrSet, keys } from "./cacheService.js";
import { getDailyHistory, getTwelveDataApiKey } from "./historyPriceService.js";
import {
  isWithinRegularSession,
  latestCompletedTradingDate,
  regularSessionOpenUtc,
} from "../utils/tradingCalendar.js";

/**
 * intradayPriceService.js
 *
 * `marketPriceAtDecision` — cena rynkowa REFERENCYJNA dla momentu decyzji,
 * zamiast ceny "teraz" pobieranej przy zapisie akcji.
 *
 * Problem, który to rozwiązuje: wcześniej `marketPriceAtDecision` było
 * pobierane z Finnhub w chwili ZAPISU akcji (`getCurrentPrice`), a nie w
 * chwili DECYZJI (`actionDate`). Dla wpisu z opóźnieniem (np. decyzja o
 * 15:00, zapis o 17:00, albo decyzja wczoraj, zapis dziś rano) dawało to
 * fałszywy kontekst — baza mówiła "decyzja przy cenie X", mimo że
 * rzeczywista cena rynkowa w chwili decyzji była inna.
 *
 * DOKŁADNA DEFINICJA (ważne, żeby nie obiecywać więcej, niż kod daje):
 * to NIE jest cena dokładnie z sekundy `actionDate`. To jest close
 * OSTATNIEJ W PEŁNI ZAMKNIĘTEJ świecy 1-minutowej SPRZED `actionDate`.
 * Dla decyzji o 15:37:42 świeca "15:37" jeszcze się buduje (kończy się
 * dopiero o 15:38:00) — nie wolno jej użyć, bo jej close zawierałby cenę
 * z chwil PO decyzji. Bierzemy więc świecę "15:36": cenę zamknięcia z
 * około 15:37:00, nie cenę dokładnie o 15:37:42. Z samego OHLCV 1-min nie
 * da się wyciągnąć dokładniejszej wartości — to jest granica dokładności
 * tej metody, nie błąd. To ten sam wzorzec co `latestCompletedTradingDate`
 * w tradingCalendar.js, tylko zastosowany do pojedynczej minuty zamiast
 * do całej sesji.
 *
 * Poza godzinami regularnej sesji (przed 9:30 ET, po zamknięciu, weekend,
 * święto) świadomie bierzemy ostatnie zamknięcie DZIENNE z
 * historyPriceService.js (ten sam mechanizm co przy quick-checku), a nie
 * ostatnią świecę minutową. Świece intraday z zakończonej sesji nadal
 * istnieją w danych historycznych — wybieramy EOD, bo reprezentuje
 * OFICJALNE zamknięcie sesji (z closing auction), więc dla decyzji
 * zapisanej po zamknięciu jest lepszym "kursem rynku tego dnia" niż
 * minuta sprzed 16:00; Twelve Data samo opisuje, że close intraday i
 * dzienny EOD mogą się różnić. Przed otwarciem, w weekend i w święto
 * świec "tej sesji" po prostu nie ma. Pre/post-market jest zresztą
 * funkcją Pro planu Twelve Data, nie darmowego.
 *
 * Koszt: to zapytanie do Twelve Data leci TYLKO przy cache miss (klucz
 * cache zależy od tickera i dokładnego okna czasowego) — więc dokładniej:
 * każda akcja MOŻE wygenerować jedno dodatkowe zapytanie, jeśli jej okno
 * nie jest już w cache, a nie "zawsze generuje". Wcześniej
 * marketPriceAtDecision kosztowało zapytanie do Finnhub — osobny budżet.
 * Ta zmiana przenosi ten koszt na budżet Twelve Data (8 kredytów/min,
 * 800/dzień), współdzielony teraz z historią dzienną. Przy kilku
 * testerach to nadal spory zapas.
 */

const TWELVE_DATA_URL = "https://api.twelvedata.com/time_series";
const INTRADAY_TIMEOUT_MS = 10000;
const ONE_MIN_INTERVAL = "1min";
const ONE_MINUTE_MS = 60 * 1000;

function normalizeTicker(ticker) {
  if (typeof ticker !== "string" || !ticker.trim()) {
    throw new Error("Ticker jest wymagany");
  }

  return ticker.trim().toUpperCase();
}

function toDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Nieprawidłowa ${label}: "${value}"`);
  }

  return date;
}

/**
 * Zaokrągla w dół do pełnej minuty UTC.
 */
function floorToMinuteUtc(date) {
  return new Date(Math.floor(date.getTime() / ONE_MINUTE_MS) * ONE_MINUTE_MS);
}

/**
 * "YYYY-MM-DDTHH:MM:SS" w UTC, bez ułamka sekundy i bez "Z" — dokładnie
 * taki format wymaga Twelve Data dla start_date/end_date ze składową
 * czasu (potwierdzone w ich dokumentacji, przykład: "2024-08-22T15:04:05").
 */
function formatTwelveDataDateTime(date) {
  return date.toISOString().slice(0, 19);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Zamienia odpowiedź Twelve Data na naszą postać, zachowując PEŁNY
 * znacznik czasu (nie tylko dzień, jak `normalizeTimeSeries` w
 * historyPriceService.js — tam ucinanie do samego dnia jest celowe, tutaj
 * byłoby stratą dokładnie tej informacji, po którą sięgamy).
 *
 * Odpowiedź Twelve Data dla danych intraday ma `datetime` w formacie
 * "YYYY-MM-DD HH:MM:SS" (spacja, nie "T") — w strefie, o którą jawnie
 * poprosiliśmy (`timezone=UTC`), więc bezpiecznie doklejamy "T"/"Z" i
 * parsujemy jako UTC.
 *
 * @param {any} payload
 * @param {string} symbol
 * @returns {Array<{datetime: Date, open: number|null, high: number|null,
 *                  low: number|null, close: number|null, volume: number|null}>}
 */
export function normalizeIntradaySeries(payload, symbol) {
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
    throw new Error(`Brak danych intraday dla tickera: ${symbol}`);
  }

  const bars = payload.values
    .map((item) => {
      const raw = String(item?.datetime ?? "");
      // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
      const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
        ? `${raw.replace(" ", "T")}Z`
        : null;
      const datetime = iso ? new Date(iso) : null;

      return {
        datetime,
        open: toNumberOrNull(item?.open),
        high: toNumberOrNull(item?.high),
        low: toNumberOrNull(item?.low),
        close: toNumberOrNull(item?.close),
        volume: toNumberOrNull(item?.volume),
      };
    })
    // Tak samo jak w historyPriceService: pełny OHLC wymagany, nie tylko
    // close — pojedyncza wadliwa świeca jest odrzucana, nie cały fetch.
    .filter(
      (bar) =>
        bar.datetime instanceof Date &&
        !Number.isNaN(bar.datetime.getTime()) &&
        bar.open !== null &&
        bar.high !== null &&
        bar.low !== null &&
        bar.close !== null,
    );

  bars.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

  return bars;
}

/**
 * Surowe zapytanie do Twelve Data. Bez cache — od niego jest cacheService.
 */
async function fetchOneMinuteCandles(symbol, startDateTime, endDateTime) {
  const url = new URL(TWELVE_DATA_URL);

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", ONE_MIN_INTERVAL);
  url.searchParams.set("start_date", startDateTime);
  url.searchParams.set("end_date", endDateTime);
  // Jawnie UTC — bez tego Twelve Data domyślnie zwraca dane w strefie
  // giełdy (America/New_York dla akcji US), a nasz kod wszędzie indziej
  // (tradingCalendar.js, actionDate) operuje na UTC. Ta sama klasa błędu,
  // której unikaliśmy przy actionDate, tylko po stronie odpowiedzi API.
  url.searchParams.set("timezone", "UTC");
  // marketPriceAtDecision jest porównywane z executionPrice — realną,
  // niekorygowaną ceną transakcji. Domyślne zachowanie Twelve Data koryguje
  // ceny historyczne pod kątem splitów/dywidend; "none" zapewnia, że
  // dostajemy cenę faktycznie notowaną wtedy na rynku, nie retrospektywnie
  // przeliczoną.
  url.searchParams.set("adjust", "none");
  url.searchParams.set("order", "ASC");
  url.searchParams.set("apikey", getTwelveDataApiKey());

  let response;

  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(INTRADAY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(
        "Przekroczono czas oczekiwania na dane intraday z Twelve Data",
      );
    }

    throw error;
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `Błąd Twelve Data: ${response.status} ${response.statusText}`,
    );
  }

  return normalizeIntradaySeries(payload, symbol);
}

/**
 * Cena zamknięcia ostatniej zakończonej sesji — fallback dla momentów
 * poza regularną sesją (przed otwarciem, po zamknięciu, weekend, święto).
 * Ten sam mechanizm, którego już używa quick-check dla danych dziennych.
 */
async function fallbackSessionClose(symbol, momentValue) {
  const day = latestCompletedTradingDate(momentValue);

  const bars = await getDailyHistory(symbol, {
    startDate: day,
    endDate: day,
  });

  // Sprawdzamy, że dostaliśmy dane FAKTYCZNIE dla poproszonego dnia — nie
  // ufamy ślepo "ostatniemu elementowi z tablicy". Gdyby dostawca akurat
  // nie miał jeszcze danych dla `day` (np. tuż po zamknięciu sesji, zanim
  // oficjalny EOD zostanie opublikowany), `bars.at(-1)` mógłby po cichu
  // podstawić cenę ze STARSZEGO dnia z tym samym timestampem `day` w
  // odpowiedzi.
  const bar = bars.find((item) => item.date === day);

  if (!bar) return null;

  return {
    price: bar.close,
    source: "twelve_data_daily_close",
    asOf: day,
    fromCache: null,
  };
}

/**
 * Cena rynkowa referencyjna dla danego momentu, bez wglądu w przyszłość
 * względem tego momentu. Patrz dokładna definicja w komentarzu na górze
 * pliku — to close ostatniej zamkniętej świecy 1-min, nie cena "co do
 * sekundy".
 *
 * @param {string} ticker
 * @param {Date|string|number} momentValue zwykle `action.actionDate`
 * @returns {Promise<{price: number, source: string, asOf: Date|string,
 *                    fromCache: boolean|null}|null>}
 *          null, gdy nie udało się znaleźć żadnej ceny (np. instrument bez
 *          żadnego obrotu tego dnia i brak wcześniejszej sesji — skrajnie
 *          rzadkie).
 */
export async function getPriceAtMoment(ticker, momentValue) {
  const symbol = normalizeTicker(ticker);
  const moment = toDate(momentValue, "momentValue");

  if (!isWithinRegularSession(moment)) {
    return fallbackSessionClose(symbol, moment);
  }

  // Świeca ZAWIERAJĄCA `moment` jeszcze się buduje — ostatnia NA PEWNO
  // zamknięta to ta o jedną minutę wcześniej. To jest cała zasada
  // "bez wglądu w przyszłość" w tej funkcji.
  const inProgressCandleStart = floorToMinuteUtc(moment);
  const lastClosedCandleStart = new Date(
    inProgressCandleStart.getTime() - ONE_MINUTE_MS,
  );

  // Okno od OTWARCIA bieżącej sesji, nie stałe kilkanaście minut wstecz —
  // odporne na halt/przerwę w notowaniach: nawet gdy ostatni handel był
  // pół godziny wcześniej, wciąż go znajdziemy. Koszt to zawsze 1 zapytanie
  // (Twelve Data liczy kredyty za wywołanie, nie za liczbę zwróconych
  // punktów), więc większe okno nie kosztuje więcej.
  const windowStart = regularSessionOpenUtc(moment);

  // Dokładnie w chwili otwarcia (9:30:00.000) żadna świeca jeszcze się nie
  // zamknęła — okno wyszłoby odwrócone (lastClosedCandleStart < windowStart).
  // Nie ma czego pytać Twelve Data — od razu fallback do wczorajszego
  // zamknięcia.
  if (lastClosedCandleStart.getTime() < windowStart.getTime()) {
    return fallbackSessionClose(symbol, moment);
  }

  const startDateTime = formatTwelveDataDateTime(windowStart);
  const endDateTime = formatTwelveDataDateTime(lastClosedCandleStart);

  const snapshot = await getOrSet({
    key: keys.priceIntraday(symbol, startDateTime, endDateTime),
    type: "price_intraday",
    source: "twelve_data",
    fetcher: () => fetchOneMinuteCandles(symbol, startDateTime, endDateTime),
  });

  // Defensywne powtórne odcięcie po stronie klienta — tak samo jak
  // filterBarsUpTo w historyPriceService.js: nigdy nie ufamy WYŁĄCZNIE
  // granicy zapytania, sprawdzamy ją też lokalnie.
  const usable = snapshot.data.filter(
    (bar) => bar.datetime.getTime() <= lastClosedCandleStart.getTime(),
  );

  const candle = usable.at(-1);

  if (!candle) {
    // Brak ŻADNEJ świecy od otwarcia sesji do teraz (instrument bez
    // obrotu w ogóle dziś przed tym momentem) — fallback do ostatniego
    // zamknięcia dziennego, zamiast zwracać błąd dla operacji domenowej,
    // której to pole tylko wspomaga.
    return fallbackSessionClose(symbol, moment);
  }

  return {
    price: candle.close,
    source: "twelve_data_intraday",
    // asOf to moment ZAMKNIĘCIA tej świecy (candle.datetime + 1 minuta),
    // nie jej otwarcia — candle.close jest ceną na KONIEC minuty, więc
    // podpisanie jej czasem początku minuty byłoby mylące. Zawsze NIE
    // PÓŹNIEJ niż `moment` (patrz komentarz przy lastClosedCandleStart
    // wyżej): równo `moment` wychodzi, gdy decyzja zapada dokładnie na
    // granicy minuty (np. 15:38:00.000 i świeca 15:37, która kończy się
    // właśnie wtedy) — to nie jest wyciek z przyszłości, cena jest znana
    // od tej samej chwili, w której zapadła decyzja.
    asOf: new Date(candle.datetime.getTime() + ONE_MINUTE_MS),
    fromCache: snapshot.fromCache,
  };
}
