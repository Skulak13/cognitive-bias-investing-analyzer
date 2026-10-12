import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../app.js";
import Position from "../models/Position.js";
import Action from "../models/Action.js";

/* ------------------------------------------------------------------ *
 * Test HTTP przez prawdziwy router — domknięcie Etapu 6.
 *
 * W odróżnieniu od positionsController.integration.test.js (który wywołuje
 * kontroler bezpośrednio z atrapą req/res) ten plik uruchamia całą aplikację
 * z app.js na losowym porcie i wysyła prawdziwe żądania HTTP wbudowanym
 * `fetch`. Sprawdza więc również rejestrację trasy w routes/positions.routes.js,
 * middleware auth i errorHandler. Nie wymaga nowych zależności.
 *
 * Wymaga połączenia z MongoDB (MONGODB_URI), tak jak pozostałe testy
 * integracyjne.
 * ------------------------------------------------------------------ */

const MONGO_URI = process.env.MONGODB_URI;

// Middleware auth czyta JWT_SECRET z process.env przy każdym żądaniu.
// Jeśli .env go nie ma, test używa własnego sekretu (tylko w tym procesie).
const JWT_SECRET = process.env.JWT_SECRET || "http-test-secret-only";
process.env.JWT_SECRET = JWT_SECRET;

const TEST_USER_ID = new mongoose.Types.ObjectId();
const OTHER_USER_ID = new mongoose.Types.ObjectId();

const TEST_TICKER = "CSCO";
const TEST_ACTION_DATE = "2026-09-18T15:00:00.000Z";
const TEST_MOTIVATION = "spodziewam się wzrostu ceny";

let server = null;
let baseUrl = null;

