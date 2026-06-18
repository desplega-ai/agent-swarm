---
date: 2026-06-18
author: Taras + Claude
topic: "DES-523 crash-recovery same-agent pin — Manual E2E evidence"
status: part-1-complete
branch: fix/heartbeat-same-agent-pin-des-523
pr: 791
tags: [qa, e2e, heartbeat, crash-recovery, des-523]
---

# DES-523 crash-recovery E2E — evidence

Manual E2E for the same-agent crash-recovery pin (PR #791). Implementation was
already complete/reviewed; this is the live E2E (approach C).

## Result summary

- **Part 1 (scripted API-level E2E): ✅ PASS — 38/38 assertions, deterministic
  across repeated runs.** Covers all four gaps the unit tests can't reach (#1–#4)
  by driving the **real API server** over HTTP with shortened thresholds, no
  worker containers, no LLM.
- **Part 2 (Docker happy-path, real container restart-and-reclaim): ✅ PASS —
  11/11 core assertions.** A real pi/deepseek worker container is SIGKILL'd
  mid-task, crash-detected, the resume is pinned to its stable `AGENT_ID`, and the
  **restarted same-ID container reclaims and runs it via its real poll loop**.
  (One honest caveat — the resume didn't reach `completed`; see Part 2 below.)
- **Part 3 (gone-agent): deterministic half proven by Part 1 Scenario 1** (reaper
  → Lead reroute-decision). The soft/manual "Lead LLM actually re-delegates via
  `send-task(agentId=B)`" was **not exercised** (Part 1 ran headless; Part 2 ran
  with no Lead). Lower priority and LLM-dependent — left for a future run.

## What was proven (gap → assertion)

| Gap (handoff) | Proven by |
|---|---|
| **#1** crashed task pinned to its own stable-id agent (status=pending, tag `crash-recovery-pin`), NOT unassigned | Scenario 1 (R2) + Scenario 2 (R1) |
| **#2** the same agent reclaims the pending pin via its real poll loop | Scenario 2 (A re-polls → R1 → in_progress) — *at the API/poll level; real container restart is Part 2* |
| **#3** gone-agent → reaper cancels the unreclaimed pin (`pin_unreclaimed_escalated`) + creates exactly one Lead-owned `reroute-decision` referencing the original; original NOT reassigned to Lead; idempotent | Scenario 1 |
| **#4** no role-blind grab — worker B never claims A's pin | Scenario 2 (B polls, gets nothing) + global invariant (B owned 0 tasks) |

## Method (how the live parts were reached without a worker)

- **Crash simulation (Case A) with no worker / no LLM:** `GET /api/poll` flips a
  pinned task to `in_progress` via `startTask` and **never** creates an
  `active_sessions` row. So one poll = the exact "crashed worker, no session"
  state the classifier (`detectAndRemediateStalledTasks`, no session + task age ≥
  threshold) treats as a dead worker. Verified in source: `insertActiveSession`
  is only ever called by `POST /api/active-sessions`, never by the poll/claim path.
- **On-demand sweeps:** `POST /api/heartbeat/sweep` runs the full
  classifier + reaper synchronously — deterministic, no waiting on the timer.
- **Fractional-minute thresholds:** `HEARTBEAT_STALL_NO_SESSION_MIN=0.1` (=6s) and
  `HEARTBEAT_RESUME_PIN_GRACE_MIN=0.1` (=6s). Note `STALL_NO_SESSION_MIN` is parsed
  `Number(env) || 5`, so `=0` falls back to 5 — but `0.1` is truthy and works; the
  grace uses `?? "10"` so `0`/fractional both behave. Waits are 9s, clearing 6s
  with margin.
- **Background timer parked:** `HEARTBEAT_INTERVAL_MS=3600000` (1h) so the only
  automatic sweep is the one-shot boot sweep; every other sweep is driven by the
  script.
- **Isolated DB:** `DATABASE_PATH` points at a fresh tmp file — the repo's
  `agent-swarm-db.sqlite` is never touched.
- **Scenario ordering:** reaper scenario first, then pin+reclaim — so the
  reclaimed (in_progress, sessionless) R1 is never re-crashed by a later sweep,
  avoiding cross-scenario contamination without session-protection hacks.

### Gotcha found (non-product): boot reboot-sweep race

`startHeartbeat` schedules a one-shot `runRebootSweep()` + immediate normal sweep
at **(server-init)+5s**. If the test creates+polls a task before that fires, the
reboot sweep retries it as a `reboot-retry` child and derails everything. Fix: the
harness waits 10s after readiness so the boot sweep fires on the **empty** DB
(confirmed via the `"Reboot sweep: no in-progress tasks found"` log marker, and
the absence of any `"Reboot retry created"`). This is a test-harness concern, not
a product bug. (Also: Bun's `FileSink` does not truncate on open, so the log file
must be truncated each run.)

## Full run output (final, clean boot)

```
── Boot ──
  ✓ API server is up and authenticating
  … waiting 10000ms for the boot reboot-sweep to fire on the empty DB
  ✓ boot reboot-sweep fired on empty DB, retried nothing (no startup race)

── Register agents A, B, Lead ──
  ✓ agent A registered
  ✓ agent B registered
  ✓ lead registered

── Scenario 1: gone-agent → reaper escalates to Lead reroute-decision (#3) ──
  ✓ created task T2 pinned to A
  ✓ T2 is pending + agentId=A
  ✓ A polls → T2 assigned (in_progress, NO session created)
  ✓ sweep #1 completed (classify crash)
  ✓ T2 superseded by crash classifier
  ✓ a resume child R2 was created for T2
  ✓ R2 status=pending
  ✓ R2 pinned to A (NOT unassigned)
  ✓ R2 tagged crash-recovery-pin
  ✓ sweep #2 completed (reaper escalation)
  ✓ R2 cancelled by reaper
  ✓ R2 failureReason=pin_unreclaimed_escalated
  ✓ exactly one Lead reroute-decision task created
  ✓ reroute-decision is Lead-owned
  ✓ reroute-decision is pending
  ✓ reroute-decision tagged reroute-decision
  ✓ original T2 NOT reassigned to Lead (still superseded, agentId=A)
  ✓ sweep #3 completed (idempotency check)
  ✓ still exactly one reroute-decision (idempotent)
  ✓ no duplicate resume created for T2 on re-sweep

── Scenario 2: crash pin → A reclaims, B cannot (#1, #2, #4) ──
  ✓ created task T1 pinned to A
  ✓ A polls → T1 assigned (in_progress, NO session)
  ✓ crash sweep completed
  ✓ T1 superseded
  ✓ resume child R1 created for T1
  ✓ R1 pending + pinned to A (#1)
  ✓ R1 tagged crash-recovery-pin
  ✓ B's poll does NOT return a task_assigned trigger (#4)
  ✓ R1 still pending + pinned to A after B polled (#4)
  ✓ A reclaims R1 on its next poll (#2)
  ✓ R1 now in_progress, agentId=A (#2)

── Global invariants ──
  ✓ worker B never owned any task (no role-blind grab anywhere)
  ✓ no crash resume ever fell to the unassigned pool

── Summary ──
  PASS: 38   FAIL: 0
RESULT: PASS ✅
```

Corroborating server log lines (from the same run):

```
[Heartbeat] Auto-superseded task <T2> — pinned resume <R2> to original agent aaaaaaaa (no active session)
[Heartbeat] Sweep complete: auto_resumed=1, pinned_resumes=1
[Heartbeat] Escalated unreclaimed pinned resume <R2> → Lead reroute-decision <D> (original <T2>)
[Heartbeat] Sweep complete: escalated_reroutes=1
```

## Part 2 — focused Docker happy-path (real restart-and-reclaim)

Setup: `docker compose -f docker-compose.local.yml -f docker-compose.des523-override.yml
up -d api pi-worker`. The override (temporary, not committed) put shortened
heartbeat thresholds on `api` (`STALL_STALE_HB_MIN=1`, `STALL_NO_SESSION_MIN=1`,
`RESUME_PIN_GRACE_MIN=10`, `INTERVAL_MS=10000`), set `restart: "no"` on the worker
(so a SIGKILL'd container stays down until `docker start`), and pinned the model to
`openrouter/deepseek/deepseek-v4-flash`. Only `api` + one pi-worker (agent
`A=cfecf31f…`); the **api image was rebuilt from this branch**, the worker image
(6.5 GB, ~10 days old) reused — DES-523's changes are all API-side, none in the
worker poll/runner code. Clean DB (api has no DB volume; `down -v` first).

Flow + result (11/11 core assertions PASS):

1. Task pinned to A → A picks it up (in_progress) and creates a real
   `active_session` within ~1s. ✓
2. `docker kill swarm-pi-worker` (SIGKILL → no graceful `POST /close` → agent NOT
   offlined; the stale `active_session` drives **Case B** detection). Container
   stayed down (`restart: "no"`). ✓
3. After ~62s the heartbeat superseded the original and **pinned the resume to A**
   (`crash-recovery-pin`, gen 1, agentId=A, never unassigned). ✓
4. `docker start swarm-pi-worker` (same `AGENT_ID`) → **A reclaimed its own pin in
   ~6s** (in_progress, agentId=A) and spawned pi-mono to run it. ✓
5. Global invariants: no resume ever unassigned; every resume row owned solely by
   A. ✓

Worker log proving the reclaim hop on the restarted container:

```
[boot] credentials ready (provider=pi, satisfiedBy=file)
[worker] Trigger received: task_assigned
[worker] Injected resume preamble for resume task (parent: afdebc7d)
[worker] ▸ Spawning pi-mono for task 64793af2   ← restarted same-ID worker ran the resume
```

### Honest caveat: resume did not reach `completed`

The resume's terminal status was `superseded`, not `completed`. Root cause from
the worker log:

```
[worker] stderr: [pi-mono] Auto-retry attempt 1/3: Upstream idle timeout exceeded
[worker] stderr: [pi-mono] Auto-retry attempt 2/3: Upstream idle timeout exceeded
```

`deepseek-v4-flash` (via OpenRouter) hit repeated **upstream idle timeouts**. Those
retries ate past the deliberately-aggressive **1-min** `STALL_NO_SESSION_MIN`, so
the API's stall detector superseded gen-1 (no session registered in time) and
minted **gen-2 — which also correctly re-pinned to A** (`afdebc7d → 64793af2(gen1,
superseded) → 3252e0e2(gen2, pending, agentId=A)`); the agent then claimed gen-2.
This is a **model-provider slowness + unrealistic test threshold** artifact, NOT a
DES-523 defect: in prod `STALL_NO_SESSION_MIN=5min` leaves ample room, and the
same-agent-pin invariant held across every generation. The unique thing Part 2
exists to prove — real container kill → same-`AGENT_ID` restart → reclaim — is
fully demonstrated.

## Still not covered (low priority)

- The **Lead LLM actually re-delegating** the `reroute-decision` via
  `send-task(agentId=<B>)` — Part 1 proved the decision task is *created*
  correctly; the Lead's subsequent LLM action was not exercised (no Lead in the
  Part 2 run). LLM-dependent; left for a future run if desired.
- A clean **full resume→completion** on a real worker (blocked here only by
  deepseek upstream timeouts); re-runnable with a more reliable model + realistic
  thresholds.

## Reproduce

**Part 1** — self-contained Bun harness (spawns the server, drives HTTP, asserts,
tears down):

```bash
bun run /tmp/des523-e2e/e2e.ts     # exit 0 = all pass
```

**Part 2** — bring up a real worker, then drive kill/restart:

```bash
# 1. write docker-compose.des523-override.yml (see below), then:
docker compose -f docker-compose.local.yml -f docker-compose.des523-override.yml down -v
docker compose -f docker-compose.local.yml -f docker-compose.des523-override.yml build api
docker compose -f docker-compose.local.yml -f docker-compose.des523-override.yml up -d api pi-worker
# 2. once the worker registers (GET /api/agents):
bun run /tmp/des523-e2e/part2.ts
# 3. cleanup:
docker compose -f docker-compose.local.yml -f docker-compose.des523-override.yml down -v
```

<details>
<summary>docker-compose.des523-override.yml (temporary, not committed)</summary>

```yaml
services:
  api:
    environment:
      - HEARTBEAT_STALL_STALE_HB_MIN=1
      - HEARTBEAT_STALL_NO_SESSION_MIN=1
      - HEARTBEAT_RESUME_PIN_GRACE_MIN=10
      - HEARTBEAT_INTERVAL_MS=10000
  pi-worker:
    restart: "no"
    environment:
      - MODEL_OVERRIDE=openrouter/deepseek/deepseek-v4-flash
```

</details>

(`part2.ts` source preserved at `/tmp/des523-e2e/part2.ts`.)

Script source is preserved at `/tmp/des523-e2e/e2e.ts` (embedded below for
durability — `/tmp` is ephemeral). Recreate the file and run from the repo root.

<details>
<summary>e2e.ts (full harness)</summary>

```ts
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
 * is never touched.
 *
 * Run from repo root:  bun run /tmp/des523-e2e/e2e.ts
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
const proc = Bun.spawn(["bun", "--expose-gc", "src/http.ts"], {
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
```

</details>
