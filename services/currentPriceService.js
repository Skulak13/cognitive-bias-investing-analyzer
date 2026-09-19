import { getOrSet, keys } from "./cacheService.js";

const QUOTE_TIMEOUT_MS = 5000;
const NEWS_TIMEOUT_MS = 8000;

/**
 * Pobiera klucz API dopiero w momencie wykonywania
 * rzeczywistego requestu do Finnhub.
 *
 * Dzięki temu moduł nie zależy od kolejności importów
 * i wcześniejszego wykonania dotenv.
 */
function getFinnhubApiKey() {
  const apiKey = process.env.FINNHUB_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Brak FINNHUB_API_KEY w pliku .env");
  }

  return apiKey;
}

/**
 * Normalizuje ticker.
 *
 * @param {string} ticker
 * @returns {string}
 */
function normalizeTicker(ticker) {
  if (typeof ticker !== "string" || !ticker.trim()) {
    throw new Error("Ticker jest wymagany");
  }

  return ticker.trim().toUpperCase();
}

/**
 * Sprawdza format daty YYYY-MM-DD.
 *
 * @param {string} value
 * @param {string} fieldName
 */
function validateDateOnly(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} musi mieć format YYYY-MM-DD`);
  }
}

/**
 * Pobiera bieżącą cenę bezpośrednio z Finnhub.
 *
 * Ta funkcja NIE zajmuje się cache.
 * Za cache odpowiada cacheService.getOrSet().
 */
async function fetchCurrentPriceFromFinnhub(symbol) {
  const url = new URL("https://finnhub.io/api/v1/quote");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", getFinnhubApiKey());

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Błąd Finnhub: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();

    const price = Number(data?.c);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Nie udało się pobrać ceny dla tickera: ${symbol}`);
    }

    return price;
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("Przekroczono czas oczekiwania na odpowiedź z Finnhub");
    }

    throw error;
  }
}

/**
 * Pobiera newsy bezpośrednio z Finnhub.
 *
 * Ta funkcja NIE zajmuje się cache.
 * Za cache odpowiada cacheService.getOrSet().
 */
async function fetchCompanyNewsFromFinnhub(symbol, from, to) {
  const url = new URL("https://finnhub.io/api/v1/company-news");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", getFinnhubApiKey());

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(NEWS_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Błąd Finnhub news: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error(`Nie udało się pobrać newsów dla tickera: ${symbol}`);
    }

    /*
     * Normalizacja:
     * przechowujemy tylko pola potrzebne aplikacji.
     */
    return data.map((item) => ({
      datetime: item.datetime,
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      url: item.url,
    }));
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("Przekroczono czas oczekiwania na newsy z Finnhub");
    }

    throw error;
  }
}

/**
 * Bieżąca cena Finnhub /quote.
 *
 * Przepływ:
 *
 * getCurrentPrice()
 *      ↓
 * cacheService.getOrSet()
 *      ↓
 * cache hit → zwróć cache
 *      ↓
 * cache miss → Finnhub → zapisz cache
 *
 * @param {string} ticker
 * @returns {Promise<number>}
 */
export const getCurrentPrice = async (ticker) => {
  const symbol = normalizeTicker(ticker);

  const result = await getOrSet({
    key: keys.quote(symbol),
    type: "quote",
    source: "finnhub",
    fetcher: () => fetchCurrentPriceFromFinnhub(symbol),
  });

  return result.data;
};

/**
 * Bieżąca cena razem z metadanymi cache.
 *
 * Przyda się później przy tworzeniu
 * marketContextSnapshot.
 *
 * @param {string} ticker
 * @returns {Promise<object>}
 */
export const getCurrentPriceSnapshot = async (ticker) => {
  const symbol = normalizeTicker(ticker);

  return getOrSet({
    key: keys.quote(symbol),
    type: "quote",
    source: "finnhub",
    fetcher: () => fetchCurrentPriceFromFinnhub(symbol),
  });
};

/**
 * Newsy spółki.
 *
 * Klucz cache zależy od:
 * ticker + from + to
 *
 * Dzięki temu różne zakresy dat nie nadpisują się nawzajem.
 *
 * @param {string} ticker
 * @param {string} from - YYYY-MM-DD
 * @param {string} to - YYYY-MM-DD
 * @returns {Promise<Array>}
 */
export const getCompanyNews = async (ticker, from, to) => {
  const symbol = normalizeTicker(ticker);

  validateDateOnly(from, "from");
  validateDateOnly(to, "to");

  if (from > to) {
    throw new Error("from nie może być późniejsze niż to");
  }

  const result = await getOrSet({
    key: keys.news(symbol, from, to),
    type: "news",
    source: "finnhub",
    fetcher: () => fetchCompanyNewsFromFinnhub(symbol, from, to),
  });

  return result.data;
};
