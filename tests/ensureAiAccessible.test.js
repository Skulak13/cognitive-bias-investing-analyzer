import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { errorHandler } from "../middleware/errorHandler.js";
import {
  createEnsureAiAccessible,
  ensureAiAccessible,
} from "../middleware/ensureAiAccessible.js";
import { hasValidAiConsent } from "../utils/aiConsent.js";

// Etap 8.5.1 — bramka dostępu do AI. Wszystko offline (bez bazy i sieci):
// użytkownik jest wstrzykiwany albo podmieniany na czas pojedynczego testu.

const CONFIG_V1 = { consentVersion: "1" };
const VALID_USER = {
  emailVerifiedAt: new Date("2026-10-01T10:00:00Z"),
  disclaimerAcceptedAt: new Date("2026-10-02T10:00:00Z"),
  disclaimerVersion: "1",
};

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

/** Uruchamia middleware bezpośrednio; zwraca `{ nextCalled, error }`. */
async function run(middleware, req) {
  let nextCalled = false;
  try {
    await middleware(req, {}, () => {
      nextCalled = true;
    });
    return { nextCalled, error: null };
  } catch (error) {
    return { nextCalled, error };
  }
}

// --- hasValidAiConsent: czysta reguła ważności zgody ---

test("hasValidAiConsent — ważna tylko z datą ORAZ zgodną wersją", () => {
  assert.equal(hasValidAiConsent(VALID_USER, "1"), true);
});

test("hasValidAiConsent — zgoda sprzed wersjonowania (data bez wersji) jest nieważna", () => {
  assert.equal(
    hasValidAiConsent({ disclaimerAcceptedAt: new Date(), disclaimerVersion: null }, "1"),
    false,
  );
  assert.equal(
    hasValidAiConsent({ disclaimerAcceptedAt: new Date() }, "1"),
    false,
  );
});

test("hasValidAiConsent — inna wersja niż aktualna jest nieważna (także 'nowsza')", () => {
  assert.equal(hasValidAiConsent({ ...VALID_USER, disclaimerVersion: "1" }, "2"), false);
  assert.equal(hasValidAiConsent({ ...VALID_USER, disclaimerVersion: "2" }, "1"), false);
  // dokładne porównanie, bez normalizacji
  assert.equal(hasValidAiConsent({ ...VALID_USER, disclaimerVersion: " 1" }, "1"), false);
  assert.equal(hasValidAiConsent({ ...VALID_USER, disclaimerVersion: "1.0" }, "1"), false);
});

test("hasValidAiConsent — wersja bez daty, niepoprawna data i wartości nie-tekstowe są nieważne", () => {
  assert.equal(
    hasValidAiConsent({ disclaimerAcceptedAt: null, disclaimerVersion: "1" }, "1"),
    false,
  );
  assert.equal(
    hasValidAiConsent({ disclaimerAcceptedAt: new Date("nie-data"), disclaimerVersion: "1" }, "1"),
    false,
  );
  assert.equal(
    hasValidAiConsent({ disclaimerAcceptedAt: "2026-10-02", disclaimerVersion: "1" }, "1"),
    false,
  );
  assert.equal(
    hasValidAiConsent({ disclaimerAcceptedAt: new Date(), disclaimerVersion: 1 }, "1"),
    false,
  );
});

test("hasValidAiConsent — brak użytkownika lub pusta wersja aktualna → false", () => {
  assert.equal(hasValidAiConsent(null, "1"), false);
  assert.equal(hasValidAiConsent(undefined, "1"), false);
  assert.equal(hasValidAiConsent(VALID_USER, ""), false);
  assert.equal(hasValidAiConsent(VALID_USER, undefined), false);
});

// --- ensureAiAccessible: warunki konta ---

test("ensureAiAccessible — poprawne konto i zgoda: wywołuje next(), nie rzuca", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => VALID_USER,
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, { userId: "u1" });
  assert.equal(error, null);
  assert.equal(nextCalled, true);
});

