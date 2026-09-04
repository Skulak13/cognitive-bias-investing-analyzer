import Decision from "../models/Decision.js";

// CREATE
export const createDecision = async (req, res) => {
  try {
    const decision = await Decision.create(req.body);
    res.status(201).json(decision);
  } catch (error) {
    console.error("Błąd przy tworzeniu decyzji:", error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: "Nie udało się utworzyć decyzji" });
  }
};

// READ — wszystkie
export const getDecisions = async (req, res) => {
  try {
    const decisions = await Decision.find().sort({ createdAt: -1 });
    res.json(decisions);
  } catch (error) {
    console.error("Błąd przy pobieraniu decyzji:", error);
    res.status(500).json({ error: "Nie udało się pobrać decyzji" });
  }
};

// READ — jedna
export const getDecisionById = async (req, res) => {
  try {
    const decision = await Decision.findById(req.params.id);

    if (!decision) {
      return res.status(404).json({ error: "Nie znaleziono decyzji" });
    }

    res.json(decision);
  } catch (error) {
    console.error("Błąd przy pobieraniu decyzji:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Nieprawidłowy format ID" });
    }

    res.status(500).json({ error: "Nie udało się pobrać decyzji" });
  }
};
