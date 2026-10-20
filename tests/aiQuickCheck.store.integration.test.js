import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Action from "../models/Action.js";
import Position from "../models/Position.js";
import { resolveTestDb } from "./helpers/testDb.js";
import {
  createOrchestratorKit,
  okResult,
  validQuick,
  T0,
} from "./helpers/aiOrchestratorKit.js";
import { IDS } from "./helpers/aiInputKit.js";
import {
  QUICK_CHECK_TOTAL_TIMEOUT_MS,
  validateEarlyAiCheckEntry,
} from "../services/aiOrchestrator.js";

/* Zapis `Action.earlyAiCheck` przez quick-check (Etap 8.9.4) — test ZAPISU.
 *
 * Dwa tryby (jak w testach stanu analiz; nazwa trybu jest w nazwach testów):
 *   - "mongo": gdy `MONGODB_TEST_URI` spełnia zabezpieczenia z testDb.js (osobna baza,
 *     nazwa zawiera „test”, adres ≠ MONGODB_URI). Orkiestrator dostaje PRAWDZIWE modele
 *     `Action` i `Position` (sprawdzenie właściciela i `findOneAndUpdate` z warunkiem
 *     `runStartedAt` oraz `maxTimeMS` idą do prawdziwej bazy). Gemini jest atrapą.
 *   - "fake":  w przeciwnym razie — atrapa kolekcji w pamięci; sprawdza logikę scenariuszy,
 *     ale NIE dowodzi niczego o MongoDB (w szczególności o `maxTimeMS` i atomowości).
 *
 * Dane składane do żądania (builder, rynek, wiadomości) to nadal atrapy z fixture 8.7 —
 * tutaj liczy się tylko to, co dzieje się z dokumentem `Action`. Test dotyka wyłącznie
 * dokumentów o identyfikatorach z fixture (usuwa je po sobie), nigdy całych kolekcji.
 * Żadnych wywołań Gemini; globalny fetch jest zablokowany. */

const testDb = resolveTestDb();
const backend = testDb.ok ? "mongo" : "fake";
const mongo = backend === "mongo";
const tag = `[${backend}]`;

before(async () => {
  globalThis.__realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Test wywołał globalny fetch — zakaz sieci w testach 8.9");
  };
  if (mongo) await mongoose.connect(testDb.uri);
});
after(async () => {
  globalThis.fetch = globalThis.__realFetch;
  if (mongo) {
    await cleanupDb();
    await mongoose.disconnect();
  }
});

async function cleanupDb() {
  await Action.collection.deleteMany({ _id: { $in: [IDS.action1, IDS.action2, IDS.action3] } });
  await Position.collection.deleteMany({ _id: { $in: [IDS.position, IDS.otherPosition] } });
}

const legacyEarly = () => ({
  analyzedAt: new Date(T0 - 100_000),
  summary: "STARY-WPIS-SPRZED-ETAPU-8",
  possibleBiases: [],
  limitations: "",
  aiModelVersion: "m",
  analysisRunId: "old-run",
});
const earlyWithRun = (summary, runStartedAtMs) => ({
  ...legacyEarly(),
  summary,
  analysisRunId: `run-${summary}`,
  runStartedAt: new Date(runStartedAtMs),
});

/**
 * Składa środowisko: stan dokumentu `Action` przed uruchomieniem (`early`), skrypt atrapy
 * Gemini i opcje orkiestratora. `hooks` pozwalają ingerować w samą aktualizację:
 *   before(filter)  — np. „w międzyczasie zapisało się nowsze uruchomienie”
 *   mutateFilter(f) — dodaje do filtra element wymuszający wolne zapytanie
 *   after(result)   — po rzeczywistej aktualizacji, przed oddaniem wyniku orkiestratorowi
 *                     (może rzucić wyjątek = „baza zatwierdziła, a odpowiedź nie doszła”)
 */
