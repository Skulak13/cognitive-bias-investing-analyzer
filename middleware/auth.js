import jwt from "jsonwebtoken";

/**
 * Dekoduje token z nagłówka Authorization: Bearer <token>.
 * Ustawia req.userId (filtr w KAŻDYM zapytaniu do bazy — sekcja 8.1)
 * i req.email (żeby middleware/adminOnly.js nie musiał dociągać usera
 * z bazy tylko po to, by sprawdzić jeden adres).
 */
export const auth = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Brak tokena autoryzacyjnego" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.userId = decoded.userId;
    req.email = decoded.email;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token wygasł" });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Nieprawidłowy token" });
    }

    return res.status(401).json({ error: "Błąd autoryzacji" });
  }
};