test("ensureAiAccessible — brak req.userId (zła kolejność middleware): 401 unauthorized, bez dotykania bazy", async () => {
  let loaded = false;
  const mw = createEnsureAiAccessible({
    loadUser: async () => {
      loaded = true;
      return VALID_USER;
    },
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, {});
  assert.equal(nextCalled, false);
  assert.equal(loaded, false);
  assert.equal(error.status, 401);
  assert.equal(error.appCode, "unauthorized");
});

test("ensureAiAccessible — konto nie istnieje (ważny token): 401 account_not_found", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => null,
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, { userId: "u1" });
  assert.equal(nextCalled, false);
  assert.equal(error.status, 401);
  assert.equal(error.appCode, "account_not_found");
});

test("ensureAiAccessible — niezweryfikowany e-mail: 403 email_not_verified (nawet przy ważnej zgodzie)", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => ({ ...VALID_USER, emailVerifiedAt: null }),
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, { userId: "u1" });
  assert.equal(nextCalled, false);
  assert.equal(error.status, 403);
  assert.equal(error.appCode, "email_not_verified");
});

test("ensureAiAccessible — brak zgody: 403 consent_required, next() nie jest wywołane", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => ({
      ...VALID_USER,
      disclaimerAcceptedAt: null,
      disclaimerVersion: null,
    }),
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, { userId: "u1" });
  assert.equal(nextCalled, false);
  assert.equal(error.status, 403);
  assert.equal(error.appCode, "consent_required");
});

test("ensureAiAccessible — zgoda bez wersji (sprzed Etapu 8): 403 consent_required", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => ({ ...VALID_USER, disclaimerVersion: null }),
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, { userId: "u1" });
  assert.equal(nextCalled, false);
  assert.equal(error.status, 403);
  assert.equal(error.appCode, "consent_required");
});

test("ensureAiAccessible — zmiana aktualnej wersji zgody wymusza ponowną akceptację", async () => {
  let current = "1";
  const mw = createEnsureAiAccessible({
    loadUser: async () => VALID_USER, // zaakceptowana wersja "1"
    getConfig: () => ({ consentVersion: current }),
  });

  assert.equal((await run(mw, { userId: "u1" })).nextCalled, true);

  current = "2";
  const after = await run(mw, { userId: "u1" });
  assert.equal(after.nextCalled, false);
  assert.equal(after.error.appCode, "consent_required");
});

test("ensureAiAccessible — komunikat błędu nie ujawnia danych użytkownika", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => ({ ...VALID_USER, disclaimerVersion: null }),
    getConfig: () => CONFIG_V1,
  });
  const { error } = await run(mw, { userId: "u1" });
  assert.doesNotMatch(error.message, /@|passwordHash/);
});

test("ensureAiAccessible — błąd odczytu użytkownika nie jest połykany (nie przepuszcza żądania)", async () => {
  const mw = createEnsureAiAccessible({
    loadUser: async () => {
      throw new Error("baza niedostępna");
    },
    getConfig: () => CONFIG_V1,
  });
  const { nextCalled, error } = await run(mw, { userId: "u1" });
  assert.equal(nextCalled, false);
  assert.match(error.message, /baza niedostępna/);
});

// --- C12: bramka NIE sprawdza wyłącznika/klucza/pauzy ---

test("ensureAiAccessible (produkcyjna) — nie zależy od AI_ENABLED ani GEMINI_API_KEY; zgoda z AI_CONSENT_VERSION", async () => {
  const saved = User.findById;
  User.findById = () => ({ select: () => ({ lean: async () => VALID_USER }) });
  try {
    // AI wyłączone i bez klucza — bramka nadal przepuszcza (wyłącznik to rola serwisu analizy)
    await withEnv(
      { AI_ENABLED: undefined, GEMINI_API_KEY: undefined, AI_CONSENT_VERSION: undefined },
      async () => {
        const { nextCalled, error } = await run(ensureAiAccessible, { userId: "u1" });
        assert.equal(error, null);
        assert.equal(nextCalled, true);
      },
    );

    // wersja zgody czytana z konfiguracji przy KAŻDYM żądaniu (bez restartu)
    await withEnv({ AI_CONSENT_VERSION: "2" }, async () => {
      const { nextCalled, error } = await run(ensureAiAccessible, { userId: "u1" });
      assert.equal(nextCalled, false);
      assert.equal(error.appCode, "consent_required");
    });
  } finally {
    User.findById = saved;
  }
});

