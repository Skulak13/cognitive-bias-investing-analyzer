import User from "../models/User.js";
import { getAiConfig } from "../config/aiConfig.js";
import { appError } from "../utils/appError.js";
import { hasValidAiConsent } from "../utils/aiConsent.js";

/**
 * Bramka dostępu do funkcji AI (Etap 8.5.1, v7.1 8.4, C12).
 *
 * Rejestrowana ZAWSZE po `auth` (potrzebuje `req.userId`). JWT jest bezstanowy
 * i nie mówi nic o aktualnym stanie konta, więc użytkownik jest czytany z bazy.
 *
 * Sprawdza WYŁĄCZNIE warunki konta:
 *   1. konto istnieje                       → inaczej 401 `account_not_found`
 *   2. `emailVerifiedAt` ustawione          → inaczej 403 `email_not_verified`
 *      (w wersji testowej register ustawia je zawsze — warunek zostaje w kodzie)
 *   3. zgoda ważna dla AKTUALNEJ wersji     → inaczej 403 `consent_required`
 *
 * NIE sprawdza wyłącznika AI, braku klucza ani pauzy po 429 — to robi serwis
 * analizy (C12), dzięki czemu te same reguły obowiązują analizę po `close`,
 * która middleware nie przechodzi. Brak zgody zatrzymuje żądanie tutaj, zanim
 * dotrze do serwisu i do Google (żadne dane nie opuszczają aplikacji).
 *
 * `loadUser` i `getConfig` są wstrzykiwane wyłącznie po to, by testy mogły
 * działać bez bazy; produkcyjnie używane są wartości domyślne.
 */

// Tylko pola potrzebne do decyzji — nie ciągniemy passwordHash do pamięci żądania.
const defaultLoadUser = (userId) =>
  User.findById(userId)
    .select("emailVerifiedAt disclaimerAcceptedAt disclaimerVersion")
    .lean();

export function createEnsureAiAccessible({
  loadUser = defaultLoadUser,
  getConfig = getAiConfig,
} = {}) {
  return async function ensureAiAccessible(req, res, next) {
    // Zabezpieczenie przed błędną kolejnością middleware (brak `auth` przed bramką).
    if (!req.userId) {
      throw appError(401, "Brak autoryzacji", "unauthorized");
    }

    const user = await loadUser(req.userId);

    // Poprawny token wydany dla konta, którego już nie ma.
    if (!user) {
      throw appError(401, "Konto nie istnieje", "account_not_found");
    }

    if (!user.emailVerifiedAt) {
      throw appError(
        403,
        "Adres e-mail nie został zweryfikowany",
        "email_not_verified",
      );
    }

    if (!hasValidAiConsent(user, getConfig().consentVersion)) {
      throw appError(
        403,
        "Aby korzystać z funkcji AI, zaakceptuj aktualną informację o przekazywaniu danych do Google",
        "consent_required",
      );
    }

    next();
  };
}

export const ensureAiAccessible = createEnsureAiAccessible();
