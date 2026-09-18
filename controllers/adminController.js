import User from "../models/User.js";

/**
 * GET /api/admin/usage
 * Etap 3b (opcjonalny — sekcja 8.7). Zużycie AI wszystkich userów za
 * dzisiaj: [{email, quickCheckCount, analysisCount}]. Puste, dopóki
 * nikt nie odpalił jeszcze AI (Etap 8) — to nic nie psuje, po prostu
 * zwraca pustą tablicę.
 */
export const getUsage = async (req, res) => {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC

  const users = await User.find(
    { "aiUsage.date": today },
    { email: 1, aiUsage: 1, _id: 0 },
  );

  const usage = users.map((u) => ({
    email: u.email,
    quickCheckCount: u.aiUsage?.quickCheckCount ?? 0,
    analysisCount: u.aiUsage?.analysisCount ?? 0,
  }));

  res.json(usage);
};
