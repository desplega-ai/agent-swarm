import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, initDb } from "../be/db";
import { attachRole, detachRole } from "../be/rbac-roles";
import {
  _getOrgIdForTests,
  _resetTelemetryStateForTests,
  initTelemetry,
  setTelemetryOrgDomain,
  track,
} from "../telemetry";
import {
  buildContext,
  emailDomain,
  mapTriggerSurface,
  mintOrgId,
  normalizeProperties,
  userRef,
  validOrgDomain,
  validOrgId,
} from "../telemetry-context";
import { _resetTelemetryIdentityForTests, computeOrgDomain } from "../telemetry-identity";

// initTelemetry no-ops when ANONYMIZED_TELEMETRY=false, and the CI env may set it.
process.env.ANONYMIZED_TELEMETRY = "true";

const TEST_DB_PATH = "./test-telemetry-context.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

function memoryConfig(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  return {
    store,
    writes,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => {
      writes.push({ key, value });
      store.set(key, value);
    },
  };
}

describe("telemetry context helpers", () => {
  test("user_ref is stable inside an install, differs across installs, and hides the user ID", () => {
    const a = userRef("install_aaaa", "user-1");
    expect(a).toMatch(/^u_[0-9a-f]{32}$/);
    expect(userRef("install_aaaa", "user-1")).toBe(a);
    expect(userRef("install_bbbb", "user-1")).not.toBe(a);
    expect(userRef("install_aaaa", "user-2")).not.toBe(a);
    expect(a).not.toContain("user-1");
  });

  test("emailDomain returns a lowercase hostname and never the local part", () => {
    expect(emailDomain("Jane.Doe@Example.COM")).toBe("example.com");
    expect(emailDomain("a@b@corp.example")).toBe("corp.example");
    expect(emailDomain("admin@localhost")).toBeUndefined();
    expect(emailDomain("no-at-sign")).toBeUndefined();
    expect(emailDomain("@example.com")).toBeUndefined();
    expect(emailDomain(null)).toBeUndefined();
  });

  test("org ID and domain validators match the proxy patterns", () => {
    expect(validOrgId(mintOrgId())).toBeDefined();
    expect(validOrgId("org_0123456789abcdef")).toBe("org_0123456789abcdef");
    expect(validOrgId("org_abcdefghijklmnopqrstuvwxyz0")).toBeDefined(); // 27 alphanumerics (cloud)
    expect(validOrgId("org_short")).toBeUndefined();
    expect(validOrgId("acme")).toBeUndefined();
    expect(validOrgDomain("Acme.Example")).toBe("acme.example");
    expect(validOrgDomain("user@acme.example")).toBeUndefined();
    expect(validOrgDomain("localhost")).toBeUndefined();
  });

  test("buildContext sets user_ref and user_role only for an actor", () => {
    const base = {
      orgId: "org_0123456789abcdef",
      installationId: "install_test",
      isCloud: false,
      isE2b: false,
      swarmVersion: "1.2.3",
    };
    const anonymous = buildContext(base);
    expect(anonymous.user_ref).toBeNull();
    expect(anonymous.user_role).toBeNull();
    expect(anonymous.plan).toBe("self-host-free");
    expect(anonymous.deployment).toBe("self-host");

    const withActor = buildContext({
      ...base,
      actor: { userId: "u-1", role: "admin" },
      isCloud: true,
    });
    expect(withActor.user_ref).toBe(userRef("install_test", "u-1"));
    expect(withActor.user_role).toBe("admin");
    expect(withActor.plan).toBe("cloud");
    expect(withActor.deployment).toBe("cloud");

    expect(buildContext({ ...base, isE2b: true }).deployment).toBe("e2b");
    expect(buildContext({ ...base, actor: { userId: null } }).user_ref).toBeNull();
    expect(buildContext({ ...base, actor: { userId: "  " } }).user_ref).toBeNull();
  });

  test("mapTriggerSurface maps values outside the catalog enum to other", () => {
    expect(mapTriggerSurface("slack")).toBe("slack");
    expect(mapTriggerSurface("system")).toBe("system");
    expect(mapTriggerSurface("carrier-pigeon")).toBe("other");
    expect(mapTriggerSurface(null)).toBe("other");
  });

  test("normalizeProperties keeps an event alive when one optional value is unsendable", () => {
    const out = normalizeProperties("task.completed", {
      taskId: "t-1",
      durationMs: 12.6, // integer in the catalog
      provider: null, // not nullable in the catalog
      harnessVersion: undefined,
      nan: Number.NaN,
    });
    expect(out.durationMs).toBe(13);
    expect("provider" in out).toBe(false);
    expect("harnessVersion" in out).toBe(false);
    expect("nan" in out).toBe(false);
    expect(out.taskId).toBe("t-1");
    // A nullable property keeps its null: the proxy requires the key.
    expect(normalizeProperties("session.started", { taskId: null }).taskId).toBeNull();
  });
});

