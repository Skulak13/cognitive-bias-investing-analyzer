import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import app from "../app.js";
import User from "../models/User.js";
import { createEnsureAiAccessible } from "../middleware/ensureAiAccessible.js";
import { getAiConfig } from "../config/aiConfig.js";

// Etap 8.5.2 — wersjonowana zgoda przez prawdziwy router (app.js), offline:
// model User jest podmieniany na stanowy "magazyn" w pamięci na czas testu.

const USER_ID = "507f1f77bcf86cd799439011";
const OLD_ACCEPTANCE = new Date("2026-09-01T10:00:00Z");

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

/**
 * Uruchamia app na losowym porcie z podmienionym User.findByIdAndUpdate.
 * `store.user` to "dokument w bazie" (null = konto nie istnieje); `updates`
 * zapisuje, co kontroler próbował zapisać.
 */
async function withApp(store, fn) {
  const savedUpdate = User.findByIdAndUpdate;
  const savedSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-8-5";
  const updates = [];
  User.findByIdAndUpdate = async (id, update, options) => {
    updates.push({ id, update, options });
    if (!store.user) return null;
    Object.assign(store.user, update.$set);
    return { ...store.user };
  };
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ userId: USER_ID, email: "a@b.pl" }, "test-secret-8-5");
    const post = (body, { withToken = true, raw } = {}) =>
      fetch(`${base}/api/auth/accept-disclaimer`, {
        method: "POST",
        headers: {
          ...(withToken ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined || raw !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      });
    return await fn({ post, updates });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findByIdAndUpdate = savedUpdate;
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  }
}

const newStore = () => ({
  user: {
    emailVerifiedAt: new Date("2026-08-01T10:00:00Z"),
    disclaimerAcceptedAt: OLD_ACCEPTANCE, // zgoda sprzed wersjonowania
    disclaimerVersion: null,
  },
});

test("accept-disclaimer — poprawna wersja: 200, zapisuje datę i wersję", async () => {
  await withEnv({ AI_CONSENT_VERSION: undefined }, async () => {
    const store = newStore();
    await withApp(store, async ({ post, updates }) => {
      const before = Date.now();
      const res = await post({ version: "1" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.disclaimerVersion, "1");
      assert.ok(new Date(body.disclaimerAcceptedAt).getTime() >= before);

      assert.equal(updates.length, 1);
      assert.equal(updates[0].id, USER_ID); // zawsze użytkownik z tokenu
      assert.equal(updates[0].update.$set.disclaimerVersion, "1");
      assert.ok(updates[0].update.$set.disclaimerAcceptedAt instanceof Date);
      // wersja nie jest przyjmowana skądinąd niż z ciała i nie dotyka innych pól
      assert.deepEqual(Object.keys(updates[0].update.$set).sort(), [
        "disclaimerAcceptedAt",
        "disclaimerVersion",
      ]);
    });
  });
});

test("accept-disclaimer — brak wersji (puste ciało, brak ciała, {}, null): 400 consent_version_required, nic nie zapisane", async () => {
  await withEnv({ AI_CONSENT_VERSION: undefined }, async () => {
    const store = newStore();
    await withApp(store, async ({ post, updates }) => {
      for (const res of [
        await post({}),
        await post(undefined), // brak ciała i brak Content-Type (req.body === undefined w Express 5)
        await post({ version: null }),
        await post({ version: "" }),
      ]) {
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, "consent_version_required");
      }
      assert.equal(updates.length, 0);
      assert.equal(store.user.disclaimerVersion, null);
      assert.equal(store.user.disclaimerAcceptedAt, OLD_ACCEPTANCE);
    });
  });
});

test("accept-disclaimer — nieznana/nieaktualna/niestandardowa wersja: 400 consent_version_unknown, nic nie zapisane", async () => {
  await withEnv({ AI_CONSENT_VERSION: "2" }, async () => {
    const store = newStore();
    await withApp(store, async ({ post, updates }) => {
      for (const version of ["1", "3", "2 ", " 2", "02", 2, ["2"], { v: "2" }, true]) {
        const res = await post({ version });
        assert.equal(res.status, 400, `version=${JSON.stringify(version)}`);
        const body = await res.json();
        // typ nie-tekstowy to "brak poprawnej wersji", tekst innej wartości to "nieznana"
        assert.ok(
          ["consent_version_unknown", "consent_version_required"].includes(body.code),
        );
      }
      assert.equal(updates.length, 0);

      const res = await post({ version: "1" });
      const body = await res.json();
      assert.equal(body.code, "consent_version_unknown");
      assert.match(body.error, /"2"/); // klient dowiaduje się, jaka wersja jest aktualna
    });
  });
});

test("accept-disclaimer — bez tokena: 401 i brak zapisu", async () => {
  const store = newStore();
  await withApp(store, async ({ post, updates }) => {
    const res = await post({ version: "1" }, { withToken: false });
    assert.equal(res.status, 401);
    assert.equal(updates.length, 0);
  });
});

test("accept-disclaimer — konto nie istnieje: 404", async () => {
  await withEnv({ AI_CONSENT_VERSION: undefined }, async () => {
    await withApp({ user: null }, async ({ post }) => {
      const res = await post({ version: "1" });
      assert.equal(res.status, 404);
    });
  });
});

test("accept-disclaimer — niepoprawny JSON: 400, brak zapisu", async () => {
  const store = newStore();
  await withApp(store, async ({ post, updates }) => {
    const res = await post(undefined, { raw: "{nie-json" });
    assert.equal(res.status, 400);
    assert.equal(updates.length, 0);
  });
});

test("zgoda sprzed wersjonowania jest nieważna dla bramki AI, aż do ponownej akceptacji (cały przepływ)", async () => {
  await withEnv({ AI_CONSENT_VERSION: undefined }, async () => {
    const store = newStore(); // data zgody jest, wersji brak
    const guard = createEnsureAiAccessible({
      loadUser: async () => ({ ...store.user }),
      getConfig: getAiConfig,
    });
    const check = async () => {
      try {
        await guard({ userId: USER_ID }, {}, () => {});
        return "allowed";
      } catch (e) {
        return e.appCode;
      }
    };

    await withApp(store, async ({ post }) => {
      assert.equal(await check(), "consent_required"); // zamierzone: wymagana ponowna akceptacja

      assert.equal((await post({ version: "999" })).status, 400);
      assert.equal(await check(), "consent_required"); // nieudana akceptacja niczego nie odblokowuje

      assert.equal((await post({ version: "1" })).status, 200);
      assert.equal(await check(), "allowed");

      // zmiana tekstu zgody (nowa wersja w konfiguracji) → znów wymagana akceptacja
      await withEnv({ AI_CONSENT_VERSION: "2" }, async () => {
        assert.equal(await check(), "consent_required");
        assert.equal((await post({ version: "1" })).status, 400);
        assert.equal((await post({ version: "2" })).status, 200);
        assert.equal(await check(), "allowed");
      });
    });
  });
});
