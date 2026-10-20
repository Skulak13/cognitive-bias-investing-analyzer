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

// --- Zamknięcie rejestracji (Etap 8.3.3, D8-04) ---
// Bez bazy: User.findOne / User.create są podmieniane na czas pojedynczego
// testu, a zmienne środowiskowe przywracane w finally (brak zależności od kolejności).

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withUserStub(stubs, fn) {
  const saved = {};
  for (const name of Object.keys(stubs)) {
    saved[name] = User[name];
    User[name] = stubs[name];
  }
  try {
    return await fn();
  } finally {
    for (const [name, original] of Object.entries(saved)) User[name] = original;
  }
}

test("register — REGISTRATION_CLOSED=true: 403 + kod registration_closed, bez dotykania bazy i bcrypt", async () => {
  const bcrypt = (await import("bcryptjs")).default;
  const originalHash = bcrypt.hash;
  let dbTouched = false;
  let hashCalls = 0;
  bcrypt.hash = async (...args) => {
    hashCalls += 1;
    return originalHash.apply(bcrypt, args);
  };
  try {
    await withEnv({ REGISTRATION_CLOSED: "true" }, () =>
      withUserStub(
        {
          create: async () => {
            dbTouched = true;
          },
        },
        async () => {
          await assert.rejects(
            // poprawne dane — i tak mają być odrzucone
            () =>
              register(
                { body: { email: "a@b.pl", password: "dlugiehaslo123" } },
                mockRes(),
              ),
            (err) =>
              err.status === 403 &&
              err.appCode === "registration_closed" &&
              /zamknięta/.test(err.message),
          );
        },
      ),
    );
  } finally {
    bcrypt.hash = originalHash;
  }
  assert.equal(
    hashCalls,
    0,
    "bcrypt.hash nie może być wywołany przy zamkniętej rejestracji",
  );
  assert.equal(dbTouched, false);
});

test("register — REGISTRATION_CLOSED=true sprawdzane przed walidacją (pusty body też daje 403, nie 400)", async () => {
  await withEnv({ REGISTRATION_CLOSED: "true" }, async () => {
    await assert.rejects(
      () => register({ body: {} }, mockRes()),
      (err) => err.status === 403 && err.appCode === "registration_closed",
    );
  });
});

test("register — REGISTRATION_CLOSED nieustawione / inne niż true: dotychczasowe działanie", async () => {
  for (const value of [undefined, "false", "TRUE", "1", ""]) {
    await withEnv(
      { REGISTRATION_CLOSED: value, JWT_SECRET: "test-secret" },
      async () => {
        // walidacja wejścia działa jak dawniej (400 bez kodu aplikacyjnego)
        await assert.rejects(
          () => register({ body: {} }, mockRes()),
          (err) => err.status === 400 && err.appCode === undefined,
        );

        // pełna rejestracja (User.create podmienione) kończy się 201
        const res = mockRes();
        await withUserStub(
          { create: async ({ email }) => ({ _id: "u1", email }) },
          () =>
            register(
              { body: { email: "nowy@test.pl", password: "dlugiehaslo123" } },
              res,
            ),
        );
        assert.equal(
          res.statusCode,
          201,
          `REGISTRATION_CLOSED=${JSON.stringify(value)}`,
        );
        assert.equal(res.body.user.email, "nowy@test.pl");
        assert.ok(res.body.token);
      },
    );
  }
});

test("login — działa przy REGISTRATION_CLOSED=true (istniejące konto)", async () => {
  const bcrypt = (await import("bcryptjs")).default;
  const passwordHash = await bcrypt.hash("dlugiehaslo123", 4);
  await withEnv(
    { REGISTRATION_CLOSED: "true", JWT_SECRET: "test-secret" },
    async () => {
      const res = mockRes();
      await withUserStub(
        {
          findOne: async () => ({
            _id: "u1",
            email: "stary@test.pl",
            passwordHash,
            disclaimerAcceptedAt: null,
          }),
        },
        () =>
          login(
            { body: { email: "Stary@Test.pl ", password: "dlugiehaslo123" } },
            res,
          ),
      );
      assert.equal(res.statusCode, null); // res.json() domyślnie 200
      assert.equal(res.body.user.email, "stary@test.pl");
      assert.ok(res.body.token);

      // złe hasło nadal 401 (bez kodu rejestracji)
      await withUserStub(
        {
          findOne: async () => ({
            _id: "u1",
            email: "stary@test.pl",
            passwordHash,
          }),
        },
        async () => {
          await assert.rejects(
            () =>
              login(
                { body: { email: "stary@test.pl", password: "zlehaslo123" } },
                mockRes(),
              ),
            (err) => err.status === 401 && err.appCode === undefined,
          );
        },
      );
    },
  );
});

test("HTTP: POST /api/auth/register przy REGISTRATION_CLOSED=true → 403 {error, code}; login nadal 200", async () => {
  const { default: app } = await import("../app.js");
  const bcrypt = (await import("bcryptjs")).default;
  const passwordHash = await bcrypt.hash("dlugiehaslo123", 4);

  await withEnv(
    { REGISTRATION_CLOSED: "true", JWT_SECRET: "test-secret" },
    async () => {
      const server = app.listen(0);
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = (path, body) =>
          fetch(base + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

        const reg = await post("/api/auth/register", {
          email: "x@test.pl",
          password: "dlugiehaslo123",
        });
        assert.equal(reg.status, 403);
        assert.deepEqual(await reg.json(), {
          error: "Rejestracja nowych kont jest obecnie zamknięta",
          code: "registration_closed",
        });

        await withUserStub(
          {
            findOne: async () => ({
              _id: "u1",
              email: "stary@test.pl",
              passwordHash,
            }),
          },
          async () => {
            const log = await post("/api/auth/login", {
              email: "stary@test.pl",
              password: "dlugiehaslo123",
            });
            assert.equal(log.status, 200);
            assert.ok((await log.json()).token);
          },
        );

        // zwykły błąd (bez kodu aplikacyjnego) zachowuje stary format {error}
        const bad = await post("/api/auth/login", {});
        assert.equal(bad.status, 400);
        assert.deepEqual(await bad.json(), {
          error: "Wymagany jest e-mail i hasło",
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});
