import "dotenv/config";
import connectDB from "./config/db.js";
import app from "./app.js";
import { describeStartupConfig } from "./config/aiConfig.js";
import { aiAnalysisService } from "./services/aiAnalysisService.js";
import { aiOrchestrator } from "./services/aiOrchestrator.js";

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

  // Stan AI i rejestracji w logu startowym (bez sekretów). Brak GEMINI_API_KEY
  // lub AI_ENABLED NIE blokuje startu — AI jest wtedy po prostu wyłączone.
  const startup = describeStartupConfig();
  startup.lines.forEach((line) => console.log(line));
  startup.warningLines.forEach((line) => console.warn(line));

  try {
    await connectDB();

    // Wykonawca analiz (Etap 8.9): podłączany PRZED odzyskiwaniem i przeglądem cyklicznym,
    // bo to one mogą uruchomić oczekującą analizę końcową. Jeden mechanizm — serwis stanu
    // (8.6) rezerwuje i wywołuje tego wykonawcę, a po nim sam sprawdza analizę końcową.
    aiAnalysisService.setExecutor(aiOrchestrator.executeFullAnalysis);

    // Odzyskiwanie po restarcie (Etap 8.6.4): po połączeniu z bazą, PRZED listen.
    // Zakłada JEDNĄ instancję serwera — żadna wcześniejsza analiza nie może już
    // trwać, więc każde `pending` zamieniamy na `failed`/`server_restart`.
    // Przy wielu instancjach tej metody nie wolno użyć bez zmiany (plan 6.3, sekcja 9).
    // Błąd odzyskiwania nie zatrzymuje serwera — próbuje dalej przegląd cykliczny.
    try {
      const recovered = await aiAnalysisService.recoverAfterRestart();
      console.log(
        `Odzyskiwanie analiz AI: przerwane → failed: ${recovered.failedPending}, ` +
          `przywrócone znaczniki analizy końcowej: ${recovered.restoredMarkers}`,
      );
    } catch (error) {
      // Przegląd cykliczny ponawia odzyskiwanie startowe, aż się powiedzie.
      console.error(
        "Odzyskiwanie analiz AI po restarcie nie powiodło się (zostanie ponowione):",
        error.message,
      );
    }

    const PORT = process.env.PORT || 5000;
    const server = app.listen(PORT, () => {
      console.log(`Serwer działa na porcie ${PORT}`);
    });

    // Lekki przegląd cykliczny (timer z unref — nie blokuje zamknięcia procesu).
    // Przegląd zamyka przeterminowane `pending` i podejmuje oczekującą analizę końcową
    // (wykonawca jest podłączony wyżej).
    const recovery = aiAnalysisService.startRecoveryScheduler();
    server.on("close", () => recovery.stop());
  } catch (error) {
    console.error("Nie udało się uruchomić serwera:", error.message);
    process.exit(1);
  }
};

startServer();
