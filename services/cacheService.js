import CacheEntry from "../models/CacheEntry.js";

/**
 * Domyślne TTL w sekundach.
 *
 * Różne dane potrzebują różnych czasów życia:
 *
 * quote:
 *   3 minuty — cena szybko się zmienia.
 *
 * news:
 *   2 godziny — nie ma potrzeby pobierać tych samych newsów
 *   przy każdym żądaniu.
 *
 * price_history:
 *   12 godzin — dzienna historia cen zmienia się znacznie rzadziej.
 */
export const CACHE_TTL_SECONDS = Object.freeze({
  quote: 3 * 60,
  news: 2 * 60 * 60,
  price_history: 12 * 60 * 60,
});

const CACHE_TYPES = Object.freeze(["quote", "news", "price_history"]);

const CACHE_SOURCES = Object.freeze(["finnhub", "twelve_data"]);

/**
 * Pending requests — deduplikacja równoczesnych cache missów.
 *
 * Przykład bez tego mechanizmu:
 *
 * Request A → cache miss → Finnhub
 * Request B → cache miss → Finnhub
 *
 * Oba requesty pytają dostawcę.
 *
 * Dzięki tej Map:
 *
 * Request A → cache miss → Finnhub
 * Request B → czeka na ten sam Promise
 *
 * Uwaga:
 * działa to tylko w obrębie jednego procesu Node.js.
 * Przy wielu instancjach potrzebny byłby mechanizm rozproszony,
 * np. Redis.
 */
const pendingRequests = new Map();

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
 * Zwraca prawidłowy TTL.
 *
 * @param {"quote"|"news"|"price_history"} type
 * @param {number|undefined} ttlSeconds
 * @returns {number}
 */
function resolveTtl(type, ttlSeconds) {
  const ttl = ttlSeconds ?? CACHE_TTL_SECONDS[type];

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("cacheService: ttlSeconds musi być dodatnią liczbą");
  }

  return ttl;
}

/**
 * Pobiera cały, niewygasły wpis cache.
 *
 * Zwracamy cały dokument, ponieważ później potrzebujemy
 * również metadanych takich jak fetchedAt.
 *
 * @param {string} key
 * @returns {Promise<object|null>}
 */
export const getEntry = async (key) => {
  if (typeof key !== "string" || !key.trim()) {
    return null;
  }

  try {
    const entry = await CacheEntry.findOne({
      key,
      expiresAt: { $gt: new Date() },
    }).lean();

    return entry ?? null;
  } catch (error) {
    console.error(`cacheService.getEntry error [${key}]:`, error.message);

    /*
     * Cache jest warstwą pomocniczą.
     * Jeżeli MongoDB cache akurat nie działa,
     * aplikacja może spróbować pobrać dane bezpośrednio
     * od zewnętrznego dostawcy.
     */
    return null;
  }
};

/**
 * Pobiera wyłącznie dane z cache.
 *
 * @param {string} key
 * @returns {Promise<any|null>}
 */
export const get = async (key) => {
  const entry = await getEntry(key);

  return entry?.data ?? null;
};

/**
 * Zapisuje dane do trwałego cache MongoDB.
 *
 * Błąd walidacji argumentów jest zgłaszany,
 * ponieważ oznacza nieprawidłowe użycie funkcji.
 *
 * Błąd samego MongoDB nie jest dalej rzucany,
 * ponieważ awaria cache nie powinna blokować
 * głównej operacji aplikacji.
 *
 * @param {string} key
 * @param {any} data
 * @param {number} [ttlSeconds]
 * @param {object} meta
 * @param {"quote"|"news"|"price_history"} meta.type
 * @param {"finnhub"|"twelve_data"} meta.source
 */
