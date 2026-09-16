import mongoose from "mongoose";

// Wartości z motivationOptions.js – trzymaj synchronizację
const STATED_MOTIVATIONS = [
  "spodziewam się wzrostu ceny",
  "spodziewam się spadku ceny / chcę ograniczyć stratę",
  "chcę zrealizować dotychczasowy zysk",
  "boję się zrealizować zysk lub stratę (unikam decyzji)",
  "nowe informacje o spółce zmieniły moją ocenę",
  "podążam za tym, co robią inni inwestorzy",
  "chcę zmniejszyć ryzyko ekspozycji",
  "świadomie nic nie zmieniam na razie (teza wciąż aktualna)",
  "zapomniałem / nie śledziłem aktywnie",
  "inny powód",
];

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
    actionType: {
      type: String,
      enum: ["open", "add", "reduce", "hold", "close"],
      required: true,
    },
    // Walidacja ilości odbywa się w kontrolerze (atomowo)
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    // Cena transakcji podana przez użytkownika – źródło prawdy
    executionPrice: {
      type: Number,
      // required tylko poza hold – sprawdzamy w kontrolerze
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

// Indeks do szybkiego pobierania historii pozycji
actionSchema.index({ positionId: 1, actionDate: 1 });
actionSchema.index({ positionId: 1, createdAt: 1 });

const Action = mongoose.model("Action", actionSchema);

export default Action;
