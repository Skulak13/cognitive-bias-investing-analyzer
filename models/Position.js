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
    // Niemutowalna migawka akcji + reasoning w chwili wykonania analizy
    inputSnapshot: {
      actions: { type: mongoose.Schema.Types.Mixed },
      capturedAt: { type: Date },
    },
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
      enum: ["pending", "success", "failed", null],
      default: null,
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
