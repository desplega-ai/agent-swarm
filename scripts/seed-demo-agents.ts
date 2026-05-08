/**
 * Seed dummy agents into a running swarm so the home page Activity panel +
 * workers milestone show interesting state.
 *
 * Usage:
 *   bun run scripts/seed-demo-agents.ts
 *   API_BASE_URL=http://localhost:3013 API_KEY=123123 bun run scripts/seed-demo-agents.ts
 *
 * What it creates (5 agents covering all 4 statuses):
 *   - 1 lead       (idle, recent heartbeat)
 *   - 1 worker     (idle, recent heartbeat)
 *   - 1 worker     (busy, recent heartbeat — set via credential-ready + a fake claim)
 *   - 1 worker     (waiting_for_credentials)
 *   - 1 worker     (offline — last heartbeat 1h ago, status forced via direct DB update)
 *
 * The "offline" agent requires a direct DB update because there's no public
 * endpoint to mark an agent offline (offline is normally inferred by absence
 * of heartbeat). We use bun:sqlite directly — fine for a local seed script,
 * since the DB-boundary rule applies to runtime code, not admin scripts.
 */

import { Database } from "bun:sqlite";

const API = process.env.API_BASE_URL || "http://localhost:3013";
const KEY = process.env.API_KEY || "123123";
const DB_PATH = process.env.DB_PATH || "agent-swarm-db.sqlite";

const headers = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function registerAgent(payload: {
  name: string;
  isLead?: boolean;
  description?: string;
  role?: string;
  capabilities?: string[];
  maxTasks?: number;
  harness_provider?: string;
}): Promise<{ id: string }> {
  const r = await fetch(`${API}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`register ${payload.name}: HTTP ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { id: string };
  return body;
}

async function setCredentialStatus(id: string, ready: boolean, missing: string[] = []) {
  const r = await fetch(`${API}/api/agents/${id}/credential-status`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ready, missing }),
  });
  if (!r.ok) throw new Error(`credential-status ${id}: HTTP ${r.status} ${await r.text()}`);
}

async function main() {
  console.log(`seeding via ${API}…`);

  // 1. Lead, idle, recent heartbeat (auto on register).
  const lead = await registerAgent({
    name: "demo-lead",
    isLead: true,
    description: "Demo lead — orchestrates the swarm.",
    role: "Lead",
    capabilities: ["routing", "task-assignment"],
    maxTasks: 10,
    harness_provider: "claude",
  });
  console.log(`  ✓ lead              ${lead.id}  (idle, recent heartbeat)`);

  // 2. Worker, idle, recent heartbeat.
  const idleWorker = await registerAgent({
    name: "demo-worker-idle",
    description: "Idle worker, ready for tasks.",
    role: "Worker",
    capabilities: ["typescript", "tests"],
    maxTasks: 3,
    harness_provider: "claude",
  });
  console.log(`  ✓ worker (idle)     ${idleWorker.id}`);

  // 3. Worker, busy, recent heartbeat. Mark credential-ready first; the "busy"
  //    state is a runtime artifact of claiming a task, so for a static demo we
  //    settle for ready=true + a direct DB nudge below.
  const busyWorker = await registerAgent({
    name: "demo-worker-busy",
    description: "Busy worker — pretending to chew on a task.",
    role: "Worker",
    capabilities: ["typescript", "react"],
    maxTasks: 2,
    harness_provider: "claude",
  });
  await setCredentialStatus(busyWorker.id, true);
  console.log(`  ✓ worker (busy)     ${busyWorker.id}`);

  // 4. Worker, waiting_for_credentials.
  const blockedWorker = await registerAgent({
    name: "demo-worker-blocked",
    description: "Blocked on creds — won't claim tasks until set.",
    role: "Worker",
    capabilities: ["python"],
    maxTasks: 1,
    harness_provider: "codex",
  });
  await setCredentialStatus(blockedWorker.id, false, ["OPENAI_API_KEY"]);
  console.log(`  ✓ worker (blocked)  ${blockedWorker.id}  (waiting_for_credentials)`);

  // 5. Worker, offline. No public endpoint for this — write directly.
  const offlineWorker = await registerAgent({
    name: "demo-worker-offline",
    description: "Stale worker — last seen an hour ago.",
    role: "Worker",
    capabilities: ["go"],
    maxTasks: 1,
    harness_provider: "claude",
  });

  // Direct DB writes to set lastActivityAt + status. The register endpoint
  // doesn't bump lastActivityAt, so without this the workers milestone stays
  // at `configured` forever. Format must match `updateAgentActivity` in
  // src/be/db.ts (`%Y-%m-%dT%H:%M:%fZ`).
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  const now = new Date().toISOString(); // already ISO-8601-with-millis
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

  const setHeartbeat = db.prepare(
    "UPDATE agents SET lastActivityAt = ?1 WHERE id = ?2",
  );
  const setStatusAndHeartbeat = db.prepare(
    "UPDATE agents SET status = ?1, lastActivityAt = ?2 WHERE id = ?3",
  );

  // Recent heartbeats for the "online" 4 agents.
  setHeartbeat.run(now, lead.id);
  setHeartbeat.run(now, idleWorker.id);
  setStatusAndHeartbeat.run("busy", now, busyWorker.id);
  setHeartbeat.run(now, blockedWorker.id);
  // Stale heartbeat + offline status for the 5th.
  setStatusAndHeartbeat.run("offline", oneHourAgo, offlineWorker.id);
  db.close();
  console.log(`  ✓ worker (offline)  ${offlineWorker.id}  (lastActivityAt = ${oneHourAgo})`);
  console.log("");
  console.log(`  (heartbeats seeded directly: 4 recent, 1 stale)`);

  console.log("");
  console.log("done. /status should now show:");
  console.log("  - workers milestone: verified (lead + worker with recent heartbeats)");
  console.log("  - activity: leads_online=1, agents_online=3 (idle+busy+blocked, NOT offline)");
}

await main();
