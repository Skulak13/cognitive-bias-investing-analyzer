/**
 * Etap 3b (opcjonalny — sekcja 0 pkt 5).
 * Gate przez ADMIN_EMAIL z .env, NIE przez pole/rolę w bazie (sekcja 8.7).
 * Rejestrowany ZAWSZE po middleware/auth.js — potrzebuje req.email.
 */
export const adminOnly = (req, res, next) => {
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!adminEmail || req.email !== adminEmail) {
    return res.status(403).json({ error: "Brak uprawnień administratora" });
  }

  next();
};
