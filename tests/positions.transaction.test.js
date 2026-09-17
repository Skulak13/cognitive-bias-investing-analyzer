/**
 * Test integracyjny transakcyjnego przepływu z sekcji 7.2.
 *
 * W przeciwieństwie do tests/actionInvariants.test.js, TEN test potrzebuje
 * prawdziwego połączenia z MongoDB działającym jako replica set — bez tego
 * mongoose.startSession().withTransaction() rzuci błędem przy starcie.
 * Atlas, także na darmowym tierze M0, zawsze działa jako replica set
 * (patrz sekcja 2 i 13 planu), więc wystarczy uzupełnić MONGODB_URI w .env.
 *
 * WAŻNE: ten test tworzy i usuwa prawdziwe dokumenty. Uruchamiaj go na
 * klastrze deweloperskim/testowym, nie na czymkolwiek, na czym zależy Ci
 * na realnych danych. Sprzątanie w after() usuwa wyłącznie dokumenty
 * powiązane z TEST_USER_ID wygenerowanym poniżej, więc nie rusza niczego
 * innego w bazie.
 *
 * Uruchomienie:
 *   node --test tests/positions.transaction.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Position from "../models/Position.js";
import Action from "../models/Action.js";
import { createPosition, addAction } from "../controllers/positionsController.js";

const TEST_USER_ID = new mongoose.Types.ObjectId();

// Minimalny mock Express res — łapie status/json zamiast wysyłać HTTP.
function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

before(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error(
      "Ten test wymaga MONGODB_URI w .env — połączenia z klastrem obsługującym " +
        "transakcje (replica set; Atlas M0 zawsze nim jest).",
    );
  }
  await connectDB();
});

after(async () => {
  // Sprzątanie ograniczone do dokumentów utworzonych przez tego testowego usera
  await Action.deleteMany({ userId: TEST_USER_ID });
  await Position.deleteMany({ userId: TEST_USER_ID });
  await mongoose.connection.close();
});

test("createPosition + addAction(reduce) — happy path", async () => {
  const createRes = mockRes();
  await createPosition(
    {
      userId: TEST_USER_ID,
      body: {
        ticker: "AAPL",
        quantity: 10,
        executionPrice: 150,
        actionDate: new Date().toISOString(),
        statedMotivation: "spodziewam się wzrostu ceny",
      },
    },
    createRes,
  );

  assert.equal(createRes.statusCode, 201);
  const positionId = createRes.body.position._id;

  const reduceRes = mockRes();
  await addAction(
    {
      userId: TEST_USER_ID,
      params: { id: positionId },
      body: {
        actionType: "reduce",
        quantity: 4,
        executionPrice: 160,
        actionDate: new Date().toISOString(),
        statedMotivation: "chcę zrealizować dotychczasowy zysk",
      },
    },
    reduceRes,
  );

  assert.equal(reduceRes.statusCode, 201);
  assert.equal(reduceRes.body.position.currentQuantity, 6);

  const actionsCount = await Action.countDocuments({ positionId });
  assert.equal(actionsCount, 2); // open + reduce
});

test("addAction — naruszenie inwariantu (reduce > currentQuantity) nie zapisuje NIC", async () => {
  const createRes = mockRes();
  await createPosition(
    {
      userId: TEST_USER_ID,
      body: {
        ticker: "MSFT",
        quantity: 5,
        executionPrice: 300,
        actionDate: new Date().toISOString(),
        statedMotivation: "spodziewam się wzrostu ceny",
      },
    },
    createRes,
  );
  const positionId = createRes.body.position._id;

  await assert.rejects(
    () =>
      addAction(
        {
          userId: TEST_USER_ID,
          params: { id: positionId },
          body: {
            actionType: "reduce",
            quantity: 999, // więcej niż currentQuantity (5) — łamie inwariant
            executionPrice: 310,
            actionDate: new Date().toISOString(),
            statedMotivation: "chcę zrealizować dotychczasowy zysk",
          },
        },
        mockRes(),
      ),
    /Naruszenie inwariantu/,
  );

  const position = await Position.findById(positionId);
  assert.equal(position.currentQuantity, 5, "currentQuantity bez zmian");

  const actionsCount = await Action.countDocuments({ positionId });
  assert.equal(actionsCount, 1, "tylko pierwotna akcja open");
});

test("addAction — Action.create zawodzi PO udanej aktualizacji Position -> Position wraca do stanu sprzed (rollback)", async () => {
  const createRes = mockRes();
  await createPosition(
    {
      userId: TEST_USER_ID,
      body: {
        ticker: "GOOG",
        quantity: 8,
        executionPrice: 140,
        actionDate: new Date().toISOString(),
        statedMotivation: "spodziewam się wzrostu ceny",
      },
    },
    createRes,
  );
  const positionId = createRes.body.position._id;

  // quantity=3 < currentQuantity=8 -> filtr PRZECHODZI, więc
  // Position.currentQuantity ZOSTANIE zmienione wewnątrz transakcji —
  // ale statedMotivation spoza enuma sprawi, że Action.create() zawiedzie
  // TUŻ PO TYM. To dokładnie scenariusz z sekcji 7.2: "zmiana
  // currentQuantity się udaje, zapis Action zawodzi" — i właśnie to ma
  // wycofać transakcja.
  await assert.rejects(() =>
    addAction(
      {
        userId: TEST_USER_ID,
        params: { id: positionId },
        body: {
          actionType: "reduce",
          quantity: 3,
          executionPrice: 145,
          actionDate: new Date().toISOString(),
          statedMotivation: "coś spoza enuma — celowo błędne",
        },
      },
      mockRes(),
    ),
  );

  const position = await Position.findById(positionId);
  assert.equal(
    position.currentQuantity,
    8,
    "Position.currentQuantity musi wrócić do stanu sprzed transakcji",
  );

  const actionsCount = await Action.countDocuments({ positionId });
  assert.equal(actionsCount, 1, "nie powinna powstać żadna nowa akcja poza open");
});
