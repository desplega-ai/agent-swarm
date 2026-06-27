import { describe, expect, test } from "bun:test";
import {
  beginAttemptProgress,
  finishAttemptProgress,
  formatRunnerLog,
  getAttemptProgress,
  logLevelFor,
  PROGRESS_LOG_CAP,
  pushAttemptLog,
  recordAttemptTimings,
  setAttemptPhase,
} from "./attempt-progress.ts";

describe("attempt-progress registry", () => {
  test("unknown attempt returns the empty inactive shape", () => {
    const snap = getAttemptProgress("nope");
    expect(snap).toEqual({
      active: false,
      startedAt: null,
      currentPhase: null,
      currentPhaseStartedAt: null,
      phases: {},
      log: [],
    });
  });

  test("lifecycle: begin → phase → timings → log → finish clears", () => {
    const id = "a1";
    beginAttemptProgress(id);
    setAttemptPhase(id, "boot");
    pushAttemptLog(id, "info", "[boot] creating API sandbox");
    recordAttemptTimings(id, { bootMs: 1234, seedMs: null });

    const snap = getAttemptProgress(id);
    expect(snap.active).toBe(true);
    expect(snap.currentPhase).toBe("boot");
    expect(snap.currentPhaseStartedAt).not.toBeNull();
    expect(snap.phases.bootMs).toBe(1234);
    // null fields never clobber / never appear
    expect("seedMs" in snap.phases).toBe(false);
    expect(snap.log).toHaveLength(1);
    expect(snap.log[0]?.line).toContain("creating API sandbox");

    const full = finishAttemptProgress(id);
    expect(full).toHaveLength(1);
    expect(getAttemptProgress(id).active).toBe(false);
  });

  test("retries reset the entry via beginAttemptProgress", () => {
    const id = "a2";
    beginAttemptProgress(id);
    pushAttemptLog(id, "error", "[error] boom");
    beginAttemptProgress(id);
    expect(getAttemptProgress(id).log).toHaveLength(0);
    finishAttemptProgress(id);
  });

  test("live log is a ring buffer; the full capture keeps everything", () => {
    const id = "a3";
    beginAttemptProgress(id);
    const total = PROGRESS_LOG_CAP + 25;
    for (let i = 0; i < total; i++) pushAttemptLog(id, "info", `line ${i}`);
    const snap = getAttemptProgress(id);
    expect(snap.log).toHaveLength(PROGRESS_LOG_CAP);
    expect(snap.log[0]?.line).toBe("line 25");
    expect(snap.log[snap.log.length - 1]?.line).toBe(`line ${total - 1}`);
    const full = finishAttemptProgress(id);
    expect(full).toHaveLength(total);
  });

  test("recordAttemptTimings merges across calls and replaces perTask wholesale", () => {
    const id = "a4";
    beginAttemptProgress(id);
    recordAttemptTimings(id, { bootMs: 100 });
    recordAttemptTimings(id, { tasksMs: 5000, perTask: [{ taskId: "t1", ms: 5000 }] });
    const snap = getAttemptProgress(id);
    expect(snap.phases.bootMs).toBe(100);
    expect(snap.phases.tasksMs).toBe(5000);
    expect(snap.phases.perTask).toEqual([{ taskId: "t1", ms: 5000 }]);
    finishAttemptProgress(id);
  });

  test("setAttemptPhase(null) clears the current phase marker", () => {
    const id = "a5";
    beginAttemptProgress(id);
    setAttemptPhase(id, "tasks");
    setAttemptPhase(id, null);
    const snap = getAttemptProgress(id);
    expect(snap.currentPhase).toBeNull();
    expect(snap.currentPhaseStartedAt).toBeNull();
    finishAttemptProgress(id);
  });
});

describe("log helpers", () => {
  test("logLevelFor heuristics", () => {
    expect(logLevelFor("[error] kaboom")).toBe("error");
    expect(logLevelFor("warn: failed to kill sandbox x")).toBe("warn");
    expect(logLevelFor("[retry] attempt retrying (1/1)")).toBe("warn");
    expect(logLevelFor("[task] created t1 — waiting")).toBe("info");
  });

  test("formatRunnerLog emits one 'ISO [level] line' row per entry", () => {
    const out = formatRunnerLog([
      { ts: "2026-06-11T20:00:00.000Z", level: "info", line: "[boot] hi" },
      { ts: "2026-06-11T20:00:01.000Z", level: "error", line: "[error] no" },
    ]);
    expect(out).toBe(
      "2026-06-11T20:00:00.000Z [info] [boot] hi\n2026-06-11T20:00:01.000Z [error] [error] no",
    );
  });
});
