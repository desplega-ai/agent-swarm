import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { type ModelDef, parseAppDefinition } from "../apps/definition";
import {
  type AppRow,
  createAppRow,
  listAppRows,
  patchAppRow,
  withMutationLock,
} from "../apps/row-store";
import { createApp, getApp, updateApp } from "../apps/store";
import { getAppSyncStatus, runAppSync } from "../apps/sync";
import { closeDb, createAgent, createTaskExtended, getDb, getKv, initDb } from "../be/db";
import { upsertScriptConnection } from "../be/script-connections";
import { upsertScriptByName } from "../be/scripts/db";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = `/private/tmp/test-apps-sync-engine-${process.pid}.sqlite`;
const OWNER_AGENT_ID = crypto.randomUUID();
const LEAD_AGENT_ID = crypto.randomUUID();
const savedEnv = { ...process.env };

const PAGE = { main: { root: "root", elements: { root: { type: "Container", props: {} } } } };

type Definition = Record<string, unknown>;

const ISSUE_COLUMNS: Record<string, unknown> = {
  issueKey: { kind: "string" },
  title: { kind: "string", source: { of: "gh", field: "title" } },
  handle: { kind: "string", source: { of: "gh", field: "user.login", transform: "slug" } },
  amountCents: { kind: "number", source: { of: "gh", field: "price", transform: "cents" } },
  openedAt: { kind: "date", source: { of: "gh", field: "created_at", transform: "date-parse" } },
  note: { kind: "string" },
  priority: { kind: "string", required: true, default: "normal" },
};

/** The same model with every source binding stripped — a plain, owned model. */
function ownedIssueColumns(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ISSUE_COLUMNS).map(([name, column]) => {
      const copy = { ...(column as Record<string, unknown>) };
      delete copy.source;
      return [name, copy];
    }),
  );
}

function appWith(models: Record<string, unknown>): Definition {
  return { models, pages: PAGE, defaultPage: "main" };
}

function ghSource(scriptId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connector: "script",
    scriptId,
    joinKey: "issueKey",
    args: { repo: "owner/name" },
    ...extra,
  };
}

function issueDefinition(scriptId: string, extra: Record<string, unknown> = {}): Definition {
  return appWith({ issue: { columns: ISSUE_COLUMNS, sources: { gh: ghSource(scriptId, extra) } } });
}

function parsed(definition: Definition) {
  const result = parseAppDefinition(definition);
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

function createSyncApp(definition: Definition, name = "Engine app"): string {
  return createApp({ name, definition: parsed(definition) }).id;
}

function modelOf(appId: string, model: string): ModelDef {
  const app = getApp(appId);
  const resolved = app?.definition.models[model];
  if (!resolved) throw new Error(`unknown model ${model}`);
  return resolved;
}

function rowsOf(appId: string, model = "issue", joinKey = "issueKey"): AppRow[] {
  return listAppRows(appId, model).sort((a, b) =>
    String(a[joinKey] ?? a.id).localeCompare(String(b[joinKey] ?? b.id)),
  );
}

function rowSnapshot(appId: string, model = "issue"): string {
  return JSON.stringify(listAppRows(appId, model).sort((a, b) => a.id.localeCompare(b.id)));
}

let scriptCounter = 0;

/** Upsert by name: re-saving the same name swaps the source and keeps the id. */
async function saveScript(args: {
  name: string;
  source: string;
  scope?: "global" | "agent";
  scopeId?: string;
  agentId?: string;
}): Promise<string> {
  const result = await upsertScriptByName({
    name: args.name,
    source: args.source,
    description: "apps sync engine fixture",
    intent: "apps sync engine fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    typeChecked: true,
    embeddingMode: "skip",
    scope: args.scope ?? "global",
    scopeId: args.scopeId ?? null,
    agentId: args.agentId ?? null,
  });
  return result.script.id;
}

function scriptName(label: string): string {
  scriptCounter += 1;
  return `apps_sync_engine_${label}_${scriptCounter}`;
}

/** A saved script returning a literal payload; `set` swaps the payload in place. */
async function fixtureScript(label: string, payload: unknown) {
  const name = scriptName(label);
  const body = (value: unknown) => `export default async () => (${JSON.stringify(value)});`;
  const id = await saveScript({ name, source: body(payload) });
  return {
    id,
    set: async (next: unknown) => {
      await saveScript({ name, source: body(next) });
    },
    setSource: async (source: string) => {
      await saveScript({ name, source });
    },
  };
}

function ghRecord(key: string | number, overrides: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      title: `Issue ${key}`,
      user: { login: "Ada Lovelace" },
      price: 12.34,
      created_at: "2026-01-02T03:04:05.000Z",
      ...overrides,
    },
  };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  process.env.AGENT_SWARM_API_KEY = "apps-sync-engine-test-key-0123456789";
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  initDb(TEST_DB_PATH);
  createAgent({ id: OWNER_AGENT_ID, name: "apps-sync-owner", isLead: false, status: "idle" });
  createAgent({ id: LEAD_AGENT_ID, name: "apps-sync-lead", isLead: true, status: "idle" });
});

