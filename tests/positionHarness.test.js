import { test } from "node:test";
import assert from "node:assert/strict";
import { createPositionHarness } from "./helpers/positionHarness.js";

/* Etap 8.6 — pilnuje, żeby atrapa ("fake") nie rozjeżdżała się z prawdziwym
 * schematem `Position` (przyczyna: brakujące `currentQuantity` wychodziło dopiero
 * na prawdziwej bazie). Bez bazy: wymuszamy tryb "fake" pustym środowiskiem. */

test("atrapa buduje dokumenty schematem Position: te same wartości domyślne", async () => {
  const h = await createPositionHarness({});
  assert.equal(h.backend, "fake");
  const id = await h.insert();
  const doc = await h.get(id);
  assert.equal(doc.status, "open");
  assert.equal(doc.currentQuantity, 1);
  assert.equal(doc.finalAnalysisAttempts, 0);
  assert.equal(doc.deletedAt, null);
  assert.equal(doc.lastAnalysisStatus, null);
  assert.equal(doc.finalAnalysisRequestedAt, null);
  assert.deepEqual(doc.analyses, []);
});

test("atrapa odrzuca dokumenty, których prawdziwa baza by nie przyjęła", async () => {
  const h = await createPositionHarness({});
  await assert.rejects(
    () => h.insert({ lastAnalysisStatus: "wymyślony" }),
    /lastAnalysisStatus/,
  );
  await assert.rejects(
    () => h.insert({ currentQuantity: undefined }),
    /currentQuantity/,
  );
  await assert.rejects(
    () => h.insert({ finalAnalysisAttempts: 1.5 }),
    /finalAnalysisAttempts/,
  );
  await assert.rejects(
    () => h.insert({ analyses: [{ analysisType: "final" }] }), // brak summary i aiModelVersion
    /analyses/,
  );
});

test("tryb mongo wybierany tylko dla bezpiecznego MONGODB_TEST_URI (bez połączenia, gdy brak/zła baza)", async () => {
  for (const env of [
    {},
    { MONGODB_TEST_URI: "mongodb://localhost/produkcja" },
    {
      MONGODB_TEST_URI: "mongodb://localhost/x_test",
      MONGODB_URI: "mongodb://localhost/x_test",
    },
  ]) {
    assert.equal((await createPositionHarness(env)).backend, "fake");
  }
});
