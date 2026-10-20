import mongoose from "mongoose";

const possibleBiasSchema = new mongoose.Schema(
  {
    bias: {
      type: String,
      required: true,
      // wartości z biasList.js + "inne / nieskatalogowane"
    },
    proposedLabel: {
      type: String, // tylko gdy bias === "inne / nieskatalogowane"
    },
    confidence: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
    },
    supportingEvidence: { type: String, required: true },
    contradictingEvidence: { type: String, default: "" },
  },
  { _id: false },
);

const aiAnalysisSchema = new mongoose.Schema(
  {
    analyzedAt: { type: Date, required: true, default: Date.now },
    analysisType: {
      type: String,
      enum: ["interim", "final"],
      required: true,
    },
    // Niemutowalna migawka danych rynkowych użytych do tej konkretnej analizy
    marketContextSnapshot: {
      priceHistory: { type: mongoose.Schema.Types.Mixed },
      newsHighlights: { type: mongoose.Schema.Types.Mixed },
      fetchedAt: { type: Date },
    },
    // Identyfikator uruchomienia analizy (Etap 8, 6.3) — łączy wpis z rekordami
    // AiUsageLog i z rezerwacją na Position (lastAnalysisRunId).
    analysisRunId: { type: String },
    // Niemutowalna migawka danych użytych w analizie. Mixed, bo istnieją dwa
    // kształty (oba muszą się wczytywać i zapisywać bez zmian):
    //   stary (Etap 2–7): { actions, capturedAt }
    //   nowy  (Etap 8, 6.6): { modelInput, meta, capturedAt }
    inputSnapshot: { type: mongoose.Schema.Types.Mixed },
    summary: { type: String, required: true },
    observedPatterns: [{ type: String }],
    possibleBiases: [possibleBiasSchema],
    alternativeExplanations: [{ type: String }],
    limitations: { type: String, default: "" },
    outcomeNote: { type: String, default: "" }, // wynik finansowy – zawsze osobno
    aiModelVersion: { type: String, required: true },
    promptVersion: { type: String },
  },
  { _id: true }, // każda analiza ma własne _id (łatwiejsze referencje)
);

const postCloseOutcomeSchema = new mongoose.Schema(
  {
    checkedAt: { type: Date, required: true, default: Date.now },
    price: { type: Number, required: true },
  },
  { _id: false },
);

const positionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    ticker: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 12,
    },
    status: {
      type: String,
      enum: ["open", "closed"],
      required: true,
      default: "open",
      index: true,
    },
    openedAt: {
      type: Date,
      required: true,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    // Aktualizowane WYŁĄCZNIE atomowo (findOneAndUpdate)
    currentQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    analyses: {
      type: [aiAnalysisSchema],
      default: [],
    },
    postCloseOutcome: {
      type: [postCloseOutcomeSchema],
      default: [],
    },
    possibleSplitsNote: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    lastAnalyzedAt: {
      type: Date,
      default: null,
    },
    lastAnalysisStatus: {
      type: String,
      enum: ["pending", "success", "failed", "skipped", null],
      default: null,
    },
    // Etap 8 (6.12) — pola pomocnicze analizy; wszystkie opcjonalne, więc
    // istniejące dokumenty pozostają poprawne bez migracji.
    lastAnalysisReason: { type: String, default: null },
    lastAnalysisRunId: { type: String, default: null },
    lastAnalysisStartedAt: { type: Date, default: null },
    // Trwałe żądanie analizy końcowej po `close` (D8-27, 6.3.1).
    finalAnalysisRequestedAt: { type: Date, default: null },
    finalAnalysisAttempts: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "{PATH} musi być liczbą całkowitą",
      },
    },
    // Soft-delete
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Indeksy złożone – często używane filtry
positionSchema.index({ userId: 1, deletedAt: 1, status: 1 });
positionSchema.index({ userId: 1, deletedAt: 1, lastAnalyzedAt: -1 });
positionSchema.index({ userId: 1, ticker: 1, deletedAt: 1 });

const Position = mongoose.model("Position", positionSchema);

export default Position;