afterAll(async () => {
  closeDb();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  getDb().run("DELETE FROM apps");
});

describe("script source pulls", () => {
  test("first pass creates rows with the envelope, join key and transforms", async () => {
    const script = await fixtureScript("create", [
      ghRecord(1),
      ghRecord("two", { user: { login: "Grace Hopper" }, price: 1, created_at: "2026-02-02" }),
    ]);
    const appId = createSyncApp(issueDefinition(script.id));

    const result = await runAppSync({ appId, invokedBy: "user:tester" });

    expect(result.ok).toBe(true);
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      connector: "script",
      pulled: 2,
      created: 2,
      updated: 0,
      refreshed: 0,
      markedStale: 0,
      unchanged: 0,
      invokedBy: "user:tester",
    });
    expect(result.passes[0]?.error).toBeUndefined();

    const rows = rowsOf(appId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      issueKey: "1",
      title: "Issue 1",
      handle: "ada-lovelace",
      amountCents: 1234,
      openedAt: "2026-01-02T03:04:05.000Z",
      priority: "normal",
      source: "gh",
      stale: false,
      createdBy: "sync:gh",
      updatedBy: "sync:gh",
    });
    expect(typeof rows[0]?.syncedAt).toBe("string");
    expect(rows[1]).toMatchObject({ issueKey: "two", handle: "grace-hopper", amountCents: 100 });
  });

  test("changed data updates projected columns only; an unchanged pass just refreshes", async () => {
    const script = await fixtureScript("update", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    // An operator owns `note`; sync must never touch it.
    const before = rowsOf(appId)[0]!;
    await patchAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      before.id,
      { note: "mine" },
      {
        actor: "user:operator",
      },
    );

    await script.set([ghRecord(1, { title: "Renamed" }), ghRecord(2)]);
    const second = await runAppSync({ appId });
    expect(second.passes[0]).toMatchObject({ pulled: 2, created: 0, updated: 1, refreshed: 1 });

    const updated = rowsOf(appId)[0]!;
    expect(updated.title).toBe("Renamed");
    expect(updated.note).toBe("mine");
    expect(updated.updatedBy).toBe("sync:gh");
    expect(Date.parse(String(updated.updatedAt))).toBeGreaterThan(
      Date.parse(String(before.updatedAt)),
    );

    const third = await runAppSync({ appId });
    expect(third.passes[0]).toMatchObject({ created: 0, updated: 0, refreshed: 2 });

    const refreshed = rowsOf(appId)[0]!;
    expect(refreshed.updatedAt).toBe(updated.updatedAt);
    expect(refreshed.updatedBy).toBe(updated.updatedBy);
    expect(refreshed.note).toBe("mine");
    expect(Date.parse(String(refreshed.syncedAt))).toBeGreaterThan(
      Date.parse(String(updated.syncedAt)),
    );
  });

  test("a vanished record goes stale with syncedAt frozen; reappearing clears it", async () => {
    const script = await fixtureScript("stale", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const seeded = rowsOf(appId)[0]!;

    await script.set([ghRecord(2)]);
    const sweep = await runAppSync({ appId });
    expect(sweep.passes[0]).toMatchObject({ pulled: 1, markedStale: 1, refreshed: 1 });
    expect(sweep.passes[0]?.staleSweepSkipped).toBeUndefined();

    const stale = rowsOf(appId)[0]!;
    expect(stale.stale).toBe(true);
    expect(stale.syncedAt).toBe(seeded.syncedAt);
    expect(stale.updatedAt).toBe(seeded.updatedAt);

    // A second sweep must not re-write an already-stale row.
    const again = await runAppSync({ appId });
    expect(again.passes[0]).toMatchObject({ markedStale: 0, unchanged: 1 });

    await script.set([ghRecord(1), ghRecord(2)]);
    const back = await runAppSync({ appId });
    expect(back.passes[0]).toMatchObject({ created: 0, markedStale: 0 });
    const revived = rowsOf(appId)[0]!;
    expect(revived.stale).toBe(false);
    expect(Date.parse(String(revived.syncedAt))).toBeGreaterThan(
      Date.parse(String(stale.syncedAt)),
    );
  });

  test("an unprojectable field nulls one column and warns instead of failing the pass", async () => {
    const script = await fixtureScript("projection", [
      ghRecord(1, { price: "not a number", created_at: "yesterday", title: 42 }),
    ]);
    const appId = createSyncApp(issueDefinition(script.id));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.error).toBeUndefined();
    expect(pass.created).toBe(1);
    const row = rowsOf(appId)[0]!;
    expect(row.amountCents).toBeNull();
    expect(row.openedAt).toBeNull();
    expect(row.title).toBeNull();
    expect(pass.warnings).toHaveLength(3);
    expect(pass.warnings.some((warning) => warning.includes('column "amountCents"'))).toBe(true);
    expect(pass.warnings.some((warning) => warning.includes('column "title"'))).toBe(true);
  });

  test("complete:false skips the stale sweep and warns", async () => {
    const script = await fixtureScript("incomplete", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    await script.set({ records: [ghRecord(2)], complete: false });
    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({
      pulled: 1,
      markedStale: 0,
      unchanged: 1,
      staleSweepSkipped: true,
    });
    expect(pass.warnings.some((warning) => warning.includes("stale sweep skipped"))).toBe(true);
    expect(rowsOf(appId)[0]?.stale).toBe(false);
  });

  test("a pull above the 500-record cap truncates and drops completeness", async () => {
    const script = await fixtureScript("cap", []);
    await script.setSource(
      "export default async () => Array.from({ length: 501 }, (_, i) => ({ key: 'k' + i, fields: { title: 't' + i } }));",
    );
    const appId = createSyncApp(issueDefinition(script.id));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ pulled: 500, created: 500, staleSweepSkipped: true });
    expect(pass.warnings.some((warning) => warning.includes("500-record cap"))).toBe(true);
    expect(listAppRows(appId, "issue")).toHaveLength(500);
  });

  test("an invalid return shape fails the pass with zero row churn", async () => {
    const script = await fixtureScript("shape", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.set({ error: "upstream said no" });
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("invalid payload");
    expect(result.passes[0]).toMatchObject({ pulled: 0, created: 0, updated: 0, markedStale: 0 });
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a thrown script error fails the pass with zero row churn", async () => {
    const script = await fixtureScript("throw", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.setSource('export default async () => { throw new Error("upstream exploded"); };');
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("upstream exploded");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a non-zero exit fails the pass with zero row churn", async () => {
    const script = await fixtureScript("exit", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.setSource("export default async () => { process.exit(3); };");
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toBeDefined();
    expect(result.passes[0]).toMatchObject({ pulled: 0, created: 0, updated: 0, markedStale: 0 });
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("does not adopt an unowned row that already carries the join key", async () => {
    const script = await fixtureScript("adopt", [ghRecord(1)]);
    const appId = createSyncApp(appWith({ issue: { columns: ownedIssueColumns() } }));
    await createAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      { issueKey: "1", title: "hand made", note: "human" },
      { actor: "user:operator" },
    );
    // Adding a source to a model that already has rows is a free schema edit.
    updateApp(appId, { definition: parsed(issueDefinition(script.id)) });

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ created: 1, updated: 0 });
    const rows = rowsOf(appId);
    expect(rows).toHaveLength(2);
    const human = rows.find((row) => row.note === "human")!;
    expect(human.source).toBeUndefined();
    expect(human.title).toBe("hand made");
    expect(rows.find((row) => row.source === "gh")?.title).toBe("Issue 1");
  });
});

