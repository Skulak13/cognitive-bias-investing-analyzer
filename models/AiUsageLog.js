import mongoose from "mongoose";

/**
 * Dziennik zużycia AI (Etap 8, 6.9, D8-06/D8-23): jeden dokument na PRÓBĘ
 * wywołania modelu.
 *
 * NIE zapisujemy tu żadnych treści: uzasadnień, expectedOutcome, newsów,
 * odpowiedzi AI, kluczy API ani e-maili. Tylko identyfikatory, liczby i kody.
 * Tokeny są `null`, gdy API ich nie zwróciło — nie zgadujemy.
 */

// Czas życia rekordu diagnostycznego (propozycja 6.9: 90 dni).
export const AI_USAGE_LOG_TTL_SECONDS = 90 * 24 * 60 * 60;

export const AI_USAGE_KINDS = ["quickCheck", "full"];
export const AI_USAGE_TRIGGERS = ["manual", "auto_after_close", "technical_test"];
export const AI_USAGE_OUTCOMES = [
  "success",
  "http_error",
  "timeout",
  "network_error",
  "invalid_response",
  "truncated_output",
  "blocked",
  "skipped",
  "write_rejected",
];

// Liczniki (tokeny, znaki, numer próby) muszą być całkowite; null = brak danych.
const isIntegerOrNull = (v) => v === null || v === undefined || Number.isInteger(v);
const integerRule = {
  validator: isIntegerOrNull,
  message: "{PATH} musi być liczbą całkowitą",
};
const nullableCount = { type: Number, default: null, min: 0, validate: integerRule };

// Klucze mapy długości pól to NAZWY pól (np. "reasoning"), nigdy treść:
// krótki identyfikator bez spacji i znaków specjalnych, a wartości to całkowite długości.
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_FIELD_LENGTH_KEYS = 30;
const fieldLengthsRule = {
  validator(map) {
    if (map === null || map === undefined) return true;
    const entries = [...map.entries()];
    return (
      entries.length <= MAX_FIELD_LENGTH_KEYS &&
      entries.every(([k, v]) => FIELD_NAME_PATTERN.test(k) && Number.isInteger(v) && v >= 0)
    );
  },
  message:
    "maxFieldLengths: dozwolone tylko nazwy pól (krótki identyfikator, do 30 kluczy) i całkowite długości ≥ 0",
};

const aiUsageLogSchema = new mongoose.Schema(
  {
    // Identyfikacja
    analysisRunId: { type: String, required: true },
    attempt: { type: Number, required: true, min: 1, validate: integerRule },
    kind: { type: String, enum: AI_USAGE_KINDS, required: true },
    trigger: { type: String, enum: AI_USAGE_TRIGGERS, required: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    positionId: { type: mongoose.Schema.Types.ObjectId, ref: "Position", default: null },
    actionId: { type: mongoose.Schema.Types.ObjectId, ref: "Action", default: null }, // tylko quick-check

    // Model
    provider: { type: String, required: true, default: "gemini" },
    requestedModel: { type: String, required: true },
    modelVersion: { type: String, default: null }, // z odpowiedzi, jeśli jest
    endpointKind: { type: String, default: null },
    promptVersion: { type: String, default: null },

    // Czas
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, default: null, min: 0 },

    // Wynik
    outcome: { type: String, enum: AI_USAGE_OUTCOMES, required: true },
    httpStatus: { type: Number, default: null },
    providerErrorCode: { type: String, default: null },
    finishReason: { type: String, default: null },

    // Tokeny — null, gdy API ich nie zwróci
    inputTokens: nullableCount,
    outputTokens: nullableCount,
    reasoningTokens: nullableCount,
    totalTokens: nullableCount,
    cachedTokens: nullableCount,

    // Rozmiary (D5 z Etapu 7: warto logować długości pól)
    inputChars: nullableCount,
    outputChars: nullableCount,
    maxFieldLengths: { type: Map, of: Number, default: undefined, validate: fieldLengthsRule },

    // Walidator: same kody, bez treści
    warningCodes: { type: [String], default: [] },
    errorCodes: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// TTL na createdAt — jednocześnie pełni rolę indeksu { createdAt } do raportów
// (drugi indeks o tym samym kluczu, ale bez TTL, kolidowałby z nim w MongoDB).
aiUsageLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: AI_USAGE_LOG_TTL_SECONDS },
);
aiUsageLogSchema.index({ userId: 1, createdAt: 1 });

const AiUsageLog = mongoose.model("AiUsageLog", aiUsageLogSchema);

export default AiUsageLog;
