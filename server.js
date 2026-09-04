import "dotenv/config";
import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import decisionRoutes from "./routes/decisionRoutes.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Trasy
app.get("/", (req, res) => {
  res.send("API działa poprawnie 🚀");
});

app.use("/api/decisions", decisionRoutes);

// Start serwera
const startServer = async () => {
  try {
    await connectDB();

    const PORT = process.env.PORT || 5000;

    app.listen(PORT, () => {
      console.log(`Serwer działa na porcie ${PORT}`);
    });
  } catch (error) {
    console.error("Nie udało się uruchomić serwera:", error);
    process.exit(1);
  }
};

startServer();
