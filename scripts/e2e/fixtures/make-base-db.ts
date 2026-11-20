#!/usr/bin/env bun
// Builds the "database made by the base commit" fixture of check 10 (Postgres brief).
// It boots the API of an older checkout on an empty SQLite file, writes known rows
// through the public API, stops it, and stores the database file gzipped. The upgrade
// scenario unpacks the file and boots the current code on it.
//
// Usage: bun scripts/e2e/fixtures/make-base-db.ts <checkout of the base commit>
// Writes: scripts/e2e/fixtures/base-db.sqlite.gz and base-db.json next to this file.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkout = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: make-base-db.ts <base checkout>");
const commit = (await Bun.$`git -C ${checkout} rev-parse HEAD`.text()).trim();
const dir = mkdtempSync(join(tmpdir(), "e2e-base-db-"));
const dbPath = join(dir, "base.sqlite");
const keyPath = join(dir, "key");
const secretsKey = randomBytes(32).toString("base64");
await Bun.write(keyPath, secretsKey);
const apiKey = "base-fixture-key";
const port = 30_000 + Math.floor(Math.random() * 20_000);
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: dir,
  PORT: String(port),
  API_KEY: apiKey,
  AGENT_SWARM_API_KEY: apiKey,
  DATABASE_PATH: dbPath,
  SECRETS_ENCRYPTION_KEY_FILE: keyPath,
  NODE_ENV: "test",
  DESPLEGA_TELEMETRY_ENV: "test",
  ANONYMIZED_TELEMETRY: "false",
  SLACK_DISABLE: "true",
  GITHUB_DISABLE: "true",
  LINEAR_DISABLE: "true",
  JIRA_DISABLE: "true",
  AGENTMAIL_DISABLE: "true",
  HEARTBEAT_CHECKLIST_DISABLE: "true",
  MULTI_RUNTIME_ENABLED: "false",
  AGENT_FS_LOCAL_DIR: join(dir, "fs"),
};
const child = Bun.spawn(["bun", "--no-orphans", "run", "src/http.ts"], {
  cwd: checkout,
  env,
  stdout: Bun.file(join(dir, "api.log")),
  stderr: Bun.file(join(dir, "api.err.log")),
});
const base = `http://127.0.0.1:${port}`;
const api = async (method: string, path: string, body?: unknown, agentId?: string) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(agentId ? { "X-Agent-ID": agentId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
};
try {
  for (let i = 0; ; i++) {
    if (i > 240) throw new Error(`base API did not start; see ${dir}/api.err.log`);
    const ok = await fetch(`${base}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await Bun.sleep(250);
  }
  const agent = await api("POST", "/api/agents", {
    name: "base-fixture-worker",
    role: "worker",
    status: "online",
  });
  const agentId = String(agent.id);
  const task = await api("POST", "/api/tasks", {
    task: "base fixture task",
    agentId,
    routingReason: "human_pinned",
    source: "api",
  });
  const schedule = await api("POST", "/api/schedules", {
    name: "base-fixture-schedule",
    cronExpression: "0 0 1 1 *",
    taskTemplate: "base fixture schedule task",
    targetAgentId: agentId,
  });
  await api("PUT", "/api/config", {
    scope: "global",
    key: "BASE_FIXTURE_PLAIN",
    value: "plain-value",
    isSecret: false,
  });
  await api("PUT", "/api/config", {
    scope: "global",
    key: "BASE_FIXTURE_SECRET",
    value: "secret-value",
    isSecret: true,
  });
  child.kill("SIGTERM");
  await child.exited;
  // Fold the WAL into the main file so the single file holds every row.
  await Bun.$`sqlite3 ${dbPath} "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;"`.quiet();
  const bytes = new Uint8Array(await Bun.file(dbPath).arrayBuffer());
  const out = import.meta.dir;
  await Bun.write(join(out, "base-db.sqlite.gz"), Bun.gzipSync(bytes, { level: 9 }));
  await Bun.write(
    join(out, "base-db.json"),
    `${JSON.stringify(
      {
        commit,
        note: "Made by make-base-db.ts. secretsKey is a throwaway test key for BASE_FIXTURE_SECRET only.",
        secretsKey,
        agentId,
        taskId: String(task.id),
        scheduleId: String(
          (schedule.schedule as Record<string, unknown> | undefined)?.id ?? schedule.id,
        ),
        config: { BASE_FIXTURE_PLAIN: "plain-value", BASE_FIXTURE_SECRET: "secret-value" },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`fixture from ${commit}: ${bytes.length} bytes of SQLite file`);
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