async function makeEnv({ script, early, options = {}, hooks = {} }) {
  let k = null;
  const baseModel = () => (mongo ? Action : k.actions);
  const seen = { maxTimeMS: undefined, lastError: null };

  const ActionModel = {
    findOne: (...args) => baseModel().findOne(...args),
    findOneAndUpdate(filter, update, opts) {
      seen.maxTimeMS = opts?.maxTimeMS;
      const run = async () => {
        if (hooks.before) await hooks.before(filter);
        const f = hooks.mutateFilter ? hooks.mutateFilter(filter) : filter;
        let result;
        try {
          result = await baseModel().findOneAndUpdate(f, update, opts).select("_id").lean();
        } catch (error) {
          seen.lastError = error;
          throw error;
        }
        if (hooks.after) await hooks.after(result);
        return result;
      };
      const query = {
        select: () => query,
        lean: () => query,
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return query;
    },
  };

  k = createOrchestratorKit({
    script,
    orchestratorOptions: {
      ActionModel,
      ...(mongo ? { PositionModel: Position } : {}),
      saveBudgetMs: 2_500,
      ...options,
    },
  });

  const store = {
    async readEarly() {
      if (mongo) return (await Action.collection.findOne({ _id: IDS.action2 }))?.earlyAiCheck ?? null;
      return k.actions._docs.find((d) => String(d._id) === String(IDS.action2)).earlyAiCheck ?? null;
    },
    async setEarly(value) {
      if (mongo) {
        await Action.collection.updateOne({ _id: IDS.action2 }, { $set: { earlyAiCheck: value } });
      } else {
        k.actions._docs.find((d) => String(d._id) === String(IDS.action2)).earlyAiCheck = value;
      }
    },
  };

  if (mongo) {
    await cleanupDb();
    await Position.collection.insertOne({
      _id: IDS.position,
      userId: IDS.userA,
      deletedAt: null,
    });
    await Action.collection.insertOne({
      _id: IDS.action2,
      positionId: IDS.position,
      userId: IDS.userA,
    });
  }
  await store.setEarly(early === undefined ? null : early);

  return { k, store, seen };
}

const runAt = (k) => k.orchestrator.runQuickCheck(k.qc());

test(`${tag} prawidłowy wynik zostaje zapisany w Action.earlyAiCheck (w tym migawka) i przechodzi walidację schematu`, async () => {
  const { k, store, seen } = await makeEnv({ script: [okResult(validQuick({ summary: "ZAPISANY-WYNIK" }))] });
  const result = await runAt(k);

  assert.equal(result.ok, true);
  assert.equal(result.earlyAiCheck.inputSnapshot, undefined); // nie wraca do wywołującego
  const saved = await store.readEarly();
  assert.equal(saved.summary, "ZAPISANY-WYNIK");
  assert.equal(saved.analysisRunId, "run-1");
  assert.equal(new Date(saved.runStartedAt).getTime(), T0);
  assert.ok(saved.inputSnapshot && saved.inputSnapshot.modelInput, "migawka zapisana w bazie");
  assert.equal((await validateEarlyAiCheckEntry(saved)).ok, true);
  assert.equal(seen.maxTimeMS, 2_500, "zapis dostał maxTimeMS z własnego budżetu zapisu");
  assert.equal(k.usageDocs.at(-1).outcome, "success");
});

test(`${tag} warunek runStartedAt: brak wyniku, wpis sprzed Etapu 8 i starszy wynik są zastępowane; nowszy zostaje`, async () => {
  const cases = [
    ["brak wyniku", null, true],
    ["wpis sprzed Etapu 8 (bez runStartedAt)", legacyEarly(), true],
    ["starszy wynik", earlyWithRun("STARSZY", T0 - 60_000), true],
    ["nowszy wynik", earlyWithRun("NOWSZY", T0 + 60_000), false],
  ];
  for (const [name, early, shouldReplace] of cases) {
    const { k, store } = await makeEnv({ script: [okResult(validQuick({ summary: "MOJ-WYNIK" }))], early });
    const result = await runAt(k);
    const saved = await store.readEarly();
    if (shouldReplace) {
      assert.equal(result.ok, true, name);
      assert.equal(saved.summary, "MOJ-WYNIK", name);
    } else {
      assert.deepEqual([result.ok, result.kind], [false, "write_rejected"], name);
      assert.equal(saved.summary, "NOWSZY", name);
      assert.equal(k.usageDocs.at(-1).outcome, "write_rejected", name);
    }
  }
});

test(`${tag} wyścig: nowsze uruchomienie zapisuje się tuż przed moim zapisem → mój (starszy) zapis jest odrzucony`, async () => {
  const { k, store } = await makeEnv({
    script: [okResult(validQuick({ summary: "STARSZE-URUCHOMIENIE" }))],
    early: null,
    hooks: {
      // dokładnie w chwili aktualizacji w bazie jest już wynik nowszego uruchomienia
      before: () => store.setEarly(earlyWithRun("NOWSZE-URUCHOMIENIE", T0 + 60_000)),
    },
  });
  const result = await runAt(k);
  assert.deepEqual([result.ok, result.kind], [false, "write_rejected"]);
  assert.equal((await store.readEarly()).summary, "NOWSZE-URUCHOMIENIE");
});

test(`${tag} zapis potwierdzony po upływie pierwotnych 45 s jest sukcesem`, async () => {
  const { k, store } = await makeEnv({
    script: [okResult(validQuick({ summary: "POTWIERDZONY-PO-TERMINIE" }))],
    hooks: { after: () => k.advance(QUICK_CHECK_TOTAL_TIMEOUT_MS + 1_000) },
  });
  const result = await runAt(k);
  assert.equal(result.ok, true);
  assert.equal((await store.readEarly()).summary, "POTWIERDZONY-PO-TERMINIE");
  assert.equal(k.usageDocs.at(-1).outcome, "success");
});

test(`${tag} wynik zapisu nieznany: baza zatwierdziła, a odpowiedź nie doszła → writeUnconfirmed; kolejne uruchomienie to naprawia`, async () => {
  let failOnce = true;
  const { k, store } = await makeEnv({
    script: [
      okResult(validQuick({ summary: "ZATWIERDZONY-MIMO-BLEDU" })),
      okResult(validQuick({ summary: "KOLEJNE-URUCHOMIENIE" })),
    ],
    hooks: {
      after: () => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("connection reset"), { name: "MongoNetworkError" });
        }
      },
    },
  });

  const first = await runAt(k);
  assert.deepEqual([first.ok, first.kind, first.writeUnconfirmed], [false, "internal_error", true]);
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["write_unconfirmed"]);
  // Dokładnie to oznacza „nieznany”: w bazie wynik JEST, choć aplikacja dostała błąd.
  assert.equal((await store.readEarly()).summary, "ZATWIERDZONY-MIMO-BLEDU");

  k.advance(5_000); // kolejne uruchomienie ma późniejsze runStartedAt → wolno mu zastąpić zapis
  const second = await runAt(k);
  assert.equal(second.ok, true);
  assert.equal((await store.readEarly()).summary, "KOLEJNE-URUCHOMIENIE");
});

