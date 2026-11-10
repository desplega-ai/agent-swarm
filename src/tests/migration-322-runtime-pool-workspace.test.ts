import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";
import {
  ControllerClientMessageSchema,
  ControllerCommandSchema,
} from "../runtime-providers/controller-protocol";

async function applyUpTo(db: Database, last: number): Promise<void> {
  db.exec(
    "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
  );
  for (const file of [...new Bun.Glob("*.sql").scanSync("src/be/migrations")]
    .sort()
    .filter((file) => Number(file.split("_")[0]) <= last)) {
    const sql = await Bun.file(`src/be/migrations/${file}`).text();
    db.transaction(() => {
      db.exec(sql);
      db.run("INSERT INTO _migrations VALUES (?, ?, ?, ?)", [
        Number(file.split("_")[0]),
        file.replace(".sql", ""),
        new Date().toISOString(),
        new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
      ]);
    }).immediate();
  }
}

test("migration 322 adds nullable workspace columns to a fresh database", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    expect(db.query("PRAGMA table_info(runtime_pools)").all()).toContainEqual(
      expect.objectContaining({ name: "workspace", type: "TEXT", notnull: 0 }),
    );
    expect(db.query("PRAGMA table_info(runtime_instances)").all()).toContainEqual(
      expect.objectContaining({ name: "workspace_slot", type: "INTEGER", notnull: 0 }),
    );
  } finally {
    db.close();
  }
});

test("migration 322 keeps existing rows ephemeral and fences one live runtime per slot", async () => {
  const db = new Database(":memory:");
  try {
    await applyUpTo(db, 321);
    db.run(
      "INSERT INTO runtime_pools (id, name, kind, placements, image, env, lifecycle) VALUES ('pool', 'pool', 'docker', '[\"c\"]', 'worker:test', '{}', 'idle')",
    );
    db.run(
      "INSERT INTO agents (id, name, isLead, status, createdAt, lastUpdatedAt) VALUES ('agent', 'agent', 0, 'idle', '2026-01-01', '2026-01-01')",
    );
    db.run(
      "INSERT INTO runtime_instances (id, agent_id, status, reported_slots) VALUES ('old', 'agent', 'active', 1)",
    );
    runMigrations(db);
    expect(db.query("SELECT workspace FROM runtime_pools").get()).toEqual({ workspace: null });
    expect(db.query("SELECT workspace_slot FROM runtime_instances").get()).toEqual({
      workspace_slot: null,
    });
    expect(() => db.run("UPDATE runtime_pools SET workspace = 'not json'")).toThrow();
    expect(() => db.run("UPDATE runtime_instances SET workspace_slot = -1")).toThrow();

    const insert = (id: string, status: string) =>
      db.run(
        "INSERT INTO runtime_instances (id, agent_id, status, reported_slots, workspace_slot) VALUES (?, 'agent', ?, 1, 0)",
        [id, status],
      );
    insert("a", "provisioning");
    expect(() => insert("b", "active")).toThrow(/UNIQUE constraint failed/);
    db.run("UPDATE runtime_instances SET status = 'offline' WHERE id = 'a'");
    expect(() => insert("b", "active")).not.toThrow();
  } finally {
    db.close();
  }
});

test("controller protocol carries the workspace request and trait", () => {
  const hello = ControllerClientMessageSchema.parse({
    type: "hello",
    controllerId: "controller",
    kind: "docker",
    version: 1,
    traits: {
      canProvision: true,
      ephemeralDisk: true,
      supportsPause: false,
      persistentWorkspace: true,
    },
  });
  if (hello.type !== "hello") throw new Error("Expected hello");
  expect(hello.traits.persistentWorkspace).toBe(true);
  const payload = {
    runtimeId: "runtime",
    agentId: "agent",
    poolId: "pool",
    ownerId: "owner",
    image: "worker:test",
    env: {},
    labels: {},
    workspace: { key: "swarm-ws-agent-0", sizeGb: 20 },
  };
  expect(
    ControllerCommandSchema.parse({ type: "cmd", id: "command", op: "provision", payload }),
  ).toMatchObject({ payload: { workspace: payload.workspace } });
  for (const key of ["swarm-ws-Agent-0", "swarm-cache-x", "swarm-ws-agent-x", "../swarm-ws-a-0"])
    expect(() =>
      ControllerCommandSchema.parse({
        type: "cmd",
        id: "command",
        op: "provision",
        payload: { ...payload, workspace: { key } },
      }),
    ).toThrow();
});
