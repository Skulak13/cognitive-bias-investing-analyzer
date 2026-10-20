export const notFound = (req, res, next) => {
  res
    .status(404)
    .json({ error: `Nie znaleziono trasy: ${req.method} ${req.originalUrl}` });
};

/**
 * Globalny obsługiwacz błędów. Rejestrowany jako OSTATNI middleware w server.js.
 *
 * Express 5 sam przekazuje tu błędy rzucone (throw) lub odrzucone (reject)
 * wewnątrz funkcji async w kontrolerach — nie trzeba już ręcznie owijać
 * każdego kontrolera w try/catch, wystarczy rzucić błąd i on tu trafi.
 *
 * Przykład w przyszłym kontrolerze:
 *   const position = await Position.findOne({ _id: id, userId, deletedAt: null });
 *   if (!position) {
 *     const err = new Error("Nie znaleziono pozycji");
 *     err.status = 404;
 *     throw err;
 *   }
 */
// Wysyła odpowiedź błędu. Kod aplikacyjny (np. "ai_disabled") pochodzi z odrębnego
// pola `appCode`, NIE z `err.code` (to pole zajmuje m.in. Mongo: 11000). Dodajemy go
// we WSZYSTKICH gałęziach; brak kodu = dotychczasowy kształt { error }.
const send = (res, err, status, message) => {
  const body = { error: message };
  if (typeof err.appCode === "string" && err.appCode.length > 0) {
    body.code = err.appCode;
  }
  return res.status(status).json(body);
};

export const errorHandler = (err, req, res, next) => {
  // Błędy walidacji Mongoose (np. brak wymaganego pola, wartość spoza enuma)
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return send(res, err, 400, messages.join(", "));
  }

  // Nieprawidłowy format ObjectId w parametrze trasy (np. /api/positions/abc)
  if (err.name === "CastError") {
    return send(res, err, 400, "Nieprawidłowy format ID");
  }

  // Naruszenie unikalności pola (np. rejestracja na zajęty e-mail)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || "pole";
    return send(res, err, 409, `Wartość pola "${field}" jest już zajęta`);
  }

  // Błędy z jawnie ustawionym statusem (patrz przykład w komentarzu wyżej)
  const status = typeof err.status === "number" ? err.status : 500;

  // Nieoczekiwane błędy (status 500) logujemy po stronie serwera —
  // ale nigdy nie wysyłamy ich szczegółów (stack trace, wiadomość biblioteki) do klienta
  if (status === 500) {
    console.error("Nieobsłużony błąd:", err);
  }

  send(
    res,
    err,
    status,
    status === 500 ? "Wystąpił błąd serwera" : err.message,
  );
};
