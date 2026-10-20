import { test } from "node:test";
import assert from "node:assert/strict";
import { getAiConfig } from "../config/aiConfig.js";
import {
  createAiSafeguards,
  REASON_AI_DISABLED,
  REASON_AI_NOT_CONFIGURED,
  REASON_AI_PAUSED,
} from "../services/aiSafeguards.js";

/* Każdy test tworzy WŁASNĄ instancję z własnym zegarem i własną konfiguracją —
 * brak współdzielonego stanu, brak zależności od kolejności i od process.env. */

const READY = { AI_ENABLED: "true", GEMINI_API_KEY: "klucz-testowy" };

function setup(env = READY) {
  const clock = { t: 1_000_000 };
  const envBox = { ...env };
  const sg = createAiSafeguards({
    getConfig: () => getAiConfig(envBox),
    now: () => clock.t,
  });
  return { sg, clock, env: envBox };
}

test("canStartAnalysis — powody: ai_disabled, ai_not_configured, ai_paused; przy gotowej konfiguracji ok", () => {
  assert.deepEqual(setup({}).sg.canStartAnalysis(), { ok: false, reason: REASON_AI_DISABLED });
  assert.deepEqual(setup({ AI_ENABLED: "true" }).sg.canStartAnalysis(), {
    ok: false,
    reason: REASON_AI_NOT_CONFIGURED,
  });
  assert.deepEqual(setup().sg.canStartAnalysis(), { ok: true });

  const { sg } = setup();
  sg.reportRateLimited();
  assert.deepEqual(sg.canStartAnalysis(), { ok: false, reason: REASON_AI_PAUSED });

  assert.equal(REASON_AI_DISABLED, "ai_disabled");
  assert.equal(REASON_AI_NOT_CONFIGURED, "ai_not_configured");
  assert.equal(REASON_AI_PAUSED, "ai_paused");
});

test("wyłącznik ma pierwszeństwo przed brakiem klucza i przed pauzą", () => {
  const { sg, env } = setup();
  sg.reportRateLimited(); // pauza aktywna
  delete env.GEMINI_API_KEY;
  assert.equal(sg.canStartAnalysis().reason, REASON_AI_NOT_CONFIGURED, "brak klucza przed pauzą");
  env.AI_ENABLED = "false";
  assert.equal(sg.canStartAnalysis().reason, REASON_AI_DISABLED, "wyłącznik przed wszystkim");
});

test("pauza po 429: blokuje, a po upływie czasu odblokowuje (zegar wstrzyknięty, bez czekania)", () => {
  const { sg, clock } = setup();
  const r = sg.reportRateLimited();
  assert.equal(r.durationMs, 60_000);
  assert.equal(r.level, 1);
  assert.equal(r.extended, true);

  clock.t += 59_999;
  assert.equal(sg.canStartAnalysis().ok, false);
  assert.equal(sg.getPauseState().paused, true);

  clock.t += 1; // dokładnie pausedUntil — pauza już wygasła
  assert.equal(sg.canStartAnalysis().ok, true);
  assert.equal(sg.getPauseState().paused, false);
  assert.equal(sg.getPauseState().pausedUntil, null);
});

test("kolejne 429 po wygaśnięciu pauzy wydłużają ją (60 s → 5 min → 25 min → limit 30 min)", () => {
  const { sg, clock } = setup();
  const durations = [];
  for (let i = 0; i < 5; i += 1) {
    const r = sg.reportRateLimited();
    durations.push(r.durationMs);
    clock.t += r.durationMs; // pauza dobiega końca
  }
  assert.deepEqual(durations, [60_000, 300_000, 1_500_000, 1_800_000, 1_800_000]);
});

test("429 w trakcie obowiązującej pauzy nie skraca jej i nie eskaluje poziomu", () => {
  const { sg, clock } = setup();
  const first = sg.reportRateLimited();
  clock.t += 10_000;
  const second = sg.reportRateLimited(); // np. spóźnione żądanie wysłane przed pauzą
  assert.equal(second.extended, false);
  assert.equal(second.pausedUntil, first.pausedUntil);
  assert.equal(second.level, 1);
  assert.equal(sg.getPauseState().pausedUntil, first.pausedUntil);

  clock.t = first.pausedUntil; // po wygaśnięciu kolejne 429 daje poziom 2
  assert.equal(sg.reportRateLimited().level, 2);
});

