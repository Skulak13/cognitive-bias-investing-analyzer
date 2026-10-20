/**
 * Błąd z jawnym statusem HTTP i (opcjonalnie) kodem aplikacyjnym.
 *
 * Kod aplikacyjny trzymamy w osobnej właściwości `appCode`, a NIE w `err.code`:
 * `err.code` jest już używane przez Mongo (np. 11000 = duplikat) i przez Node
 * (np. "ECONNRESET"), więc `errorHandler` rozpoznawałby je błędnie.
 * `errorHandler` dodaje `appCode` do odpowiedzi jako pole `code`.
 */
export function appError(status, message, appCode) {
  const err = new Error(message);
  err.status = status;
  if (typeof appCode === "string" && appCode.length > 0) {
    err.appCode = appCode;
  }
  return err;
}
