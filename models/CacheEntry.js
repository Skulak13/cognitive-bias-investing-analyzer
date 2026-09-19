import mongoose from "mongoose";

const cacheEntrySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // unique: true tworzy indeks unikalny,
      // więc nie dodajemy tutaj index: true.
    },

    type: {
      type: String,
      enum: ["quote", "news", "price_history"],
      required: true,
      index: true,
    },

    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    source: {
      type: String,
      enum: ["finnhub", "twelve_data"],
      required: true,
    },

    fetchedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },

    expiresAt: {
      type: Date,
      required: true,
      // Indeks TTL definiujemy osobno poniżej.
    },
  },
  {
    timestamps: false,
  },
);

/**
 * TTL index.
 *
 * MongoDB automatycznie usuwa dokument po osiągnięciu expiresAt.
 *
 * expireAfterSeconds: 0 oznacza, że wartość expiresAt jest
 * traktowana jako dokładny moment wygaśnięcia.
 */
cacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CacheEntry = mongoose.model("CacheEntry", cacheEntrySchema);

export default CacheEntry;