describe("script source inputs and run-as", () => {
  const ECHO_COLUMNS: Record<string, unknown> = {
    issueKey: { kind: "string" },
    payload: { kind: "string", source: { of: "gh", field: "payload" } },
  };

  function echoDefinition(scriptId: string, extra: Record<string, unknown> = {}): Definition {
    return appWith({
      issue: { columns: ECHO_COLUMNS, sources: { gh: ghSource(scriptId, extra) } },
    });
  }

  test("args, app, model, source and connection reach the script", async () => {
    await upsertScriptConnection({
      slug: "echoConn",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.echo.test/graphql",
      allowedHosts: ["api.echo.test"],
    });
    const name = scriptName("echo");
    const scriptId = await saveScript({
      name,
      source:
        "export default async (args) => [{ key: 'echo', fields: { payload: JSON.stringify(args) } }];",
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "echoConn" }));

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    const payload = JSON.parse(String(rowsOf(appId)[0]?.payload));
    expect(payload).toEqual({
      repo: "owner/name",
      app: { id: appId },
      model: "issue",
      source: "gh",
      connection: "echoConn",
    });
  });

  test("engine-supplied model and source win over colliding args keys", async () => {
    const scriptId = await saveScript({
      name: scriptName("precedence"),
      source:
        "export default async (args) => [{ key: 'echo', fields: { payload: JSON.stringify(args) } }];",
    });
    const appId = createSyncApp(
      echoDefinition(scriptId, { args: { repo: "x", model: "hijack", source: "hijack2" } }),
    );

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(rowsOf(appId)[0]?.payload))).toEqual({
      repo: "x",
      app: { id: appId },
      model: "issue",
      source: "gh",
    });
  });

  test("an owner-owned script runs with the owner's connections", async () => {
    await upsertScriptConnection({
      slug: "ownerOnly",
      kind: "graphql",
      scope: "agent",
      scopeId: OWNER_AGENT_ID,
      baseUrl: "https://api.owner.test/graphql",
      allowedHosts: ["api.owner.test"],
    });
    const scriptId = await saveScript({
      name: scriptName("owned"),
      source: "export default async () => [{ key: 'o1', fields: { payload: 'ok' } }];",
      scope: "agent",
      scopeId: OWNER_AGENT_ID,
      agentId: OWNER_AGENT_ID,
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "ownerOnly" }));

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    expect(result.passes[0]?.created).toBe(1);
  });

  test("an owner-less global script runs as the lead", async () => {
    await upsertScriptConnection({
      slug: "leadOnly",
      kind: "graphql",
      scope: "agent",
      scopeId: LEAD_AGENT_ID,
      baseUrl: "https://api.lead.test/graphql",
      allowedHosts: ["api.lead.test"],
    });
    const scriptId = await saveScript({
      name: scriptName("leadrun"),
      source: "export default async () => [{ key: 'l1', fields: { payload: 'ok' } }];",
    });
    // The lead-scoped connection is only reachable when run-as resolved to the
    // lead — both at definition-write time and in the pull preflight.
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "leadOnly" }));

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(true);
    expect(result.passes[0]?.created).toBe(1);
  });

  test("a connection disabled after the write fails preflight before the script runs", async () => {
    await upsertScriptConnection({
      slug: "goesDark",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.dark.test/graphql",
      allowedHosts: ["api.dark.test"],
    });
    const scriptId = await saveScript({
      name: scriptName("marker"),
      source: 'export default async () => { throw new Error("MARKER script ran"); };',
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "goesDark" }));

    await upsertScriptConnection({
      slug: "goesDark",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.dark.test/graphql",
      allowedHosts: ["api.dark.test"],
      enabled: false,
    });
    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain('connection "goesDark" not found or disabled');
    // The marker proves the script was never invoked.
    expect(result.passes[0]?.error).not.toContain("MARKER");
    expect(listAppRows(appId, "issue")).toHaveLength(0);
  });

  test("a source naming a connection that never existed fails the pass", async () => {
    const scriptId = await saveScript({
      name: scriptName("ghost"),
      source: 'export default async () => { throw new Error("MARKER script ran"); };',
    });
    await upsertScriptConnection({
      slug: "ghostConn",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://api.ghost.test/graphql",
      allowedHosts: ["api.ghost.test"],
    });
    const appId = createSyncApp(echoDefinition(scriptId, { connection: "ghostConn" }));
    // Stored definitions outlive their connections; the engine re-resolves the
    // slug on every pull rather than trusting write-time validation.
    getDb().run("DELETE FROM script_connections WHERE slug = 'ghostConn'");

    const result = await runAppSync({ appId });

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain('connection "ghostConn" not found or disabled');
    expect(result.passes[0]?.error).not.toContain("MARKER");
  });
});

