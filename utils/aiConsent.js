/**
 * Ważność zgody na przekazanie danych do Google (Etap 8.5, D8-16, plan 6.10).
 *
 * Zgoda jest ważna tylko wtedy, gdy użytkownik:
 *  - zaakceptował disclaimer (`disclaimerAcceptedAt` to poprawna data) ORAZ
 *  - zrobił to dla AKTUALNEJ wersji tekstu (`disclaimerVersion` === wersja z konfiguracji).
 *
 * Zgoda sprzed wprowadzenia wersji (`disclaimerVersion = null`) jest nieważna
 * (zatwierdzone 18.10.2026) — użytkownik musi zaakceptować ponownie.
 *
 * Czysta funkcja bez bazy i sieci. Używa jej middleware `ensureAiAccessible`,
 * a później serwis analizy (powód `consent_missing` przy analizie po `close`,
 * która nie przechodzi przez middleware) — jedno miejsce reguły, bez duplikacji.
 *
 * @param {{disclaimerAcceptedAt?: unknown, disclaimerVersion?: unknown} | null | undefined} user
 * @param {string} currentVersion aktualna wersja zgody (getAiConfig().consentVersion)
 * @returns {boolean}
 */
export function hasValidAiConsent(user, currentVersion) {
  if (!user || typeof currentVersion !== "string" || currentVersion === "") {
    return false;
  }

  const acceptedAt = user.disclaimerAcceptedAt;
  if (!(acceptedAt instanceof Date) || Number.isNaN(acceptedAt.getTime())) {
    return false;
  }

  return (
    typeof user.disclaimerVersion === "string" &&
    user.disclaimerVersion === currentVersion
  );
}
