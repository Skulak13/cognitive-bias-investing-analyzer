import CacheEntry from "../models/CacheEntry.js";

/**
 * Domyślne TTL w sekundach (różne per typ zasobu)
 */
const DEFAULT_TTL = {
  quote: 3 * 60, // 3 minuty – bieżąca cena szybko się dezaktualizuje
  news: 30 * 60, // 30 minut
  price_history: 12 * 60 * 60, // 12 godzin (do następnej sesji)
};

/**
 * Pobiera wartość z cache.
 * @param {string} key
 * @returns {Promise<any|null>} data lub null jeśli brak / wygasło
 */
export const get = async (key) => {
  if (!key || typeof key !== "string") {
    return null;
  }

  try {
    const entry = await CacheEntry.findOne({
      key,
      expiresAt: { $gt: new Date() }, // tylko niewygasłe
    }).lean();

    return entry ? entry.data : null;
  } catch (error) {
    console.error(`cacheService.get error [${key}]:`, error.message);
    return null; // cache nie powinien nigdy wywalać całej aplikacji
  }
};

/**
 * Zapisuje wartość do cache.
 * @param {string} key
 * @param {any} data
 * @param {number} [ttlSeconds] - opcjonalnie nadpisuje domyślny TTL
 * @param {object} meta
 * @param {"quote"|"news"|"price_history"} meta.type
 * @param {"finnhub"|"twelve_data"} meta.source
 */
export const set = async (key, data, ttlSeconds, meta = {}) => {
  if (!key || typeof key !== "string") {
    throw new Error("cacheService.set: key jest wymagany");
  }

  const { type, source } = meta;

  if (!type || !["quote", "news", "price_history"].includes(type)) {
    throw new Error(
      'cacheService.set: type musi być "quote" | "news" | "price_history"',
    );
  }

  if (!source || !["finnhub", "twelve_data"].includes(source)) {
    throw new Error(
      'cacheService.set: source musi być "finnhub" | "twelve_data"',
    );
  }

  const ttl = ttlSeconds ?? DEFAULT_TTL[type] ?? 3600;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  try {
    await CacheEntry.findOneAndUpdate(
      { key },
      {
        key,
        type,
        data,
        source,
        fetchedAt: now,
        expiresAt,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    console.error(`cacheService.set error [${key}]:`, error.message);
    // Nie rzucamy dalej – nieudany zapis cache nie powinien blokować głównej logiki
  }
};

/**
 * Usuwa konkretny klucz (przydatne przy ręcznym unieważnianiu)
 */
export const del = async (key) => {
  try {
    await CacheEntry.deleteOne({ key });
  } catch (error) {
    console.error(`cacheService.del error [${key}]:`, error.message);
  }
};

/**
 * Pomocnicze generatory kluczy – trzymaj spójność w całej aplikacji
 */
export const keys = {
  quote: (ticker) => `quote:${ticker.toUpperCase()}`,
  news: (ticker, from, to) => `news:${ticker.toUpperCase()}:${from}:${to}`,
  priceHistory: (ticker, interval, startDate, endDate) =>
    `history:${ticker.toUpperCase()}:${interval}:${startDate || "none"}:${endDate || "none"}`,
};