describe("swarm-tasks source", () => {
  const TASK_COLUMNS: Record<string, unknown> = {
    taskKey: { kind: "string" },
    prompt: { kind: "string", source: { of: "pool", field: "prompt" } },
    taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
    taskPriority: { kind: "number", source: { of: "pool", field: "priority" } },
    author: { kind: "string", source: { of: "pool", field: "vcsAuthor" } },
  };

  function taskDefinition(config: Record<string, unknown> = {}): Definition {
    return appWith({
      task: {
        columns: TASK_COLUMNS,
        sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config } },
      },
    });
  }

  beforeEach(() => {
    getDb().run("DELETE FROM agent_tasks");
  });

  test("projects tasks flatly, truncates the prompt and honours the default heartbeat filter", async () => {
    const longPrompt = "x".repeat(1500);
    const task = createTaskExtended(longPrompt, {
      agentId: OWNER_AGENT_ID,
      tags: ["alpha"],
      priority: 70,
      vcsProvider: "github",
      vcsAuthor: "octocat",
    });
    createTaskExtended("heartbeat noise", { agentId: OWNER_AGENT_ID, tags: ["heartbeat"] });
    const appId = createSyncApp(taskDefinition());

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ connector: "swarm-tasks", pulled: 1, created: 1 });
    const rows = rowsOf(appId, "task", "taskKey");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskKey: task.id,
      taskStatus: "pending",
      taskPriority: 70,
      author: "octocat",
      source: "pool",
      stale: false,
    });
    expect(String(rows[0]?.prompt)).toHaveLength(1000);
  });

  test("assetKey prefix-scopes the window and includeHeartbeat widens it", async () => {
    createTaskExtended("app owned", { agentId: OWNER_AGENT_ID, key: "shared/apps/demo/one" });
    createTaskExtended("elsewhere", { agentId: OWNER_AGENT_ID, key: "shared/other/two" });
    createTaskExtended("beat", { agentId: OWNER_AGENT_ID, tags: ["heartbeat"] });

    const scoped = createSyncApp(taskDefinition({ assetKey: "shared/apps/demo" }), "Scoped");
    expect((await runAppSync({ appId: scoped })).passes[0]?.pulled).toBe(1);

    const withBeats = createSyncApp(taskDefinition({ includeHeartbeat: true }), "With beats");
    expect((await runAppSync({ appId: withBeats })).passes[0]?.pulled).toBe(3);
  });

  test("a full page marks the pull incomplete and skips the sweep", async () => {
    for (let index = 0; index < 3; index += 1) {
      createTaskExtended(`task ${index}`, { agentId: OWNER_AGENT_ID });
    }
    const appId = createSyncApp(taskDefinition({ limit: 2 }));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass).toMatchObject({ pulled: 2, created: 2, staleSweepSkipped: true });
  });

  test("status, tags and agentId filters narrow the window", async () => {
    const other = crypto.randomUUID();
    createAgent({ id: other, name: "apps-sync-other", isLead: false, status: "idle" });
    createTaskExtended("mine tagged", { agentId: OWNER_AGENT_ID, tags: ["alpha", "beta"] });
    createTaskExtended("mine untagged", { agentId: OWNER_AGENT_ID });
    createTaskExtended("theirs tagged", { agentId: other, tags: ["alpha"] });
    createTaskExtended("backlog", { tags: ["alpha"], status: "backlog" });

    const byAgent = createSyncApp(taskDefinition({ agentId: OWNER_AGENT_ID }), "By agent");
    expect((await runAppSync({ appId: byAgent })).passes[0]?.pulled).toBe(2);

    const byTag = createSyncApp(taskDefinition({ tags: "beta" }), "By tag");
    expect((await runAppSync({ appId: byTag })).passes[0]?.pulled).toBe(1);

    const byStatus = createSyncApp(taskDefinition({ status: "backlog,pending" }), "By status");
    expect((await runAppSync({ appId: byStatus })).passes[0]?.pulled).toBe(4);

    const bogus = createSyncApp(taskDefinition({ status: "nonsense" }), "Bogus status");
    const failed = await runAppSync({ appId: bogus });
    expect(failed.ok).toBe(false);
    expect(failed.passes[0]?.error).toContain('unknown task status "nonsense"');
  });

  test("an unsupported config key is reported as a warning", async () => {
    createTaskExtended("only task", { agentId: OWNER_AGENT_ID });
    const appId = createSyncApp(taskDefinition({ nonsense: "value" }));

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.warnings.some((warning) => warning.includes('config key "nonsense"'))).toBe(true);
  });

  test("limit rails: over the cap and below the floor each warn", async () => {
    createTaskExtended("only task", { agentId: OWNER_AGENT_ID });

    const over = createSyncApp(taskDefinition({ limit: 500 }), "Over cap");
    const overPass = (await runAppSync({ appId: over })).passes[0]!;
    expect(overPass.warnings).toHaveLength(1);
    expect(overPass.warnings[0]).toBe("config.limit 500 exceeds the 200 cap; using 200");

    const under = createSyncApp(taskDefinition({ limit: 0 }), "Under floor");
    const underPass = (await runAppSync({ appId: under })).passes[0]!;
    expect(underPass.warnings).toHaveLength(1);
    expect(underPass.warnings[0]).toBe('config.limit "0" is not a positive integer; using 100');
  });

  test("projects every documented task field onto its bound column", async () => {
    const task = createTaskExtended("full shape", {
      agentId: OWNER_AGENT_ID,
      source: "slack",
      tags: ["alpha", "beta"],
      priority: 42,
      vcsProvider: "gitlab",
      vcsNumber: 77,
      vcsUrl: "https://git.test/mr/77",
      vcsAuthor: "octocat",
    });
    const appId = createSyncApp(
      appWith({
        task: {
          columns: {
            taskKey: { kind: "string" },
            taskId: { kind: "string", source: { of: "pool", field: "id" } },
            taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
            prompt: { kind: "string", source: { of: "pool", field: "prompt" } },
            taskSource: { kind: "string", source: { of: "pool", field: "source" } },
            taskAgentId: { kind: "string", source: { of: "pool", field: "agentId" } },
            // Arrays are not a column kind; `lower` stringifies the tag list.
            tagsCsv: { kind: "string", source: { of: "pool", field: "tags", transform: "lower" } },
            taskPriority: { kind: "number", source: { of: "pool", field: "priority" } },
            openedAt: { kind: "date", source: { of: "pool", field: "createdAt" } },
            touchedAt: { kind: "date", source: { of: "pool", field: "updatedAt" } },
            vcsProvider: { kind: "string", source: { of: "pool", field: "vcsProvider" } },
            vcsNumber: { kind: "number", source: { of: "pool", field: "vcsNumber" } },
            vcsUrl: { kind: "string", source: { of: "pool", field: "vcsUrl" } },
            vcsAuthor: { kind: "string", source: { of: "pool", field: "vcsAuthor" } },
          },
          sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config: {} } },
        },
      }),
    );

    const pass = (await runAppSync({ appId })).passes[0]!;

    expect(pass.warnings).toHaveLength(0);
    const row = rowsOf(appId, "task", "taskKey")[0]!;
    expect(row).toMatchObject({
      taskKey: task.id,
      taskId: task.id,
      taskStatus: "pending",
      prompt: "full shape",
      taskSource: "slack",
      taskAgentId: OWNER_AGENT_ID,
      tagsCsv: "alpha,beta",
      taskPriority: 42,
      openedAt: task.createdAt,
      touchedAt: task.lastUpdatedAt,
      vcsProvider: "gitlab",
      vcsNumber: 77,
      vcsUrl: "https://git.test/mr/77",
      vcsAuthor: "octocat",
    });
  });

  test("engine-generated warnings carrying a known secret come back redacted", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      // The task text never leaves the DB layer, so nothing upstream of the
      // engine can scrub it: the cents transform fails and quotes the raw
      // value into a warning the engine itself composes.
      createTaskExtended(`leaked ${secret}`, { agentId: OWNER_AGENT_ID });
      const appId = createSyncApp(
        appWith({
          task: {
            columns: {
              taskKey: { kind: "string" },
              amount: {
                kind: "number",
                source: { of: "pool", field: "prompt", transform: "cents" },
              },
            },
            sources: { pool: { connector: "swarm-tasks", joinKey: "taskKey", config: {} } },
          },
        }),
      );

      const pass = (await runAppSync({ appId })).passes[0]!;

      expect(pass.warnings).toHaveLength(1);
      expect(pass.warnings[0]).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(pass.warnings[0]).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("an engine-generated pass error carrying a known secret is redacted in the status KV", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      // An unknown status token is echoed back by the engine itself — the only
      // scrub between it and the caller is the engine's own.
      const appId = createSyncApp(taskDefinition({ status: secret }));

      const result = await runAppSync({ appId });

      expect(result.ok).toBe(false);
      expect(result.passes[0]?.error).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(result.passes[0]?.error).not.toContain(secret);
      const status = getAppSyncStatus(appId, "task", "pool")!;
      expect(status.error).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(status.error).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });
});

