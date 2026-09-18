import mongoose from "mongoose";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const aiUsageSchema = new mongoose.Schema(
  {
    // "YYYY-MM-DD", UTC — patrz sekcja 7.3 (Etap 8). null dopóki użytkownik
    // nie odpali pierwszego wywołania AI.
    date: { type: String, default: null },
    quickCheckCount: { type: Number, default: 0 },
    analysisCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [EMAIL_RE, "Nieprawidłowy format adresu e-mail"],
    },
    passwordHash: {
      type: String,
      required: true,
    },
    // WERSJA TESTOWA (sekcja 0, pkt 1): authController.register ustawia to
    // na new Date() OD RAZU — brak wysyłki maila, brak /verify-email.
    // Pole zostaje w schemacie (forward-compatible z pełnym v7): gdy
    // wrócisz do prawdziwej weryfikacji, nie potrzebujesz migracji, tylko
    // przestajesz je ustawiać automatycznie przy rejestracji.
    emailVerifiedAt: {
      type: Date,
      default: null,
    },
    // Warunek bramki AI (Etap 8, middleware/ensureAiAccessible.js) —
    // null dopóki użytkownik nie zaakceptuje disclaimera.
    disclaimerAcceptedAt: {
      type: Date,
      default: null,
    },
    aiUsage: {
      type: aiUsageSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

const User = mongoose.model("User", userSchema);

export default User;
