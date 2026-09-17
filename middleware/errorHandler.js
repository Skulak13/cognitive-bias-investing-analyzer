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
export const errorHandler = (err, req, res, next) => {
  // Błędy walidacji Mongoose (np. brak wymaganego pola, wartość spoza enuma)
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ error: messages.join(", ") });
  }

  // Nieprawidłowy format ObjectId w parametrze trasy (np. /api/positions/abc)
  if (err.name === "CastError") {
    return res.status(400).json({ error: "Nieprawidłowy format ID" });
  }

  // Naruszenie unikalności pola (np. rejestracja na zajęty e-mail)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || "pole";
    return res
      .status(409)
      .json({ error: `Wartość pola "${field}" jest już zajęta` });
  }

  // Błędy z jawnie ustawionym statusem (patrz przykład w komentarzu wyżej)
  const status = typeof err.status === "number" ? err.status : 500;

  // Nieoczekiwane błędy (status 500) logujemy po stronie serwera —
  // ale nigdy nie wysyłamy ich szczegółów (stack trace, wiadomość biblioteki) do klienta
  if (status === 500) {
    console.error("Nieobsłużony błąd:", err);
  }

  res.status(status).json({
    error: status === 500 ? "Wystąpił błąd serwera" : err.message,
  });
};