describe("pair expansion", () => {
  test("fans out to every declared pair and reports unresolvable requests", async () => {
    getDb().run("DELETE FROM agent_tasks");
    createTaskExtended("pool task", { agentId: OWNER_AGENT_ID });
    const script = await fixtureScript("fanout", [ghRecord(1)]);
    const appId = createSyncApp(
      appWith({
        issue: {
          columns: {
            ...ISSUE_COLUMNS,
            taskKey: { kind: "string" },
            taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
          },
          sources: {
            gh: ghSource(script.id),
            pool: { connector: "swarm-tasks", joinKey: "taskKey", config: { limit: 50 } },
          },
        },
      }),
    );

    const all = await runAppSync({ appId });
    expect(all.ok).toBe(true);
    expect(all.passes.map((pass) => pass.source)).toEqual(["gh", "pool"]);
    expect(all.passes.map((pass) => pass.created)).toEqual([1, 1]);

    const single = await runAppSync({ appId, source: "gh" });
    expect(single.passes).toHaveLength(1);
    expect(single.passes[0]?.source).toBe("gh");

    expect(await runAppSync({ appId: crypto.randomUUID() })).toMatchObject({
      ok: false,
      passes: [],
      issues: [{ path: "appId" }],
    });
    expect((await runAppSync({ appId, model: "nope" })).issues?.[0]).toMatchObject({
      path: "model",
      message: 'unknown model "nope"',
    });
    expect((await runAppSync({ appId, source: "nope" })).issues?.[0]).toEqual({
      path: "source",
      message: 'unknown source "nope" — no model declares it',
    });
    expect((await runAppSync({ appId, model: "issue", source: "nope" })).issues?.[0]).toEqual({
      path: "source",
      message: 'unknown source "nope" on model "issue"',
    });

    const sourceless = createSyncApp(
      appWith({ issue: { columns: { issueKey: { kind: "string" } } } }),
      "Sourceless",
    );
    const none = await runAppSync({ appId: sourceless });
    expect(none.ok).toBe(false);
    expect(none.issues?.[0]).toEqual({
      path: "appId",
      message: "no model declares a source to sync",
    });
    expect((await runAppSync({ appId: sourceless, model: "issue" })).issues?.[0]).toEqual({
      path: "model",
      message: 'model "issue" declares no sources',
    });
  });
});

