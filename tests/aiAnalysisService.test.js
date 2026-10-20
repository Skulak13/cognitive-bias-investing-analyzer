import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createAiAnalysisService,
  validateAnalysisEntry,
  FAILED_REASONS,
  SKIPPED_REASONS,
  RESUMABLE_FAILED_REASONS,
} from "../services/aiAnalysisService.js";
import { getAiConfig } from "../config/aiConfig.js";

/* Etap 8.6 — testy jednostkowe bez bazy i bez atrapy kolekcji. */

const entry = (over = {}) => ({
  analysisType: "final",
  summary: "Podsumowanie testowe",
  aiModelVersion: "test-model",
  analysisRunId: "run-1",
  ...over,
});

test("validateAnalysisEntry: poprawny wpis przechodzi", async () => {
  assert.equal((await validateAnalysisEntry(entry())).ok, true);
});

test("validateAnalysisEntry: brak pól wymaganych i zły typ analizy są odrzucane", async () => {
  const noSummary = await validateAnalysisEntry(entry({ summary: undefined }));
  assert.equal(noSummary.ok, false);
  const badType = await validateAnalysisEntry(
    entry({ analysisType: "weekly" }),
  );
  assert.equal(badType.ok, false);
  const noModel = await validateAnalysisEntry(
    entry({ aiModelVersion: undefined }),
  );
  assert.equal(noModel.ok, false);
});

test("powody statusów: zgodne z planem 6.3; wznawiane tylko server_restart i stale_timeout", () => {
  assert.equal(FAILED_REASONS.length, 10);
  assert.deepEqual(
    [...SKIPPED_REASONS],
    ["ai_disabled", "ai_paused", "ai_not_configured", "consent_missing"],
  );
  assert.deepEqual(
    [...RESUMABLE_FAILED_REASONS],
    ["server_restart", "stale_timeout"],
  );
  for (const r of RESUMABLE_FAILED_REASONS)
    assert.ok(FAILED_REASONS.includes(r));
});

test("domyślny limit automatycznych startów analizy końcowej wynosi 3 (1 + 2 dodatkowe)", () => {
  assert.equal(getAiConfig({}).finalMaxAutoAttempts, 3);
});

test("scheduler: timer z unref, stop zatrzymuje, obiegi się nie nakładają, błąd nie wychodzi na zewnątrz", async () => {
  let finds = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const model = {
    find() {
      finds += 1;
      const q = {
        select: () => q,
        limit: () => q,
        sort: () => q,
        lean: () => q,
      };
      q.then = (res, rej) => gate.then(() => []).then(res, rej);
      return q;
    },
  };
  const events = [];
  const service = createAiAnalysisService({
    PositionModel: model,
    getConfig: () => getAiConfig({}),
    log: (e) => events.push(e),
  });

  const sched = service.startRecoveryScheduler({
    intervalMs: 5,
    runImmediately: false,
  });
  assert.equal(sched.timer.hasRef(), false); // nie blokuje zamknięcia procesu

  await new Promise((r) => setTimeout(r, 40)); // kilka „tyknięć”, a pierwszy obieg wisi na bramce
  assert.equal(finds, 1, "obiegi nie mogą się nakładać");
  release();
  await new Promise((r) => setTimeout(r, 30));
  sched.stop();
  const after = finds;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(finds, after, "po stop nie ma kolejnych obiegów");
});

test("scheduler: wyjątek w obiegu trafia tylko do logu", async () => {
  const events = [];
  const service = createAiAnalysisService({
    PositionModel: {
      find() {
        throw new Error("awaria bazy");
      },
    },
    getConfig: () => getAiConfig({}),
    log: (e) => events.push(e),
  });
  const sched = service.startRecoveryScheduler({
    intervalMs: 1000,
    runImmediately: false,
  });
  await sched.runOnce();
  sched.stop();
  assert.ok(events.includes("recovery_cycle_error"));
});

test("server.js: odzyskiwanie po restarcie jest wywoływane po połączeniu z bazą i przed listen", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const connect = src.indexOf("await connectDB()");
  const recover = src.indexOf("recoverAfterRestart()");
  const listen = src.indexOf("app.listen(");
  const scheduler = src.indexOf("startRecoveryScheduler(");
  assert.ok(
    connect > -1 && recover > connect,
    "recoverAfterRestart po connectDB",
  );
  assert.ok(listen > recover, "listen po odzyskiwaniu");
  assert.ok(scheduler > listen, "przegląd cykliczny po starcie nasłuchu");
});

test("log serwisu nie zawiera treści: zdarzenia mają tylko identyfikatory, powody i liczby", async () => {
  const events = [];
  const model = {
    findOneAndUpdate() {
      const q = { select: () => q, lean: () => q };
      q.then = (res, rej) => Promise.resolve(null).then(res, rej);
      return q;
    },
  };
  const service = createAiAnalysisService({
    PositionModel: model,
    getConfig: () => getAiConfig({}),
    log: (event, fields) => events.push({ event, ...fields }),
  });
  const run = { runId: "r", positionId: "p", userId: "u" };
  await service.finishSuccess(
    run,
    entry({ summary: "TAJNY-TEKST-UZASADNIENIA" }),
  );
  assert.ok(events.some((e) => e.event === "write_rejected"));
  assert.equal(
    JSON.stringify(events).includes("TAJNY-TEKST-UZASADNIENIA"),
    false,
  );
});