function tokenFor(userId) {
  return jwt.sign(
    { userId: String(userId), email: "http-test@example.com" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

/**
 * Wysyła żądanie HTTP do uruchomionej aplikacji.
 * `body` jest serializowane do JSON-a; brak `body` oznacza żądanie
 * bez ciała i bez nagłówka Content-Type.
 */
async function request(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const options = { method, headers };

  if (typeof body !== "undefined") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: response.status, body: json, text };
}

function reasoningPath(positionId, actionId) {
  return `/api/positions/${positionId}/actions/${actionId}/reasoning`;
}

/**
 * Minimalna, poprawna para Position + Action utworzona bezpośrednio przez
 * Mongoose (bez zapytań o cenę rynkową) — wystarczy do testów PATCH.
 */
async function createTestPosition({
  reasoning = "",
  expectedOutcome = "",
  reasoningAddedAt = null,
  userId = TEST_USER_ID,
} = {}) {
  const position = await Position.create({
    userId,
    ticker: TEST_TICKER,
    status: "open",
    openedAt: new Date(TEST_ACTION_DATE),
    currentQuantity: 10,
  });

  const action = await Action.create({
    positionId: position._id,
    userId,
    actionType: "open",
    quantity: 10,
    executionPrice: 100,
    actionDate: new Date(TEST_ACTION_DATE),
    tradingDateRef: new Date("2026-09-18T00:00:00.000Z"),
    statedMotivation: TEST_MOTIVATION,
    reasoning,
    expectedOutcome,
    reasoningAddedAt,
  });

  return { position, action };
}

async function cleanup() {
  await Action.deleteMany({
    userId: { $in: [TEST_USER_ID, OTHER_USER_ID] },
  });
  await Position.deleteMany({
    userId: { $in: [TEST_USER_ID, OTHER_USER_ID] },
  });
}

before(async () => {
  if (!MONGO_URI) {
    throw new Error(
      "Brak MONGODB_URI — test HTTP wymaga połączenia z MongoDB.",
    );
  }

  await mongoose.connect(MONGO_URI);
  await cleanup();

  // Port 0 = system sam wybiera wolny port, więc test nie koliduje
  // z uruchomionym lokalnie serwerem deweloperskim.
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (mongoose.connection.readyState !== 0) {
    await cleanup();
    await mongoose.disconnect();
  }
});

/* ------------------------------------------------------------------ *
 * PATCH /api/positions/:id/actions/:actionId/reasoning
 * ------------------------------------------------------------------ */

test("HTTP PATCH .../reasoning — brak tokena zwraca 401 i nie zmienia akcji", async () => {
  const { position, action } = await createTestPosition({
    reasoning: "oryginał",
  });

  const res = await request("PATCH", reasoningPath(position._id, action._id), {
    body: { reasoning: "próba bez tokena" },
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, "Brak tokena autoryzacyjnego");

  const fromDb = await Action.findById(action._id).lean();
  assert.equal(fromDb.reasoning, "oryginał");
});

test("HTTP PATCH .../reasoning — poprawna zmiana zwraca 200 z nowym reasoningAddedAt", async () => {
  const staraData = new Date("2026-01-01T00:00:00.000Z");
  const { position, action } = await createTestPosition({
    reasoning: "stary powód",
    reasoningAddedAt: staraData,
  });

  const res = await request("PATCH", reasoningPath(position._id, action._id), {
    token: tokenFor(TEST_USER_ID),
    body: { reasoning: "Kupiłem po dobrym raporcie kwartalnym." },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.reasoning, "Kupiłem po dobrym raporcie kwartalnym.");
  assert.ok(res.body.reasoningAddedAt);
  assert.ok(
    new Date(res.body.reasoningAddedAt).getTime() > staraData.getTime(),
    "reasoningAddedAt powinno zostać przesunięte na moment zmiany",
  );

  const fromDb = await Action.findById(action._id).lean();
  assert.equal(fromDb.reasoning, "Kupiłem po dobrym raporcie kwartalnym.");
  assert.ok(fromDb.reasoningAddedAt.getTime() > staraData.getTime());
});

test("HTTP PATCH .../reasoning — cudza akcja zwraca 404 i nie zostaje zmieniona", async () => {
  const { position, action } = await createTestPosition({
    reasoning: "cudza notatka",
    userId: OTHER_USER_ID,
  });

  const res = await request("PATCH", reasoningPath(position._id, action._id), {
    token: tokenFor(TEST_USER_ID),
    body: { reasoning: "próba nieautoryzowanej edycji" },
  });

  assert.equal(res.status, 404);
  // Komunikat kontrolera odróżnia ten 404 od 404 "Nie znaleziono trasy"
  // (gdyby trasa nie była zarejestrowana, test musi to wykryć).
  assert.equal(
    res.body.error,
    "Akcja nie została znaleziona w kontekście tej pozycji.",
  );

  const fromDb = await Action.findById(action._id).lean();
  assert.equal(fromDb.reasoning, "cudza notatka");
});

test("HTTP PATCH .../reasoning — akcja z INNEJ własnej pozycji zwraca 404 (Parent-Child Guard)", async () => {
  const pozycjaA = await createTestPosition({ reasoning: "A" });
  const pozycjaB = await createTestPosition({ reasoning: "B" });

  // positionId z pozycji A, actionId z pozycji B — oba należą do tego samego usera
  const res = await request(
    "PATCH",
    reasoningPath(pozycjaA.position._id, pozycjaB.action._id),
    {
      token: tokenFor(TEST_USER_ID),
      body: { reasoning: "próba podmiany" },
    },
  );

  assert.equal(res.status, 404);
  assert.equal(
    res.body.error,
    "Akcja nie została znaleziona w kontekście tej pozycji.",
  );

  const wciazB = await Action.findById(pozycjaB.action._id).lean();
  assert.equal(wciazB.reasoning, "B");
});

test("HTTP PATCH .../reasoning — zły format ID zwraca 400", async () => {
  const { position, action } = await createTestPosition();
  const token = tokenFor(TEST_USER_ID);

  const badActionId = await request(
    "PATCH",
    reasoningPath(position._id, "to-nie-jest-id"),
    { token, body: { reasoning: "x" } },
  );
  assert.equal(badActionId.status, 400);
  assert.equal(badActionId.body.error, "Nieprawidłowy format ID");

  const badPositionId = await request(
    "PATCH",
    reasoningPath("to-nie-jest-id", action._id),
    { token, body: { reasoning: "x" } },
  );
  assert.equal(badPositionId.status, 400);
  assert.equal(badPositionId.body.error, "Nieprawidłowy format ID");
});

test("HTTP PATCH .../reasoning — puste ciało zwraca 400 (obiekt bez pól oraz brak ciała w ogóle)", async () => {
  const { position, action } = await createTestPosition({
    reasoning: "bez zmian",
  });
  const token = tokenFor(TEST_USER_ID);
  const path = reasoningPath(position._id, action._id);

  const emptyObject = await request("PATCH", path, { token, body: {} });
  assert.equal(emptyObject.status, 400);

  const noBody = await request("PATCH", path, { token });
  assert.equal(noBody.status, 400);

  const fromDb = await Action.findById(action._id).lean();
  assert.equal(fromDb.reasoning, "bez zmian");
});
