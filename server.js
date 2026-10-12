import "dotenv/config";
import connectDB from "./config/db.js";
import app from "./app.js";

// Start serwera
const startServer = async () => {
  if (!process.env.MONGODB_URI) {
    console.error("Brak MONGODB_URI w pliku .env");
    process.exit(1);
  }

  // Bez JWT_SECRET serwer wstałby "poprawnie", a błąd ujawniłby się dopiero
  // przy pierwszym logowaniu lub żądaniu z tokenem (jako mylący 401/500).
  if (!process.env.JWT_SECRET) {
    console.error("Brak JWT_SECRET w pliku .env");
    process.exit(1);
  }

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
