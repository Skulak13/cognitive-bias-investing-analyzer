import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { appError } from "../utils/appError.js";
import { getAiConfig, isRegistrationClosed } from "../config/aiConfig.js";

const SALT_ROUNDS = 10;

// Błąd z kodem HTTP i opcjonalnym kodem aplikacyjnym (patrz utils/appError.js).
const fail = appError;

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
  // Zamknięcie rejestracji (D8-04) sprawdzamy NA POCZĄTKU — przed walidacją
  // i przed kosztownym bcrypt.hash. Logowanie (login) tego nie dotyczy.
  if (isRegistrationClosed()) {
    throw fail(
      403,
      "Rejestracja nowych kont jest obecnie zamknięta",
      "registration_closed",
    );
  }

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
 * POST /api/auth/accept-disclaimer   body: { version: "<wersja wyświetlonego tekstu>" }
 * JWT. Zapisuje disclaimerAcceptedAt RAZEM z wersją tekstu zgody (Etap 8.5.2,
 * D8-16) — warunek bramki AI (middleware/ensureAiAccessible.js).
 *
 * Wersja jest wymagana i musi być DOKŁADNIE równa aktualnej (AI_CONSENT_VERSION,
 * domyślnie "1"): zapisujemy to, co użytkownik faktycznie zobaczył, a nie
 * wersję "domyślną" wybraną po cichu przez serwer. Zgoda złożona dla
 * nieaktualnego tekstu nie jest zapisywana. Ponowna akceptacja nadpisuje
 * poprzednią (tak odnawia się zgodę po zmianie wersji tekstu).
 */
export const acceptDisclaimer = async (req, res) => {
  // Express 5: req.body jest undefined, gdy żądanie nie ma ciała JSON.
  const { version } = req.body ?? {};

  if (typeof version !== "string" || version === "") {
    throw fail(
      400,
      "Wymagana jest wersja akceptowanego tekstu (version)",
      "consent_version_required",
    );
  }

  const currentVersion = getAiConfig().consentVersion;
  if (version !== currentVersion) {
    throw fail(
      400,
      `Nieaktualna wersja tekstu zgody. Aktualna wersja: "${currentVersion}"`,
      "consent_version_unknown",
    );
  }

  const user = await User.findByIdAndUpdate(
    req.userId,
    { $set: { disclaimerAcceptedAt: new Date(), disclaimerVersion: version } },
    { returnDocument: "after" },
  );

  if (!user) throw fail(404, "Nie znaleziono użytkownika");

  res.json({
    disclaimerAcceptedAt: user.disclaimerAcceptedAt,
    disclaimerVersion: user.disclaimerVersion,
  });
};
