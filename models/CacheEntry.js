import mongoose from "mongoose";

const cacheEntrySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
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
      index: true,
    },
  },
  {
    timestamps: false, // nie potrzebujemy createdAt/updatedAt
  },
);

// TTL index – Mongo automatycznie usuwa dokumenty po expiresAt
cacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CacheEntry = mongoose.model("CacheEntry", cacheEntrySchema);

export default CacheEntry;
