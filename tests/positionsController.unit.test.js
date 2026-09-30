import { test } from "node:test";
import assert from "node:assert/strict";
import { assertUnambiguousActionDate } from "../controllers/positionsController.js";

/**
 * Testy czystej logiki assertUnambiguousActionDate — bez bazy, bez sieci.
 * Testy integracyjne (positionsController.integration.test.js) sprawdzają
 * tę samą funkcję "z zewnątrz", przez HTTP-kształtny createPosition;
 * tutaj sprawdzamy jej granice dokładnie, bo `now` jest wstrzykiwane.
 */

test("assertUnambiguousActionDate — akceptuje jednoznaczny ISO-8601", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");

  const date = assertUnambiguousActionDate("2026-09-24T11:00:00.000Z", now);

  assert.equal(date.toISOString(), "2026-09-24T11:00:00.000Z");
});

test("assertUnambiguousActionDate — odrzuca brak strefy czasowej", () => {
  assert.throws(
    () => assertUnambiguousActionDate("2026-09-24T11:00"),
    /jawną strefą czasową/,
  );
});

test("assertUnambiguousActionDate — odrzuca nieistniejącą datę kalendarzową", () => {
  assert.throws(
    () => assertUnambiguousActionDate("2026-02-30T11:00:00.000Z"),
    /nieistniejącą datę/,
  );
});

/* ------------------------------------------------------------------ *
 * Dokładna granica tolerancji 5 minut
 * ------------------------------------------------------------------ */

test("assertUnambiguousActionDate — dokładnie na granicy tolerancji (5 min) jest jeszcze akceptowane", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const naGranicy = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

  // "> tolerancja" odrzuca, więc DOKŁADNIE na granicy (nie o milisekundę
  // więcej) wciąż przechodzi.
  assert.doesNotThrow(() => assertUnambiguousActionDate(naGranicy, now));
});

test("assertUnambiguousActionDate — o 1 ms za granicą tolerancji jest odrzucane", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const zaGranica = new Date(now.getTime() + 5 * 60 * 1000 + 1).toISOString();

  assert.throws(
    () => assertUnambiguousActionDate(zaGranica, now),
    /nie może wskazywać przyszłości/,
  );
});

test("assertUnambiguousActionDate — 1 ms PRZED granicą tolerancji jest akceptowane", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const tuzPrzedGranica = new Date(
    now.getTime() + 5 * 60 * 1000 - 1,
  ).toISOString();

  assert.doesNotThrow(() => assertUnambiguousActionDate(tuzPrzedGranica, now));
});

test("assertUnambiguousActionDate — wyraźnie przyszła data (jutro) jest odrzucana", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const jutro = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  assert.throws(
    () => assertUnambiguousActionDate(jutro, now),
    /nie może wskazywać przyszłości/,
  );
});

test("assertUnambiguousActionDate — data z przeszłości zawsze przechodzi", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");

  assert.doesNotThrow(() =>
    assertUnambiguousActionDate("2020-01-01T00:00:00.000Z", now),
  );
});
