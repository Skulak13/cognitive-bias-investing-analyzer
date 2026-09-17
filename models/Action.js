import mongoose from "mongoose";
import { STATED_MOTIVATIONS } from "../utils/motivationOptions.js";

const earlyAiCheckSchema = new mongoose.Schema(
  {
    analyzedAt: { type: Date, required: true },
    summary: { type: String, required: true },
    possibleBiases: [{ type: String }], // uproszczona lista (tylko nazwy)
    limitations: { type: String, default: "" },
    aiModelVersion: { type: String, required: true },
    promptVersion: { type: String },
  },
  { _id: false },
);

const actionSchema = new mongoose.Schema(
  {
    positionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Position",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actionType: {
      type: String,
      enum: ["open", "add", "reduce", "hold", "close"],
      required: true,
    },
    // Sam typ liczbowy waliduje schemat. Inwariant WZGLĘDEM currentQuantity
    // pozycji nadrzędnej (np. reduce < currentQuantity) jest egzekwowany
    // atomowo w kontrolerze przez utils/actionInvariants.js — schemat
    // pojedynczego dokumentu Action nie zna stanu Position.
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    // Cena transakcji podana przez użytkownika – źródło prawdy
    executionPrice: {
      type: Number,
      // required tylko poza "hold" — zależy od actionType, więc sprawdzane
      // w kontrolerze (validateStaticQuantity nie odpowiada za to pole)
      min: 0,
    },
    // Cena rynkowa pobrana automatycznie w momencie zapisu (informacyjna)
    marketPriceAtDecision: {
      type: Number,
      min: 0,
    },
    actionDate: {
      type: Date,
      required: true, // UTC
    },
    // Dzień sesji giełdowej – wyliczany raz przy zapisie przez tradingCalendar.js
    tradingDateRef: {
      type: Date,
      required: true,
    },
    statedMotivation: {
      type: String,
      enum: STATED_MOTIVATIONS,
      required: true,
    },
    reasoning: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
    reasoningAddedAt: {
      type: Date,
      default: null,
    },
    expectedOutcome: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    earlyAiCheck: {
      type: earlyAiCheckSchema,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Historia akcji danej pozycji w porządku chronologicznym
actionSchema.index({ positionId: 1, actionDate: 1 });
actionSchema.index({ positionId: 1, createdAt: 1 });
// Parent-Child Guard (Etap 6): {_id, positionId, userId} jednym zapytaniem
actionSchema.index({ positionId: 1, userId: 1 });

const Action = mongoose.model("Action", actionSchema);

export default Action;
