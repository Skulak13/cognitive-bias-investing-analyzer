import mongoose from "mongoose";
import Position from "../models/Position.js";
import Action from "../models/Action.js";
import { toTradingDateRef } from "../utils/tradingCalendar.js";
import {
  validateStaticQuantity,
  buildActionUpdate,
} from "../utils/actionInvariants.js";

/**
 * Tworzy błąd z jawnym statusem HTTP — patrz middleware/errorHandler.js (Etap 1).
 */
function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * POST /api/positions
 * Otwiera nową pozycję + zapisuje pierwszą akcję "open" — w jednej
 * transakcji ACID. To NIE jest przypadek objęty przez buildActionUpdate:
 * tworzymy nowy dokument Position, więc nie ma istniejącego stanu,
 * o który można by się wyścigowo pobić — zwykły Position.create()
 * wewnątrz sesji transakcyjnej wystarczy.
 *
 * (Etap 2: brak ensureAiAccessible, brak wywołań AI — to Etap 8.)
 */
export const createPosition = async (req, res) => {
  const {
    ticker,
    quantity,
    executionPrice,
    marketPriceAtDecision,
    actionDate,
    statedMotivation,
    reasoning,
    expectedOutcome,
  } = req.body;

  // 1. Obecność wymaganych pól
  if (
    !ticker ||
    executionPrice === undefined ||
    !actionDate ||
    !statedMotivation
  ) {
    throw fail(
      400,
      "Brak wymaganych pól: ticker, executionPrice, actionDate, statedMotivation",
    );
  }

  // 2. Typy danych
  if (typeof executionPrice !== "number") {
    throw fail(400, "executionPrice musi być liczbą");
  }

  // 3. Format daty
  if (isNaN(new Date(actionDate).getTime())) {
    throw fail(400, "Nieprawidłowy format actionDate");
  }

  // 4. Inwariant ilości
  const quantityError = validateStaticQuantity("open", quantity);
  if (quantityError) throw fail(400, quantityError);

  const session = await mongoose.startSession();
  let position;
  let action;

  try {
    await session.withTransaction(async () => {
      [position] = await Position.create(
        [
          {
            userId: req.userId,
            ticker,
            status: "open",
            openedAt: actionDate,
            currentQuantity: quantity,
          },
        ],
        { session },
      );

      [action] = await Action.create(
        [
          {
            positionId: position._id,
            userId: req.userId,
            actionType: "open",
            quantity,
            executionPrice,
            marketPriceAtDecision,
            actionDate,
            tradingDateRef: toTradingDateRef(actionDate),
            statedMotivation,
            reasoning,
            reasoningAddedAt: reasoning ? new Date() : null,
            expectedOutcome,
          },
        ],
        { session },
      );
    });
  } finally {
    // endSession ZAWSZE, niezależnie od tego, czy transakcja się powiodła —
    // inaczej zostawiamy otwartą sesję przy każdym błędzie.
    await session.endSession();
  }

  res.status(201).json({ position, action });
};

/**
 * POST /api/positions/:id/actions
 * Dodaje akcję add/reduce/hold/close do ISTNIEJĄCEJ pozycji.
 * Właściwy wzorzec z sekcji 7.2: atomowa aktualizacja Position.currentQuantity
 * (inwariant wbudowany w filtr — patrz buildActionUpdate) + zapis Action
 * w tej samej sesji. Jeśli findOneAndUpdate nie znajdzie dopasowania (bo
 * quantity łamie inwariant, pozycja nie istnieje/nie należy do usera/jest
 * zamknięta/usunięta), rzucamy błąd WEWNĄTRZ withTransaction — Mongo
 * automatycznie wycofuje wszystko, co się zdążyło zapisać w tej sesji.
 */
export const addAction = async (req, res) => {
  const { id: positionId } = req.params;
  const {
    actionType,
    quantity,
    executionPrice,
    marketPriceAtDecision,
    actionDate,
    statedMotivation,
    reasoning,
    expectedOutcome,
  } = req.body;

  if (!["add", "reduce", "hold", "close"].includes(actionType)) {
    throw fail(
      400,
      `Nieobsługiwany actionType dla tego endpointu: "${actionType}". ` +
        "Nową pozycję (open) twórz przez POST /api/positions.",
    );
  }

  const quantityError = validateStaticQuantity(actionType, quantity);
  if (quantityError) throw fail(400, quantityError);

  if (actionType !== "hold" && executionPrice === undefined) {
    throw fail(
      400,
      `executionPrice jest wymagane dla actionType "${actionType}"`,
    );
  }

  if (actionType !== "hold" && typeof executionPrice !== "number") {
    throw fail(400, "executionPrice musi być liczbą");
  }

  if (!actionDate || !statedMotivation) {
    throw fail(400, "Brak wymaganych pól: actionDate, statedMotivation");
  }

  if (isNaN(new Date(actionDate).getTime())) {
    throw fail(400, "Nieprawidłowy format actionDate");
  }

  const { filter, update } = buildActionUpdate(
    actionType,
    quantity,
    req.userId,
    positionId,
  );

  const session = await mongoose.startSession();
  let position;
  let action;

  try {
    await session.withTransaction(async () => {
      position = await Position.findOneAndUpdate(filter, update, {
        new: true,
        session,
      });

      if (!position) {
        // Brak dopasowania = naruszenie inwariantu ilości ALBO pozycja
        // niedostępna (nie istnieje / nie należy do usera / zamknięta /
        // usunięta). Rzucenie tutaj wymusza rollback całej transakcji —
        // Action poniżej nigdy się nie zapisze.
        throw fail(409, "Naruszenie inwariantu ilości lub pozycja niedostępna");
      }

      [action] = await Action.create(
        [
          {
            positionId,
            userId: req.userId, // denormalizacja z Position — 4.2, 8.5
            actionType,
            quantity,
            executionPrice,
            marketPriceAtDecision,
            actionDate,
            tradingDateRef: toTradingDateRef(actionDate),
            statedMotivation,
            reasoning,
            reasoningAddedAt: reasoning ? new Date() : null,
            expectedOutcome,
          },
        ],
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  res.status(201).json({ position, action });
};

/**
 * GET /api/positions
 * Lista własnych, nieusuniętych pozycji.
 */
export const getPositions = async (req, res) => {
  const positions = await Position.find({
    userId: req.userId,
    deletedAt: null,
  }).sort({ createdAt: -1 });

  res.json(positions);
};

/**
 * GET /api/positions/:id
 * 404, nie 403, jeśli pozycja należy do innego usera — nie zdradzamy
 * czy w ogóle istnieje (sekcja 5 planu).
 */
export const getPositionById = async (req, res) => {
  const position = await Position.findOne({
    _id: req.params.id,
    userId: req.userId,
    deletedAt: null,
  });

  if (!position) throw fail(404, "Nie znaleziono pozycji");

  res.json(position);
};

/**
 * DELETE /api/positions/:id
 * Soft-delete — ustawia deletedAt, nigdy nie usuwa dokumentu fizycznie.
 */
export const softDeletePosition = async (req, res) => {
  const position = await Position.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId, deletedAt: null },
    { $set: { deletedAt: new Date() } },
    { new: true },
  );

  if (!position) throw fail(404, "Nie znaleziono pozycji");

  res.status(204).send();
};
