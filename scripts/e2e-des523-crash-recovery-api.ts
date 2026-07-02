#!/usr/bin/env bun
/**
 * DES-523 crash-recovery — Part 1: scripted API-level E2E (PR #791).
 *
 * Drives the REAL API server over HTTP with shortened (fractional-minute)
 * heartbeat thresholds and NO worker containers / NO LLM. Proves the four live
 * gaps the unit tests can't reach:
 *
 *   #1 a crashed task (in_progress, no active_session) is pinned to its own
 *      stable-id agent (status=pending, tag=crash-recovery-pin), NOT unassigned.
 *   #2 the same agent reclaims the pending pin via its real poll loop.
 *   #3 gone-agent: an unreclaimed pin past the grace window is reaped — resume
 *      cancelled (pin_unreclaimed_escalated) + a Lead-owned reroute-decision
 *      task referencing the ORIGINAL (original NOT reassigned to Lead).
 *   #4 no role-blind grab: worker B never claims A's pin.
 *
 * Crash simulation (Case A) needs no worker: GET /api/poll flips a pinned task
 * to in_progress via startTask WITHOUT creating an active_sessions row, so the
 * classifier (no session + task age >= threshold) treats it as a dead worker.
 *
 * Thresholds are fractional minutes: `Number(env) || 5` means `=0` falls back to
 * 5, but 0.1 (=6s) is truthy and works. Sweeps are driven on-demand via
 * POST /api/heartbeat/sweep; the background timer is pushed to 1h so it never
 * races our deterministic sweeps.
 *
 * Uses an ISOLATED DATABASE_PATH in a tmp dir — the repo's agent-swarm-db.sqlite
 * is never touched. The API key is read from env (AGENT_SWARM_API_KEY/API_KEY,
 * default 123123) and never printed.
 *
 * Run from repo root:  bun run scripts/e2e-des523-crash-recovery-api.ts
 * Exit: 0 = all assertions passed, 1 = one or more failed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = 3013;
const BASE = `http://localhost:${PORT}`;
const KEY = process.env.AGENT_SWARM_API_KEY ?? process.env.API_KEY ?? "123123";

// 0.1 min = 6s. Waits are sized to clear these with margin.
const STALL_MIN = "0.1";
const GRACE_MIN = "0.1";
const WAIT_STALL_MS = 9000; // > 6s: lets a task age past STALL_MIN before a sweep
const WAIT_GRACE_MS = 9000; // > 6s: lets a pin age past GRACE_MIN before the reaper sweep

// Stable agent ids (valid UUID v4 shape so any z.uuid() validation is happy).
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const PIN_TAG = "crash-recovery-pin";

const tmpDir = mkdtempSync(join(tmpdir(), "des523-e2e-"));
const DB_PATH = join(tmpDir, "db.sqlite");
const LOG_PATH = "/tmp/des523-e2e-server.log";

// ── Assertion harness ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function section(title: string) {
  console.log(`\n── ${title} ──`);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────────
type ApiResult = { status: number; body: any };
async function api(
  method: string,
  path: string,
  opts: { agentId?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };
  if (opts.agentId) headers["X-Agent-ID"] = opts.agentId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function listTasks(): Promise<any[]> {
  const r = await api("GET", "/api/tasks?fields=full&limit=200");
  return r.body?.tasks ?? [];
}
function findResumeChild(tasks: any[], parentId: string): any | undefined {
  return tasks.find((t) => t.taskType === "resume" && t.parentTaskId === parentId);
}
function findByType(tasks: any[], type: string, parentId: string): any[] {
  return tasks.filter((t) => t.taskType === type && t.parentTaskId === parentId);
}
function byId(tasks: any[], id: string): any | undefined {
  return tasks.find((t) => t.id === id);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Server lifecycle ─────────────────────────────────────────────────────────
// Truncate any leftover log from a prior run (Bun's FileSink does NOT truncate
// on open, so stale content would otherwise poison reads/the failure dump).
await Bun.write(LOG_PATH, "");
const logFile = Bun.file(LOG_PATH);
const logWriter = logFile.writer();
const proc = Bun.spawn(["bun", "--expose-gc", "apps/swarm/src/http.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_PATH: DB_PATH,
    AGENT_SWARM_API_KEY: KEY,
    HEARTBEAT_STALL_NO_SESSION_MIN: STALL_MIN,
    HEARTBEAT_RESUME_PIN_GRACE_MIN: GRACE_MIN,
    HEARTBEAT_INTERVAL_MS: "3600000", // 1h: background timer must not race our sweeps
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    JIRA_DISABLE: "true",
    LINEAR_DISABLE: "true",
  },
  stdout: "pipe",
  stderr: "pipe",
});
// Pump server output to the log file (best-effort).
(async () => {
  for await (const chunk of proc.stdout) logWriter.write(chunk);
})().catch(() => {});
(async () => {
  for await (const chunk of proc.stderr) logWriter.write(chunk);
})().catch(() => {});

function cleanup() {
  try {
    proc.kill();
  } catch {}
  try {
    logWriter.end();
  } catch {}
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function waitForReady(timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await api("GET", "/api/agents");
      if (r.status === 200) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// startHeartbeat() schedules a one-shot reboot sweep + immediate normal sweep at
// (server-init)+5s, then nothing until the (1h) interval. That reboot sweep
// retries any in_progress task — including one we just polled — so we MUST let it
// fire on the still-empty DB before creating tasks. The 5s timer is hardcoded, so
// a fixed wait past it (with margin) is deterministic. Confirmed afterwards by
// asserting the boot sweep ran (the log now contains its marker).
const BOOT_SWEEP_WAIT_MS = 10000;

// ── Main ───────────────────────────────────────────────────────────────────────
let exitCode = 1;
try {
  console.log(`DB: ${DB_PATH}`);
  console.log(`Server log: ${LOG_PATH}`);
  console.log(`Thresholds: STALL_NO_SESSION_MIN=${STALL_MIN} RESUME_PIN_GRACE_MIN=${GRACE_MIN} (min)`);

  section("Boot");
  const ready = await waitForReady();
  check(ready, "API server is up and authenticating");
  if (!ready) throw new Error("server did not become ready");
  console.log(`  … waiting ${BOOT_SWEEP_WAIT_MS}ms for the boot reboot-sweep to fire on the empty DB`);
  await sleep(BOOT_SWEEP_WAIT_MS);
  try {
    logWriter.flush();
  } catch {}
  const bootLog = await Bun.file(LOG_PATH).text();
  // On a clean DB the reboot sweep early-returns with this exact marker; it only
  // logs "Reboot sweep complete" when it actually retries a task. So this marker
  // (plus the absence of any "Reboot retry created") proves the boot sweep ran on
  // an empty DB and caught none of our tasks.
  check(
    bootLog.includes("Reboot sweep: no in-progress tasks found") && !bootLog.includes("Reboot retry created"),
    "boot reboot-sweep fired on empty DB, retried nothing (no startup race)",
  );

  // Register the cast: A + B (workers, generous capacity) and a Lead.
  section("Register agents A, B, Lead");
  const regA = await api("POST", "/api/agents", { agentId: A, body: { name: "worker-A", maxTasks: 5 } });
  const regB = await api("POST", "/api/agents", { agentId: B, body: { name: "worker-B", maxTasks: 5 } });
  const regL = await api("POST", "/api/agents", { agentId: LEAD, body: { name: "lead", isLead: true } });
  check([200, 201].includes(regA.status), "agent A registered", regA.status);
  check([200, 201].includes(regB.status), "agent B registered", regB.status);
  check([200, 201].includes(regL.status), "lead registered", regL.status);

  // ════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — gone-agent reaper (#3). Run first: leaves no in_progress/no-session
  // task lingering, so scenario 2's crash sweep stays clean.
  // ════════════════════════════════════════════════════════════════════════════
  section("Scenario 1: gone-agent → reaper escalates to Lead reroute-decision (#3)");

  const t2r = await api("POST", "/api/tasks", { body: { task: "DES-523 E2E gone-agent task", agentId: A, source: "api" } });
  check(t2r.status === 201, "created task T2 pinned to A", t2r.status);
  const t2 = t2r.body?.id;
  check(t2r.body?.status === "pending" && t2r.body?.agentId === A, "T2 is pending + agentId=A", { status: t2r.body?.status, agentId: t2r.body?.agentId });

  const pollA2 = await api("GET", "/api/poll", { agentId: A });
  check(pollA2.body?.trigger?.type === "task_assigned" && pollA2.body?.trigger?.taskId === t2, "A polls → T2 assigned (in_progress, NO session created)", pollA2.body?.trigger);

  console.log(`  … waiting ${WAIT_STALL_MS}ms for T2 to age past STALL_NO_SESSION_MIN`);
  await sleep(WAIT_STALL_MS);
  const sweep1 = await api("POST", "/api/heartbeat/sweep");
  check(sweep1.body?.success === true, "sweep #1 completed (classify crash)", sweep1.body);

  let tasks = await listTasks();
  const t2row = byId(tasks, t2);
  check(t2row?.status === "superseded", "T2 superseded by crash classifier", t2row?.status);
  const r2 = findResumeChild(tasks, t2);
  check(!!r2, "a resume child R2 was created for T2");
  check(r2?.status === "pending", "R2 status=pending", r2?.status);
  check(r2?.agentId === A, "R2 pinned to A (NOT unassigned)", r2?.agentId);
  check(Array.isArray(r2?.tags) && r2.tags.includes(PIN_TAG), "R2 tagged crash-recovery-pin", r2?.tags);

  console.log(`  … waiting ${WAIT_GRACE_MS}ms for R2 to age past RESUME_PIN_GRACE_MIN (no reclaim)`);
  await sleep(WAIT_GRACE_MS);
  const sweep2 = await api("POST", "/api/heartbeat/sweep");
  check(sweep2.body?.success === true, "sweep #2 completed (reaper escalation)", sweep2.body);

  tasks = await listTasks();
  const r2after = byId(tasks, r2?.id);
  check(r2after?.status === "cancelled", "R2 cancelled by reaper", r2after?.status);
  check(r2after?.failureReason === "pin_unreclaimed_escalated", "R2 failureReason=pin_unreclaimed_escalated", r2after?.failureReason);
  const decisions = findByType(tasks, "reroute-decision", t2);
  check(decisions.length === 1, "exactly one Lead reroute-decision task created", decisions.length);
  const d = decisions[0];
  check(d?.agentId === LEAD, "reroute-decision is Lead-owned", d?.agentId);
  check(d?.status === "pending", "reroute-decision is pending", d?.status);
  check(Array.isArray(d?.tags) && d.tags.includes("reroute-decision"), "reroute-decision tagged reroute-decision", d?.tags);
  const t2final = byId(tasks, t2);
  check(t2final?.agentId === A && t2final?.status === "superseded", "original T2 NOT reassigned to Lead (still superseded, agentId=A)", { agentId: t2final?.agentId, status: t2final?.status });

  // Idempotency: a third sweep must not create a duplicate decision or new resume.
  const sweep3 = await api("POST", "/api/heartbeat/sweep");
  check(sweep3.body?.success === true, "sweep #3 completed (idempotency check)", sweep3.body);
  tasks = await listTasks();
  check(findByType(tasks, "reroute-decision", t2).length === 1, "still exactly one reroute-decision (idempotent)", findByType(tasks, "reroute-decision", t2).length);
  const resumesForT2 = tasks.filter((t) => t.taskType === "resume" && t.parentTaskId === t2);
  check(resumesForT2.length === 1, "no duplicate resume created for T2 on re-sweep", resumesForT2.length);

  // ════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — pin + same-agent reclaim + no role-blind grab (#1, #2, #4).
  // Run last: A's reclaimed R1 stays in_progress/no-session but no further sweep
  // runs, so it is never re-crashed.
  // ════════════════════════════════════════════════════════════════════════════
  section("Scenario 2: crash pin → A reclaims, B cannot (#1, #2, #4)");

  const t1r = await api("POST", "/api/tasks", { body: { task: "DES-523 E2E reclaim task", agentId: A, source: "api" } });
  check(t1r.status === 201, "created task T1 pinned to A", t1r.status);
  const t1 = t1r.body?.id;

  const pollA1 = await api("GET", "/api/poll", { agentId: A });
  check(pollA1.body?.trigger?.taskId === t1, "A polls → T1 assigned (in_progress, NO session)", pollA1.body?.trigger);

  console.log(`  … waiting ${WAIT_STALL_MS}ms for T1 to age past STALL_NO_SESSION_MIN`);
  await sleep(WAIT_STALL_MS);
  const sweepP = await api("POST", "/api/heartbeat/sweep");
  check(sweepP.body?.success === true, "crash sweep completed", sweepP.body);

  tasks = await listTasks();
  check(byId(tasks, t1)?.status === "superseded", "T1 superseded", byId(tasks, t1)?.status);
  const r1 = findResumeChild(tasks, t1);
  check(!!r1, "resume child R1 created for T1");
  check(r1?.status === "pending" && r1?.agentId === A, "R1 pending + pinned to A (#1)", { status: r1?.status, agentId: r1?.agentId });
  check(Array.isArray(r1?.tags) && r1.tags.includes(PIN_TAG), "R1 tagged crash-recovery-pin", r1?.tags);

  // #4: worker B polls and must NOT receive A's pin.
  const pollB = await api("GET", "/api/poll", { agentId: B });
  const bGotPin = pollB.body?.trigger?.type === "task_assigned";
  check(!bGotPin, "B's poll does NOT return a task_assigned trigger (#4)", pollB.body?.trigger ?? null);
  tasks = await listTasks();
  const r1afterB = byId(tasks, r1?.id);
  check(r1afterB?.status === "pending" && r1afterB?.agentId === A, "R1 still pending + pinned to A after B polled (#4)", { status: r1afterB?.status, agentId: r1afterB?.agentId });

  // #2: A polls again and reclaims its own pin.
  const pollA3 = await api("GET", "/api/poll", { agentId: A });
  check(pollA3.body?.trigger?.type === "task_assigned" && pollA3.body?.trigger?.taskId === r1?.id, "A reclaims R1 on its next poll (#2)", pollA3.body?.trigger);
  tasks = await listTasks();
  const r1reclaimed = byId(tasks, r1?.id);
  check(r1reclaimed?.status === "in_progress" && r1reclaimed?.agentId === A, "R1 now in_progress, agentId=A (#2)", { status: r1reclaimed?.status, agentId: r1reclaimed?.agentId });

  // ── Global invariants ──
  section("Global invariants");
  tasks = await listTasks();
  const bTasks = tasks.filter((t) => t.agentId === B);
  check(bTasks.length === 0, "worker B never owned any task (no role-blind grab anywhere)", bTasks.map((t) => ({ id: t.id, type: t.taskType, status: t.status })));
  const unassignedResumes = tasks.filter((t) => t.taskType === "resume" && t.status === "unassigned");
  check(unassignedResumes.length === 0, "no crash resume ever fell to the unassigned pool", unassignedResumes.length);

  exitCode = fail === 0 ? 0 : 1;
} catch (err) {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  section("Summary");
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  if (fail > 0) {
    console.log(`  Failed assertions:`);
    for (const f of failures) console.log(`    - ${f}`);
    console.log(`\n  Last server log lines (${LOG_PATH}):`);
    try {
      const log = await Bun.file(LOG_PATH).text();
      console.log(
        log
          .split("\n")
          .slice(-30)
          .map((l) => `    | ${l}`)
          .join("\n"),
      );
    } catch {}
  }
  console.log(`\n${fail === 0 ? "RESULT: PASS ✅" : "RESULT: FAIL ❌"}`);
  cleanup();
  process.exit(exitCode);
}
