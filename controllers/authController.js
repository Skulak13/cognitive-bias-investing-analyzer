import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const SALT_ROUNDS = 10;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function signToken(user) {
  return jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
}

/**
 * POST /api/auth/register
 * WERSJA TESTOWA (sekcja 0, pkt 1): emailVerifiedAt ustawiane od razu,
 * brak wysyłki maila. Format e-maila waliduje schemat (models/User.js,
 * pole `match`) — nie duplikujemy tego sprawdzenia tutaj; jeśli nie
 * przejdzie, Mongoose rzuci ValidationError, a Etap 1 (errorHandler)
 * zamieni to na czytelne 400.
 */
export const register = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw fail(400, "Wymagany jest e-mail i hasło");
  }

  // Min. 8 znaków (sekcja 8.2) — MUSI być sprawdzone PRZED hashowaniem:
  // po zahaszowaniu długość surowego hasła jest już nieodzyskiwalna,
  // więc to jedyny moment, w którym da się to w ogóle zweryfikować.
  if (password.length < 8) {
    throw fail(400, "Hasło musi mieć minimum 8 znaków");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Duplikat e-maila -> błąd Mongo 11000, złapany centralnie przez
  // errorHandler (Etap 1) -> 409 z czytelnym komunikatem. Celowo bez
  // osobnego User.findOne() przed zapisem: unikalny indeks w bazie to
  // jedyne miejsce, które naprawdę wyklucza wyścig dwóch równoczesnych
  // rejestracji na ten sam adres.
  const user = await User.create({
    email,
    passwordHash,
    emailVerifiedAt: new Date(), // różnica względem pełnego v7
  });

  const token = signToken(user);

  res.status(201).json({
    token,
    user: { id: user._id, email: user.email },
  });
};

/**
 * POST /api/auth/login
 * WERSJA TESTOWA: brak guardu na emailVerifiedAt — jest zawsze ustawione.
 */
export const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw fail(400, "Wymagany jest e-mail i hasło");
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });

  // Ten sam, generyczny komunikat niezależnie od tego, czy e-mail istnieje
  // w bazie, czy hasło jest złe — nie zdradzamy, które z dwóch zawiodło
  // (ochrona przed wyliczaniem kont, duch sekcji 8.3, dotyczy też loginu).
  if (!user) {
    throw fail(401, "Nieprawidłowy e-mail lub hasło");
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw fail(401, "Nieprawidłowy e-mail lub hasło");
  }

  const token = signToken(user);

  res.json({
    token,
    user: {
      id: user._id,
      email: user.email,
      disclaimerAcceptedAt: user.disclaimerAcceptedAt,
    },
  });
};

/**
 * POST /api/auth/accept-disclaimer
 * JWT. Zapisuje disclaimerAcceptedAt — jeden z warunków bramki AI
 * (Etap 8, middleware/ensureAiAccessible.js).
 */
export const acceptDisclaimer = async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: { disclaimerAcceptedAt: new Date() } },
    { new: true },
  );

  if (!user) throw fail(404, "Nie znaleziono użytkownika");

  res.json({ disclaimerAcceptedAt: user.disclaimerAcceptedAt });
};