export const set = async (key, data, ttlSeconds, meta = {}) => {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("cacheService.set: key jest wymagany");
  }

  if (data === undefined) {
    throw new Error("cacheService.set: data jest wymagane");
  }

  const { type, source } = meta;

  if (!CACHE_TYPES.includes(type)) {
    throw new Error(
      'cacheService.set: type musi być "quote" | "news" | "price_history"',
    );
  }

  if (!CACHE_SOURCES.includes(source)) {
    throw new Error(
      'cacheService.set: source musi być "finnhub" | "twelve_data"',
    );
  }

  const ttl = resolveTtl(type, ttlSeconds);

  const fetchedAt = new Date();

  const expiresAt = new Date(fetchedAt.getTime() + ttl * 1000);

  try {
    await CacheEntry.findOneAndUpdate(
      { key },
      {
        $set: {
          key,
          type,
          data,
          source,
          fetchedAt,
          expiresAt,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    console.error(`cacheService.set error [${key}]:`, error.message);
  }
};

/**
 * Cache-first.
 *
 * Kolejność:
 *
 * 1. sprawdź trwały cache,
 * 2. jeżeli jest ważny wpis → zwróć go,
 * 3. jeżeli ktoś już pobiera ten sam zasób → użyj tego samego Promise,
 * 4. w przeciwnym razie uruchom fetcher(),
 * 5. zapisz wynik do cache,
 * 6. zwróć dane wraz z metadanymi.
 *
 * @param {object} options
 * @param {string} options.key
 * @param {"quote"|"news"|"price_history"} options.type
 * @param {"finnhub"|"twelve_data"} options.source
 * @param {Function} options.fetcher
 * @param {number} [options.ttlSeconds]
 *
 * @returns {Promise<{
 *   data: any,
 *   fetchedAt: Date,
 *   expiresAt: Date,
 *   fromCache: boolean
 * }>}
 */
export const getOrSet = async ({ key, type, source, fetcher, ttlSeconds }) => {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("cacheService.getOrSet: key jest wymagany");
  }

  if (!CACHE_TYPES.includes(type)) {
    throw new Error("cacheService.getOrSet: nieprawidłowy type");
  }

  if (!CACHE_SOURCES.includes(source)) {
    throw new Error("cacheService.getOrSet: nieprawidłowy source");
  }

  if (typeof fetcher !== "function") {
    throw new Error("cacheService.getOrSet: fetcher musi być funkcją");
  }

  const ttl = resolveTtl(type, ttlSeconds);

  // 1. Normalny cache hit.
  const cached = await getEntry(key);

  if (cached) {
    return {
      data: cached.data,
      fetchedAt: cached.fetchedAt,
      expiresAt: cached.expiresAt,
      fromCache: true,
    };
  }

  // 2. Czy ktoś już pobiera dane dla tego samego klucza?
  const pending = pendingRequests.get(key);

  if (pending) {
    return pending;
  }

  /*
   * 3. Pierwszy request rozpoczyna pobieranie.
   *
   * Drugi odczyt cache jest celowy: pomiędzy pierwszym getEntry()
   * a utworzeniem Promise inny request mógł zdążyć zapisać dane.
   */
  const requestPromise = (async () => {
    const cachedAgain = await getEntry(key);

    if (cachedAgain) {
      return {
        data: cachedAgain.data,
        fetchedAt: cachedAgain.fetchedAt,
        expiresAt: cachedAgain.expiresAt,
        fromCache: true,
      };
    }

    // 4. Cache miss → pobieramy dane od dostawcy.
    const data = await fetcher();

    /*
     * 5. Zapisujemy wynik.
     *
     * set() sama obsługuje błąd MongoDB,
     * więc awaria cache nie odbierze nam poprawnie
     * pobranych danych.
     */
    await set(key, data, ttl, {
      type,
      source,
    });

    const fetchedAt = new Date();

    return {
      data,
      fetchedAt,
      expiresAt: new Date(fetchedAt.getTime() + ttl * 1000),
      fromCache: false,
    };
  })();

  pendingRequests.set(key, requestPromise);

  try {
    return await requestPromise;
  } finally {
    /*
     * Usuwamy tylko ten konkretny Promise.
     *
     * Dzięki temu nie usuniemy przez przypadek nowszego
     * requestu uruchomionego pod tym samym kluczem.
     */
    if (pendingRequests.get(key) === requestPromise) {
      pendingRequests.delete(key);
    }
  }
};

/**
 * Usuwa konkretny wpis cache.
 *
 * @param {string} key
 */
export const del = async (key) => {
  if (typeof key !== "string" || !key.trim()) {
    return;
  }

  try {
    await CacheEntry.deleteOne({ key });
  } catch (error) {
    console.error(`cacheService.del error [${key}]:`, error.message);
  }
};

/**
 * Generatory kluczy.
 *
 * Cache jest współdzielony po tickerze/zasobie,
 * a nie po konkretnej Position.
 */
export const keys = {
  quote: (ticker) => `quote:${normalizeTicker(ticker)}`,

  news: (ticker, from, to) => `news:${normalizeTicker(ticker)}:${from}:${to}`,

  priceHistory: (ticker, interval, startDate, endDate) =>
    `history:${normalizeTicker(ticker)}:${interval}:${
      startDate || "none"
    }:${endDate || "none"}`,
};
