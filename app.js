import express from "express";
import cors from "cors";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/auth.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import adminRoutes from "./routes/admin.routes.js";

/**
 * Sama aplikacja Express: middleware, trasy i obsługa błędów.
 *
 * Ten plik celowo NIE łączy się z bazą, NIE nasłuchuje na porcie i NIE
 * ładuje pliku .env. Dzięki temu testy mogą zaimportować `app`, uruchomić
 * go na losowym porcie i wysyłać prawdziwe żądania HTTP (przez router,
 * middleware auth i errorHandler) bez startowania całego serwera.
 * Uruchamianie (baza, kontrola zmiennych środowiskowych, listen) jest w server.js.
 */
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Trasy
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "API działa poprawnie 🚀" });
});

app.use("/api/auth", authRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/admin", adminRoutes);

// Obsługa błędów
// notFound i errorHandler MUSZĄ być zarejestrowane na końcu,
// po wszystkich trasach — kolejność w Express ma znaczenie.
app.use(notFound);
app.use(errorHandler);

export default app;