test("sukces zeruje poziom pauz, ale nie skraca trwającej pauzy", () => {
  const { sg, clock } = setup();
  sg.reportRateLimited();
  clock.t += 60_000;
  sg.reportRateLimited(); // poziom 2 (5 min)
  sg.reportSuccess(); // zeruje poziom
  assert.equal(sg.canStartAnalysis().ok, false, "pauza trwa mimo sukcesu");

  clock.t += 300_000;
  assert.equal(sg.canStartAnalysis().ok, true);
  assert.equal(sg.reportRateLimited().durationMs, 60_000, "po sukcesie znów zaczynamy od pauzy bazowej");
});

test("parametry pauzy pochodzą z konfiguracji (aktualne wartości, bez bufora)", () => {
  const { sg, env, clock } = setup({ ...READY, AI_PAUSE_BASE_MS: "2000", AI_PAUSE_FACTOR: "2", AI_PAUSE_MAX_MS: "5000" });
  const d = [];
  for (let i = 0; i < 3; i += 1) {
    const r = sg.reportRateLimited();
    d.push(r.durationMs);
    clock.t += r.durationMs;
  }
  assert.deepEqual(d, [2000, 4000, 5000]);
  env.AI_PAUSE_BASE_MS = "3000";
  sg.reportSuccess();
  assert.equal(sg.reportRateLimited().durationMs, 3000);
});

test("wyłączenie AI nie kasuje stanu pauzy (po ponownym włączeniu pauza nadal obowiązuje)", () => {
  const { sg, env } = setup();
  sg.reportRateLimited();
  env.AI_ENABLED = "false";
  assert.equal(sg.canStartAnalysis().reason, REASON_AI_DISABLED);
  env.AI_ENABLED = "true";
  assert.equal(sg.canStartAnalysis().reason, REASON_AI_PAUSED);
});

test("quick-check: blokada duplikatów po kluczu, zwalnianie po zakończeniu", () => {
  const { sg } = setup();
  assert.equal(sg.tryBeginQuickCheck("u1:a1"), true);
  assert.equal(sg.isQuickCheckRunning("u1:a1"), true);
  assert.equal(sg.tryBeginQuickCheck("u1:a1"), false, "duplikat odrzucony");
  assert.equal(sg.tryBeginQuickCheck("u1:a2"), true, "inny klucz niezależny");
  assert.equal(sg.tryBeginQuickCheck("u2:a1"), true, "inny użytkownik niezależny");

  sg.endQuickCheck("u1:a1");
  assert.equal(sg.isQuickCheckRunning("u1:a1"), false);
  assert.equal(sg.tryBeginQuickCheck("u1:a1"), true, "po zwolnieniu można ponowić");
});

test("runExclusiveQuickCheck: duplikat równoległy → 409 analysis_in_progress; blokada zwolniona po sukcesie", async () => {
  const { sg } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = sg.runExclusiveQuickCheck("u:a", async () => { await gate; return "wynik"; });
  await assert.rejects(
    () => sg.runExclusiveQuickCheck("u:a", async () => "nie powinno się wykonać"),
    (err) => err.status === 409 && err.appCode === "analysis_in_progress",
  );
  assert.equal(sg.isQuickCheckRunning("u:a"), true);

  release();
  assert.equal(await first, "wynik");
  assert.equal(sg.isQuickCheckRunning("u:a"), false);
  assert.equal(await sg.runExclusiveQuickCheck("u:a", async () => "ponownie"), "ponownie");
});

test("runExclusiveQuickCheck: blokada zwolniona także po błędzie (synchronicznym i asynchronicznym)", async () => {
  const { sg } = setup();
  await assert.rejects(
    () => sg.runExclusiveQuickCheck("u:a", async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(sg.isQuickCheckRunning("u:a"), false);

  await assert.rejects(
    () => sg.runExclusiveQuickCheck("u:a", () => { throw new Error("sync boom"); }),
    /sync boom/,
  );
  assert.equal(sg.isQuickCheckRunning("u:a"), false);
});

test("instancje są izolowane, a reset() czyści pauzę i mapę w toku", () => {
  const a = setup();
  const b = setup();
  a.sg.reportRateLimited();
  a.sg.tryBeginQuickCheck("k");
  assert.equal(b.sg.canStartAnalysis().ok, true);
  assert.equal(b.sg.isQuickCheckRunning("k"), false);

  a.sg.reset();
  assert.equal(a.sg.canStartAnalysis().ok, true);
  assert.equal(a.sg.isQuickCheckRunning("k"), false);
  assert.equal(a.sg.getPauseState().level, 0);
});