test(`${tag} maxTimeMS: baza przerywa zbyt długi zapis (kod 50) → timeout/save i brak zapisu`, async (t) => {
  if (!mongo) {
    t.skip("wymaga prawdziwej bazy testowej (MONGODB_TEST_URI); atrapa ignoruje maxTimeMS");
    return;
  }
  // Wolne zapytanie wymuszamy filtrem `$where` (sleep po stronie serwera). Jeżeli serwer nie
  // pozwala na JavaScript w zapytaniach (np. część usług chmurowych), test jest pomijany.
  const { k, store, seen } = await makeEnv({
    script: [okResult(validQuick({ summary: "NIE-POWINIEN-SIE-ZAPISAC" }))],
    early: legacyEarly(),
    options: { saveBudgetMs: 400, saveSlackMs: 10_000 },
    hooks: { mutateFilter: (f) => ({ ...f, $where: "sleep(4000) || true" }) },
  });
  const result = await runAt(k);
  const code = seen.lastError?.code;

  if (result.kind === "internal_error" && code !== 50) {
    t.skip(`serwer nie wykonał zapytania z $where (kod ${code ?? "brak"}): nie da się sprawdzić maxTimeMS tym sposobem`);
    return;
  }
  assert.notEqual(result.ok, true, "maxTimeMS nie przerwał wolnego zapisu");
  assert.deepEqual([result.kind, result.phase], ["timeout", "save"]);
  assert.equal(result.writeUnconfirmed, undefined);
  assert.equal(code, 50);
  assert.equal((await store.readEarly()).summary, "STARY-WPIS-SPRZED-ETAPU-8");
  assert.deepEqual(k.usageDocs.at(-1).errorCodes, ["save_timeout"]);
});
