import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const SALT_ROUNDS = 10;

export const register = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Wymagana jest nazwa użytkownika i hasło" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Hasło musi mieć minimum 6 znaków" });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Nazwa użytkownika jest już zajęta" });
    }

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await User.create({
      username,
      password: hashed,
    });

    res.status(201).json({
      message: "Użytkownik utworzony",
      userId: user._id,
    });
  } catch (error) {
    console.error("Błąd rejestracji:", error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Nie udało się utworzyć użytkownika" });
  }
};

export const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Wymagana jest nazwa użytkownika i hasło" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res
        .status(400)
        .json({ error: "Nieprawidłowa nazwa użytkownika lub hasło" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res
        .status(400)
        .json({ error: "Nieprawidłowa nazwa użytkownika lub hasło" });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({ token });
  } catch (error) {
    console.error("Błąd logowania:", error);
    res.status(500).json({ error: "Nie udało się zalogować" });
  }
};
