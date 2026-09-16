const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

/**
 * Bieżąca cena (Finnhub /quote)
 * @returns {Promise<number>} current price
 */
export const getCurrentPrice = async (ticker) => {
  if (!FINNHUB_API_KEY) {
    throw new Error("Brak FINNHUB_API_KEY w pliku .env");
  }

  if (typeof ticker !== "string" || !ticker.trim()) {
    throw new Error("Ticker jest wymagany");
  }

  const symbol = ticker.trim().toUpperCase();

  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", FINNHUB_API_KEY);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(
        `Błąd Finnhub: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();

    if (data.c === 0 || data.c === null || data.c === undefined) {
      throw new Error(`Nie udało się pobrać ceny dla tickera: ${symbol}`);
    }

    return data.c;
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("Przekroczono czas oczekiwania na odpowiedź z Finnhub");
    }
    console.error("Błąd w getCurrentPrice:", error.message);
    throw error;
  }
};

/**
 * Newsy spółki (Finnhub /company-news)
 * @param {string} ticker
 * @param {string} from - YYYY-MM-DD
 * @param {string} to   - YYYY-MM-DD
 * @returns {Promise<Array>}
 */
export const getCompanyNews = async (ticker, from, to) => {
  if (!FINNHUB_API_KEY) {
    throw new Error("Brak FINNHUB_API_KEY w pliku .env");
  }

  if (typeof ticker !== "string" || !ticker.trim()) {
    throw new Error("Ticker jest wymagany");
  }

  const symbol = ticker.trim().toUpperCase();

  const url = new URL("https://finnhub.io/api/v1/company-news");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", FINNHUB_API_KEY);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(
        `Błąd Finnhub news: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();

    // Finnhub zwraca tablicę; przy błędzie czasem obiekt z error
    if (!Array.isArray(data)) {
      throw new Error(`Nie udało się pobrać newsów dla tickera: ${symbol}`);
    }

    // Normalizacja – bierzemy tylko najważniejsze pola
    return data.map((item) => ({
      datetime: item.datetime, // unix timestamp
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      url: item.url,
    }));
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("Przekroczono czas oczekiwania na newsy z Finnhub");
    }
    console.error("Błąd w getCompanyNews:", error.message);
    throw error;
  }
};