describe("telemetry envelope", () => {
  const originalFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    _resetTelemetryStateForTests();
    delete process.env.SWARM_ORG_ID;
    delete process.env.SWARM_ORG_NAME;
    delete process.env.MCP_BASE_URL;
    process.env.ANONYMIZED_TELEMETRY = "true";
    sent = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.ANONYMIZED_TELEMETRY = "true";
    delete process.env.SWARM_ORG_ID;
    delete process.env.SWARM_ORG_NAME;
    _resetTelemetryStateForTests();
  });

  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("an event that is not in the catalog fails to compile and is not sent before init", async () => {
    // @ts-expect-error "not.in.catalog" is not a catalogued agent-swarm event
    track({ event: "not.in.catalog", properties: {} });
    await tick();
    expect(sent).toEqual([]);
  });

  test("the org ID is minted once, persisted, and stable across restarts", async () => {
    const config = memoryConfig({ telemetry_installation_id: "install_orgtest" });
    await initTelemetry("api-server", config.get, config.set, { generateIfMissing: true });
    const first = _getOrgIdForTests();
    expect(first).toMatch(/^org_[0-9a-f]{16}$/);
    expect(config.writes.filter((w) => w.key === "telemetry_org_id")).toEqual([
      { key: "telemetry_org_id", value: first as string },
    ]);

    // Restart: a fresh process reads the stored value and writes nothing new.
    _resetTelemetryStateForTests();
    await initTelemetry("api-server", config.get, config.set, { generateIfMissing: true });
    expect(_getOrgIdForTests()).toBe(first);
    expect(config.writes.filter((w) => w.key === "telemetry_org_id")).toHaveLength(1);

    // A worker reads the same org ID and never mints one.
    _resetTelemetryStateForTests();
    const workerConfig = memoryConfig({ ...Object.fromEntries(config.store) });
    await initTelemetry("worker", workerConfig.get, workerConfig.set);
    expect(_getOrgIdForTests()).toBe(first);
    expect(workerConfig.writes).toEqual([]);
  });

  test("SWARM_ORG_ID wins when valid and is persisted for workers; an invalid one is ignored", async () => {
    process.env.SWARM_ORG_ID = "org_abcdefghijklmnopqrstuvwxyz0";
    const config = memoryConfig({ telemetry_installation_id: "install_orgenv" });
    await initTelemetry("api-server", config.get, config.set, { generateIfMissing: true });
    expect(_getOrgIdForTests()).toBe("org_abcdefghijklmnopqrstuvwxyz0");
    expect(config.store.get("telemetry_org_id")).toBe("org_abcdefghijklmnopqrstuvwxyz0");

    _resetTelemetryStateForTests();
    process.env.SWARM_ORG_ID = "not-an-org-id";
    const other = memoryConfig({ telemetry_installation_id: "install_orgenv2" });
    await initTelemetry("api-server", other.get, other.set, { generateIfMissing: true });
    expect(_getOrgIdForTests()).toMatch(/^org_[0-9a-f]{16}$/);
  });

  test("user_ref is set only when there is an actor, and the payload has no @ or raw user ID", async () => {
    process.env.SWARM_ORG_NAME = "Acme Robotics";
    const config = memoryConfig({ telemetry_installation_id: "install_payload" });
    await initTelemetry("api-server", config.get, config.set, { generateIfMissing: true });
    setTelemetryOrgDomain("corp.example");

    track({ event: "server.started", properties: { port: 3013 } });
    track({
      event: "workflow.deleted",
      properties: { workflowId: "wf-1" },
      actor: { userId: "raw-user-id-7f3a" },
    });
    track({
      event: "workflow.deleted",
      properties: { workflowId: "wf-2" },
      actor: { userId: null },
    });
    await tick();

    expect(sent).toHaveLength(3);
    const [system, human, nullActor] = sent as Array<{
      schema_version: number;
      context: Record<string, unknown>;
    }>;
    expect(system?.schema_version).toBe(2);
    expect(system?.context.user_ref).toBeNull();
    expect(system?.context.org_domain).toBe("corp.example");
    expect(system?.context.org_name).toBe("Acme Robotics");
    expect(system?.context.org_id).toMatch(/^org_[0-9a-f]{16}$/);
    expect(human?.context.user_ref).toBe(userRef("install_payload", "raw-user-id-7f3a"));
    expect(nullActor?.context.user_ref).toBeNull();

    for (const payload of sent) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain("@");
      expect(text).not.toContain("raw-user-id-7f3a");
    }
  });

  test("an org with no ID yet sends nothing instead of a half-identified event", async () => {
    // A worker on an old server: installation ID known, no org ID stored.
    const config = memoryConfig({ telemetry_installation_id: "install_noorg" });
    await initTelemetry("worker", config.get, config.set);
    track({ event: "server.started", properties: { port: 1 } });
    await tick();
    expect(sent).toEqual([]);
  });

  test("opted out: no network call, no install ID, no org ID minted", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    const config = memoryConfig();
    await initTelemetry("api-server", config.get, config.set, { generateIfMissing: true });
    track({ event: "server.started", properties: { port: 3013 } });
    await tick();
    expect(sent).toEqual([]);
    expect(config.writes).toEqual([]);
    expect(_getOrgIdForTests()).toBeUndefined();
  });
});