test("ensureAiAccessible (produkcyjna) — z bazy czyta tylko pola potrzebne do decyzji (bez passwordHash)", async () => {
  const saved = User.findById;
  let selected = null;
  let idSeen = null;
  User.findById = (id) => {
    idSeen = id;
    return {
      select: (fields) => {
        selected = fields;
        return { lean: async () => VALID_USER };
      },
    };
  };
  try {
    await run(ensureAiAccessible, { userId: "507f1f77bcf86cd799439011" });
    assert.equal(idSeen, "507f1f77bcf86cd799439011");
    assert.deepEqual(selected.split(/\s+/).sort(), [
      "disclaimerAcceptedAt",
      "disclaimerVersion",
      "emailVerifiedAt",
    ]);
    assert.doesNotMatch(selected, /passwordHash/);
  } finally {
    User.findById = saved;
  }
});

// --- HTTP: auth + bramka + errorHandler na prawdziwym Express ---

async function withGuardedServer({ user, config = CONFIG_V1 }, fn) {
  const savedSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-8-5";
  let handlerCalls = 0;
  const app = express();
  app.post(
    "/guarded",
    auth,
    createEnsureAiAccessible({ loadUser: async () => user, getConfig: () => config }),
    (req, res) => {
      handlerCalls += 1;
      res.json({ ok: true });
    },
  );
  app.use(errorHandler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ userId: "507f1f77bcf86cd799439011", email: "a@b.pl" }, "test-secret-8-5");
    return await fn({ base, token, handlerCalls: () => handlerCalls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  }
}

test("HTTP — brak tokena: 401 z auth i handler nie jest wywołany", async () => {
  await withGuardedServer({ user: VALID_USER }, async ({ base, handlerCalls }) => {
    const res = await fetch(`${base}/guarded`, { method: "POST" });
    assert.equal(res.status, 401);
    assert.equal(handlerCalls(), 0);
  });
});

test("HTTP — brak zgody: 403 + code consent_required i handler (serwis analizy) NIE jest wywołany", async () => {
  await withGuardedServer(
    { user: { ...VALID_USER, disclaimerAcceptedAt: null, disclaimerVersion: null } },
    async ({ base, token, handlerCalls }) => {
      const res = await fetch(`${base}/guarded`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "consent_required");
      assert.equal(typeof body.error, "string");
      assert.equal(handlerCalls(), 0);
    },
  );
});

test("HTTP — stara wersja zgody: 403 consent_required; aktualna: 200 i handler wywołany", async () => {
  await withGuardedServer(
    { user: { ...VALID_USER, disclaimerVersion: "1" }, config: { consentVersion: "2" } },
    async ({ base, token, handlerCalls }) => {
      const res = await fetch(`${base}/guarded`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, "consent_required");
      assert.equal(handlerCalls(), 0);
    },
  );

  await withGuardedServer({ user: VALID_USER }, async ({ base, token, handlerCalls }) => {
    const res = await fetch(`${base}/guarded`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(handlerCalls(), 1);
  });
});

test("HTTP — konto usunięte: 401 account_not_found; niezweryfikowany e-mail: 403 email_not_verified", async () => {
  await withGuardedServer({ user: null }, async ({ base, token, handlerCalls }) => {
    const res = await fetch(`${base}/guarded`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "account_not_found");
    assert.equal(handlerCalls(), 0);
  });

  await withGuardedServer(
    { user: { ...VALID_USER, emailVerifiedAt: null } },
    async ({ base, token, handlerCalls }) => {
      const res = await fetch(`${base}/guarded`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, "email_not_verified");
      assert.equal(handlerCalls(), 0);
    },
  );
});
