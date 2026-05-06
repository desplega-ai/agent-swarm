#!/usr/bin/env bun
/**
 * One-shot helper: import every module in this repo that calls `ensure(...)`,
 * fire each event once with synthetic data, and let the BU SDK auto-register
 * the nodes. Used by `bun run docs:business-use` so the generated table
 * reflects the live `ensure(...)` call sites without needing to actually
 * exercise the full server lifecycle.
 *
 * Requires `BUSINESS_USE_URL` and `BUSINESS_USE_API_KEY` envs pointing at a
 * running BU backend.
 */
import { ensure, initialize, shutdown } from "@desplega.ai/business-use";

initialize();

const fakeRun = `seed_${Date.now()}`;

// Task flow ─────────────────────────────────────────────────────────────────
ensure({ id: "created", flow: "task", runId: fakeRun, data: { taskId: fakeRun } });
ensure({
  id: "started",
  flow: "task",
  runId: fakeRun,
  depIds: ["created"],
  data: { previousStatus: "pending" },
  validator: (d) => d.previousStatus === "pending",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 300_000 }],
});
ensure({
  id: "cancelled_pending",
  flow: "task",
  runId: `${fakeRun}_cp`,
  depIds: ["created"],
  data: { previousStatus: "pending" },
  validator: (d) => d.previousStatus === "pending",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 86_400_000 }],
});
ensure({
  id: "cancelled_in_progress",
  flow: "task",
  runId: `${fakeRun}_cip`,
  depIds: ["started"],
  data: { previousStatus: "in_progress" },
  validator: (d) => d.previousStatus === "in_progress" || d.previousStatus === "paused",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 3_600_000 }],
});
ensure({
  id: "paused",
  flow: "task",
  runId: `${fakeRun}_p`,
  depIds: ["started"],
  data: { previousStatus: "in_progress" },
  validator: (d) => d.previousStatus === "in_progress",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 3_600_000 }],
});
ensure({
  id: "resumed",
  flow: "task",
  runId: `${fakeRun}_r`,
  depIds: ["paused"],
  data: { previousStatus: "paused" },
  validator: (d) => d.previousStatus === "paused",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 86_400_000 }],
});
ensure({
  id: "completed",
  flow: "task",
  runId: `${fakeRun}_done`,
  depIds: ["started"],
  data: { previousStatus: "in_progress" },
  validator: (d) => d.previousStatus === "in_progress",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 3_600_000 }],
});
ensure({
  id: "failed",
  flow: "task",
  runId: `${fakeRun}_fail`,
  depIds: ["started"],
  data: { previousStatus: "in_progress" },
  validator: (d) => d.previousStatus === "in_progress",
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 3_600_000 }],
});
ensure({
  id: "worker_received",
  flow: "task",
  runId: `${fakeRun}_wr`,
  depIds: ["started"],
  data: { taskId: fakeRun },
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 60_000 }],
});
ensure({
  id: "worker_process_spawned",
  flow: "task",
  runId: `${fakeRun}_wps`,
  depIds: ["worker_received"],
  data: { taskId: fakeRun },
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 60_000 }],
});
ensure({
  id: "worker_process_finished",
  flow: "task",
  runId: `${fakeRun}_wpf`,
  depIds: ["worker_process_spawned"],
  data: { exitCode: 0 },
  validator: (d) => d.exitCode === 0,
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 3_600_000 }],
});

// Memory rater v1.5 — new in step-7 ─────────────────────────────────────────
ensure({
  id: "memory_retrieved",
  flow: "task",
  runId: `${fakeRun}_mret`,
  data: { count: 1, taskId: fakeRun, agentId: "seed-agent" },
  validator: (data) =>
    typeof data.count === "number" &&
    data.count > 0 &&
    typeof data.taskId === "string" &&
    data.taskId.length > 0 &&
    typeof data.agentId === "string" &&
    data.agentId.length > 0,
});
ensure({
  id: "memory_rated",
  flow: "task",
  runId: `${fakeRun}_mrate`,
  data: {
    memoryId: "seed-memory",
    source: "seed",
    signal: 1,
    weight: 1,
    hasReferencesSource: false,
  },
  validator: (data) =>
    typeof data.memoryId === "string" &&
    data.memoryId.length > 0 &&
    typeof data.source === "string" &&
    data.source.length > 0 &&
    typeof data.signal === "number" &&
    data.signal >= -1 &&
    data.signal <= 1 &&
    typeof data.weight === "number" &&
    data.weight >= 0 &&
    data.weight <= 1,
});

// Agent flow ────────────────────────────────────────────────────────────────
ensure({
  id: "registered",
  flow: "agent",
  runId: `agent_${fakeRun}`,
  data: { agentId: `agent_${fakeRun}` },
});
ensure({
  id: "reconnected",
  flow: "agent",
  runId: `agent_${fakeRun}`,
  depIds: ["registered"],
  data: {},
  validator: (_d, ctx) => ctx.deps.length > 0,
  filter: (_d, ctx) => ctx.deps.length > 0,
  conditions: [{ timeout_ms: 86_400_000 }],
});

// API flow ──────────────────────────────────────────────────────────────────
ensure({ id: "listen", flow: "api", runId: `api_${fakeRun}`, data: {} });
ensure({
  id: "scheduler_started",
  flow: "api",
  runId: `api_${fakeRun}`,
  depIds: ["listen"],
  data: { capabilities: ["scheduling"] },
  validator: (d) => Array.isArray(d.capabilities) && d.capabilities.includes("scheduling"),
  filter: (d) => Array.isArray(d.capabilities) && d.capabilities.includes("scheduling"),
  conditions: [{ timeout_ms: 10_000 }],
});

await shutdown(10_000);
console.log("Seeded BU nodes.");
