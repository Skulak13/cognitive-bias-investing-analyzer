import { test } from "node:test";
import assert from "node:assert/strict";
import User from "../models/User.js";
import { register, login } from "../controllers/authController.js";

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
  };
}

// --- Schemat User (offline, bez połączenia z bazą — jak w Etapie 2) ---

test("model User — odrzuca nieprawidłowy format e-mail", async () => {
  const user = new User({ email: "nie-email", passwordHash: "x" });
  await assert.rejects(() => user.validate());
});

test("model User — akceptuje poprawny e-mail, normalizuje i ustawia domyślne pola", async () => {
  const user = new User({ email: "Test@Example.com", passwordHash: "x" });
  await user.validate(); // nie powinno rzucić

  assert.equal(user.email, "test@example.com"); // lowercase + trim ze schematu
  assert.equal(user.emailVerifiedAt, null);
  assert.equal(user.disclaimerAcceptedAt, null);
  assert.equal(user.aiUsage.quickCheckCount, 0);
  assert.equal(user.aiUsage.analysisCount, 0);
  assert.equal(user.aiUsage.date, null);
});

test("model User — wymaga passwordHash", async () => {
  const user = new User({ email: "test@example.com" });
  const err = await user.validate().catch((e) => e);
  assert.ok(err);
  assert.ok(err.errors.passwordHash);
});

// --- authController: wczesne walidacje, które rzucają PRZED dotknięciem
//     bazy (register: przed User.create; login: przed User.findOne) ---

test("register — wymaga e-maila i hasła", async () => {
  await assert.rejects(
    () => register({ body: {} }, mockRes()),
    /Wymagany jest e-mail i hasło/,
  );
});

test("register — odrzuca hasło krótsze niż 8 znaków", async () => {
  await assert.rejects(
    () =>
      register(
        { body: { email: "test@example.com", password: "short" } },
        mockRes(),
      ),
    /minimum 8 znaków/,
  );
});

test("login — wymaga e-maila i hasła", async () => {
  await assert.rejects(
    () => login({ body: {} }, mockRes()),
    /Wymagany jest e-mail i hasło/,
  );
});
