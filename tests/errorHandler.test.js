import { test } from "node:test";
import assert from "node:assert/strict";
import { errorHandler } from "../middleware/errorHandler.js";
import { appError } from "../utils/appError.js";

/* Testy czyste (bez bazy i sieci): wywołujemy errorHandler z atrapą res. */

function run(err) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  // 500 loguje przez console.error — wyciszamy, żeby nie zaśmiecać wyniku testów
  const original = console.error;
  console.error = () => {};
  try {
    errorHandler(err, {}, res, () => {});
  } finally {
    console.error = original;
  }
  return res;
}

test("błąd z kodem aplikacyjnym → { error, code } ze statusem błędu", () => {
  const res = run(appError(403, "Rejestracja nowych kont jest obecnie zamknięta", "registration_closed"));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Rejestracja nowych kont jest obecnie zamknięta",
    code: "registration_closed",
  });
});

test("kontrakt quick-checka przy braku danych rynkowych: 503 z kodem market_data_unavailable ({ error, code })", () => {
  const res = run(
    appError(
      503,
      "Nie udało się pobrać danych rynkowych potrzebnych do analizy. Spróbuj ponownie później.",
      "market_data_unavailable",
    ),
  );

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    error: "Nie udało się pobrać danych rynkowych potrzebnych do analizy. Spróbuj ponownie później.",
    code: "market_data_unavailable",
  });
});

test("błąd bez kodu aplikacyjnego → dotychczasowy format { error } (bez pola code)", () => {
  const err = new Error("Nie znaleziono pozycji");
  err.status = 404;
  const res = run(err);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Nie znaleziono pozycji" });
  assert.ok(!("code" in res.body));

  const plain = run(appError(400, "Wymagany jest e-mail i hasło"));
  assert.deepEqual(plain.body, { error: "Wymagany jest e-mail i hasło" });
});

test("pusty lub nietekstowy appCode jest ignorowany", () => {
  for (const appCode of ["", 42, null, {}]) {
    const err = new Error("x");
    err.status = 400;
    err.appCode = appCode;
    assert.deepEqual(run(err).body, { error: "x" });
  }
  assert.ok(!("appCode" in (appError(400, "x", "") )), "appError nie ustawia pustego kodu");
});

test("err.code (np. Mongo 11000) NIE jest mylony z kodem aplikacyjnym", () => {
  const dup = new Error("E11000 duplicate key");
  dup.code = 11000;
  dup.keyPattern = { email: 1 };
  const res = run(dup);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'Wartość pola "email" jest już zajęta' });

  const sys = new Error("połączenie zerwane");
  sys.code = "ECONNRESET";
  sys.status = 502;
  assert.deepEqual(run(sys).body, { error: "połączenie zerwane" });
});

test("istniejące gałęzie: ValidationError i CastError bez zmian", () => {
  const v = new Error("walidacja");
  v.name = "ValidationError";
  v.errors = { a: { message: "pole a wymagane" }, b: { message: "pole b zle" } };
  const rv = run(v);
  assert.equal(rv.statusCode, 400);
  assert.deepEqual(rv.body, { error: "pole a wymagane, pole b zle" });

  const c = new Error("Cast to ObjectId failed");
  c.name = "CastError";
  const rc = run(c);
  assert.equal(rc.statusCode, 400);
  assert.deepEqual(rc.body, { error: "Nieprawidłowy format ID" });
});

test("500: ogólny komunikat, bez stosu, wiadomości biblioteki i sekretów", () => {
  const err = new Error("connect ECONNREFUSED klucz=AIza-SECRET");
  const res = run(err);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Wystąpił błąd serwera" });
  assert.ok(!JSON.stringify(res.body).includes("AIza"));
  assert.ok(!JSON.stringify(res.body).includes("stack"));

  // 500 z kodem aplikacyjnym: kod jest, ale komunikat nadal ogólny
  const withCode = run(appError(500, "wewnętrzny szczegół", "some_code"));
  assert.deepEqual(withCode.body, { error: "Wystąpił błąd serwera", code: "some_code" });
});

test("appError: status, wiadomość i opcjonalny appCode (bez dotykania err.code)", () => {
  const a = appError(409, "msg", "analysis_in_progress");
  assert.equal(a.status, 409);
  assert.equal(a.message, "msg");
  assert.equal(a.appCode, "analysis_in_progress");
  assert.equal(a.code, undefined);
  assert.ok(a instanceof Error);
  assert.equal(appError(400, "m").appCode, undefined);
});

test("kod aplikacyjny trafia do odpowiedzi także w gałęziach ValidationError, CastError i Mongo 11000", () => {
  const v = new Error("walidacja");
  v.name = "ValidationError";
  v.errors = { a: { message: "pole a wymagane" } };
  v.appCode = "kod_walidacji";
  assert.deepEqual(run(v).body, { error: "pole a wymagane", code: "kod_walidacji" });

  const c = new Error("cast");
  c.name = "CastError";
  c.appCode = "zle_id";
  const rc = run(c);
  assert.equal(rc.statusCode, 400);
  assert.deepEqual(rc.body, { error: "Nieprawidłowy format ID", code: "zle_id" });

  const d = new Error("dup");
  d.code = 11000;
  d.keyPattern = { email: 1 };
  d.appCode = "email_zajety";
  const rd = run(d);
  assert.equal(rd.statusCode, 409);
  assert.deepEqual(rd.body, { error: 'Wartość pola "email" jest już zajęta', code: "email_zajety" });
});
