import "dotenv/config";
import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/authRoutes.js";
import positionsRoutes from "./routes/positions.routes.js";
import adminRoutes from "./routes/admin.routes.js";

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

// Start serwera
const startServer = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("Brak MONGODB_URI w pliku .env");
    process.exit(1);
  }

  // JWT_SECRET będzie potrzebny dopiero od Etapu 3 (auth).
  // Na etapie 0–1 możesz go jeszcze nie wymagać.
  // Gdy dojdziesz do auth — dodaj:
  // if (!process.env.JWT_SECRET) {
  //   console.error("Brak JWT_SECRET w pliku .env");
  //   process.exit(1);
  // }

  try {
    await connectDB();

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Serwer działa na porcie ${PORT}`);
    });
  } catch (error) {
    console.error("Nie udało się uruchomić serwera:", error.message);
    process.exit(1);
  }
};

startServer();
