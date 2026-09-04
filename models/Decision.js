import mongoose from "mongoose";

const decisionSchema = new mongoose.Schema(
  {
    ticker: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 1,
      maxlength: 10,
    },
    decisionType: {
      type: String,
      enum: ["buy", "sell", "hold"],
      required: true,
    },
    motivation: {
      type: String,
      required: true,
      trim: true,
    },
    reasoning: {
      type: String,
      required: true,
      trim: true,
    },
    priceAtDecision: {
      type: Number,
      required: true,
    },
    followUpDate: {
      type: Date,
      default: null,
    },
    priceAfterFollowUp: {
      type: Number,
      default: null,
    },
    result: {
      type: String,
      enum: ["gain", "loss", "neutral", null],
      default: null,
    },

    // AI analyses (added later)
    quickAnalysis: {
      type: String,
      default: null,
    },
    fullAnalysis: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const Decision = mongoose.model("Decision", decisionSchema);

export default Decision;
