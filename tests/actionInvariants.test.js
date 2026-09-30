import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateStaticQuantity,
  buildActionUpdate,
} from "../utils/actionInvariants.js";

test("validateStaticQuantity — open/add wymagają quantity > 0", () => {
  assert.equal(validateStaticQuantity("open", 10), null);
  assert.equal(validateStaticQuantity("add", 5), null);
  assert.match(validateStaticQuantity("open", 0), /większe od zera/);
  assert.match(validateStaticQuantity("add", -3), /większe od zera/);
});

test("validateStaticQuantity — hold wymaga dokładnie 0", () => {
  assert.equal(validateStaticQuantity("hold", 0), null);
  assert.match(validateStaticQuantity("hold", 1), /dokładnie 0/);
});

test("validateStaticQuantity — reduce/close wymagają quantity > 0", () => {
  assert.equal(validateStaticQuantity("reduce", 4), null);
  assert.equal(validateStaticQuantity("close", 10), null);
  assert.match(validateStaticQuantity("reduce", 0), /większe od zera/);
});

test("validateStaticQuantity — odrzuca nieznany actionType i NaN", () => {
  assert.match(
    validateStaticQuantity("delete-everything", 1),
    /Nieznany actionType/,
  );
  assert.match(validateStaticQuantity("open", NaN), /liczbą/);
});

test("validateStaticQuantity — odrzuca Infinity (Number.isNaN(Infinity) === false, więc samo sprawdzenie NaN je przepuszczało)", () => {
  assert.match(validateStaticQuantity("open", Infinity), /skończoną/);
  assert.match(validateStaticQuantity("add", Infinity), /skończoną/);
  assert.match(validateStaticQuantity("reduce", -Infinity), /skończoną/);
});

test("buildActionUpdate — add: brak górnego ograniczenia w filtrze", () => {
  const { filter, update } = buildActionUpdate("add", 5, "user1", "pos1");
  assert.deepEqual(update, { $inc: { currentQuantity: 5 } });
  assert.equal(filter.status, "open");
  assert.equal(filter.currentQuantity, undefined); // add nie ogranicza stanu
});

test("buildActionUpdate — reduce: filtr wymaga currentQuantity ŚCIŚLE większego", () => {
  const { filter, update } = buildActionUpdate("reduce", 4, "user1", "pos1");
  assert.deepEqual(filter.currentQuantity, { $gt: 4 });
  assert.deepEqual(update, { $inc: { currentQuantity: -4 } });
});

test("buildActionUpdate — close: filtr wymaga currentQuantity DOKŁADNIE równego, ustawia status closed", () => {
  const actionDate = new Date("2026-09-23T15:00:00.000Z");
  const { filter, update } = buildActionUpdate(
    "close",
    10,
    "user1",
    "pos1",
    actionDate,
  );
  assert.equal(filter.currentQuantity, 10);
  assert.equal(update.$inc.currentQuantity, -10);
  assert.equal(update.$set.status, "closed");
  // closedAt MUSI być tym samym momentem co actionDate (decyzja o
  // zamknięciu), a nie momentem wywołania buildActionUpdate — inaczej
  // wraca dokładnie ta niespójność, którą ta zmiana miała usunąć.
  assert.equal(update.$set.closedAt, actionDate);
});

test("buildActionUpdate — close: rzuca, gdy actionDate brakuje albo jest niepoprawne", () => {
  assert.throws(
    () => buildActionUpdate("close", 10, "user1", "pos1"),
    /wymaga poprawnego actionDate/,
  );
  assert.throws(
    () => buildActionUpdate("close", 10, "user1", "pos1", new Date("nie-data")),
    /wymaga poprawnego actionDate/,
  );
});

test("buildActionUpdate — hold: nie rusza currentQuantity", () => {
  const { filter, update } = buildActionUpdate("hold", 0, "user1", "pos1");
  assert.equal(filter.currentQuantity, undefined);
  assert.equal(update.$inc, undefined);
});

test("buildActionUpdate — nieobsługiwany actionType rzuca błąd", () => {
  assert.throws(() => buildActionUpdate("open", 1, "u", "p"));
});