describe("org email domain", () => {
  beforeEach(async () => {
    closeDb();
    await removeTestDb();
    initDb(TEST_DB_PATH);
    _resetTelemetryIdentityForTests();
  });

  afterEach(async () => {
    closeDb();
    await removeTestDb();
  });

  test("is undefined with no users", async () => {
    expect(await computeOrgDomain()).toBeUndefined();
  });

  test("comes from the earliest active admin, not the earliest user", async () => {
    const member = await createUser({ name: "Early Member", email: "early@member.example" });
    await detachRole(member.id, "admin");
    await attachRole(member.id, "requester");
    await Bun.sleep(5);
    await createUser({ name: "Later Admin", email: "Boss@Admin.Example" });
    expect(await computeOrgDomain()).toBe("admin.example");
  });

  test("falls back to the earliest user with an email when no admin has one", async () => {
    const noEmailAdmin = await createUser({ name: "No Email" });
    expect(noEmailAdmin.email).toBeUndefined();
    const member = await createUser({ name: "Member", email: "m@fallback.example" });
    await detachRole(member.id, "admin");
    await attachRole(member.id, "requester");
    expect(await computeOrgDomain()).toBe("fallback.example");
  });

  test("skips a suspended user and an address with no valid hostname", async () => {
    await createUser({ name: "Suspended", email: "s@suspended.example", status: "suspended" });
    await createUser({ name: "Local", email: "root@localhost" });
    await Bun.sleep(5);
    await createUser({ name: "Real", email: "me@real.example" });
    expect(await computeOrgDomain()).toBe("real.example");
  });
});