describe("concurrency", () => {
  test("single-flight short-circuits and an interleaved operator write survives", async () => {
    const script = await fixtureScript("concurrent", [ghRecord(1), ghRecord(2)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const seededRow = rowsOf(appId)[0]!;

    // The pull now takes ~400ms and returns changed data for record 1.
    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return ${JSON.stringify(
        [ghRecord(1, { title: "Changed while locked" }), ghRecord(2)],
      )}; };`,
    );

    // Hold the model lock so reconcile cannot start until the barrier opens.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withMutationLock(appId, "issue", () => gate);

    const first = runAppSync({ appId, invokedBy: "user:a" });
    // Same pair, already in flight: no second pull.
    const second = await runAppSync({ appId, invokedBy: "user:b" });
    expect(second.passes[0]).toMatchObject({
      model: "issue",
      source: "gh",
      skipped: true,
      alreadyRunning: true,
      pulled: 0,
      created: 0,
      invokedBy: "user:b",
    });

    // The slow pass has not finished, so the status still describes the seed
    // pass: a short-circuited trigger must never write status of its own.
    expect(getAppSyncStatus(appId, "issue", "gh")).toMatchObject({
      ok: true,
      created: 2,
      updated: 0,
      refreshed: 0,
      markedStale: 0,
    });

    // Queued behind the barrier and therefore ahead of the reconcile, which
    // only asks for the lock once its pull has finished.
    const operatorWrite = patchAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      seededRow.id,
      { note: "written mid-pull" },
      { actor: "user:operator" },
    );
    const operatorRow = createAppRow(
      appId,
      "issue",
      modelOf(appId, "issue"),
      { note: "operator only" },
      { actor: "user:operator" },
    );

    release();
    await held;
    await operatorWrite;
    await operatorRow;
    const result = await first;

    expect(result.ok).toBe(true);
    expect(result.passes[0]).toMatchObject({ pulled: 2, created: 0, updated: 1, refreshed: 1 });

    const rows = rowsOf(appId);
    const synced = rows.filter((row) => row.source === "gh");
    expect(synced).toHaveLength(2);
    expect(new Set(synced.map((row) => row.issueKey)).size).toBe(2);
    expect(rows).toHaveLength(3);

    const reconciled = synced.find((row) => row.issueKey === "1")!;
    expect(reconciled.title).toBe("Changed while locked");
    expect(reconciled.note).toBe("written mid-pull");

    const unowned = rows.find((row) => row.note === "operator only")!;
    expect(unowned.source).toBeUndefined();
    expect(unowned.stale).toBeUndefined();

    // The short-circuited trigger must not have overwritten the real pass state.
    expect(getAppSyncStatus(appId, "issue", "gh")).toMatchObject({
      ok: true,
      created: 0,
      updated: 1,
      refreshed: 1,
    });
  });

  test("a definition change during the pull aborts the pass with no writes", async () => {
    const script = await fixtureScript("racy", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });
    const before = rowSnapshot(appId);

    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1, { title: "never written" })],
      )}; };`,
    );
    const pass = runAppSync({ appId });
    // Drop the source while the pull is in the air.
    updateApp(appId, {
      definition: parsed(appWith({ issue: { columns: ownedIssueColumns() } })),
    });

    const result = await pass;

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("no longer declares source");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("a join-key swap during the pull aborts the pass with no writes", async () => {
    const script = await fixtureScript("joinkey", [ghRecord(1)]);
    const withAltKey = (columns: Record<string, unknown>) => ({
      ...columns,
      altKey: { kind: "string" },
    });
    const appId = createSyncApp(
      appWith({
        issue: { columns: withAltKey(ISSUE_COLUMNS), sources: { gh: ghSource(script.id) } },
      }),
    );
    await runAppSync({ appId });

    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return ${JSON.stringify(
        [ghRecord(1, { title: "never written" })],
      )}; };`,
    );
    const pass = runAppSync({ appId });
    // A join key is immutable in place, so the only way to move it is
    // remove-then-re-add — both halves land while the pull is in the air.
    updateApp(appId, {
      definition: parsed(appWith({ issue: { columns: withAltKey(ownedIssueColumns()) } })),
    });
    updateApp(appId, {
      definition: parsed(
        appWith({
          issue: {
            columns: withAltKey(ISSUE_COLUMNS),
            sources: { gh: ghSource(script.id, { joinKey: "altKey" }) },
          },
        }),
      ),
    });
    const before = rowSnapshot(appId);

    const result = await pass;

    expect(result.ok).toBe(false);
    expect(result.passes[0]?.error).toContain("changed while the pull was running");
    expect(rowSnapshot(appId)).toBe(before);
  });

  test("single-flight is keyed per source, not per model", async () => {
    createTaskExtended("pool work", { agentId: OWNER_AGENT_ID });
    const script = await fixtureScript("perSource", []);
    await script.setSource(
      `export default async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return ${JSON.stringify(
        [ghRecord(1)],
      )}; };`,
    );
    const appId = createSyncApp(
      appWith({
        issue: {
          columns: {
            ...ISSUE_COLUMNS,
            taskKey: { kind: "string" },
            taskStatus: { kind: "string", source: { of: "pool", field: "status" } },
          },
          sources: {
            gh: ghSource(script.id),
            pool: { connector: "swarm-tasks", joinKey: "taskKey", config: { limit: 50 } },
          },
        },
      }),
    );

    const slow = runAppSync({ appId, source: "gh" });
    // Different source on the same model: this must run, not short-circuit.
    const pool = await runAppSync({ appId, source: "pool" });

    expect(pool.ok).toBe(true);
    expect(pool.passes[0]?.skipped).toBeUndefined();
    expect(pool.passes[0]?.alreadyRunning).toBeUndefined();
    expect(pool.passes[0]?.error).toBeUndefined();
    expect(pool.passes[0]?.created).toBeGreaterThan(0);

    const slowResult = await slow;
    expect(slowResult.ok).toBe(true);
    expect(slowResult.passes[0]).toMatchObject({ source: "gh", created: 1, markedStale: 0 });
    // Each source sweeps only its own rows.
    expect(
      rowsOf(appId)
        .filter((row) => row.source === "pool")
        .every((row) => row.stale === false),
    ).toBe(true);
  });
});

describe("secret hygiene and sync status", () => {
  test("a pass error carrying a known secret comes back redacted", async () => {
    const secret = "fixture-secret-value-0123456789";
    process.env.APPS_SYNC_FIXTURE_TOKEN = secret;
    refreshSecretScrubberCache();
    try {
      const script = await fixtureScript("secret", []);
      await script.setSource(
        `export default async () => { throw new Error("upstream rejected ${secret}"); };`,
      );
      const appId = createSyncApp(issueDefinition(script.id));

      const result = await runAppSync({ appId });

      expect(result.ok).toBe(false);
      expect(result.passes[0]?.error).toContain("[REDACTED:APPS_SYNC_FIXTURE_TOKEN]");
      expect(result.passes[0]?.error).not.toContain(secret);
      expect(getAppSyncStatus(appId, "issue", "gh")?.error).not.toContain(secret);
    } finally {
      delete process.env.APPS_SYNC_FIXTURE_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("sync status records the last pass at the documented key", async () => {
    const script = await fixtureScript("status", [ghRecord(1)]);
    const appId = createSyncApp(issueDefinition(script.id));
    await runAppSync({ appId });

    const entry = getKv(`apps:${appId}`, "sync-status:issue:gh");
    expect(entry).not.toBeNull();
    const ok = getAppSyncStatus(appId, "issue", "gh")!;
    expect(ok).toMatchObject({ ok: true, created: 1, updated: 0, refreshed: 0, markedStale: 0 });
    expect(Object.keys(ok).sort()).toEqual([
      "created",
      "lastFinishedAt",
      "lastStartedAt",
      "markedStale",
      "ok",
      "refreshed",
      "updated",
    ]);
    expect(typeof ok.lastStartedAt).toBe("string");
    expect(Date.parse(ok.lastFinishedAt)).toBeGreaterThanOrEqual(Date.parse(ok.lastStartedAt));
    expect(ok.error).toBeUndefined();

    await script.setSource('export default async () => { throw new Error("pull failed"); };');
    await runAppSync({ appId });

    const failed = getAppSyncStatus(appId, "issue", "gh")!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("pull failed");
    expect(Object.keys(failed).sort()).toEqual([
      "created",
      "error",
      "lastFinishedAt",
      "lastStartedAt",
      "markedStale",
      "ok",
      "refreshed",
      "updated",
    ]);
  });
});
