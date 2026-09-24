import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  getDbClient,
  getScheduledTaskByName,
  initDb,
} from "../be/db";
import {
  getExtensionByName,
  insertExtensionRun,
  installExtension,
  listExtensionRuns,
  listExtensionVersions,
  setExtensionState,
} from "../be/extensions/db";
import { enqueueAuditRow, flushAuditBuffer } from "../be/rbac-audit";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { stopExtensionRuntime } from "../extensions/lifecycle";
import { handleCore } from "../http/core";
import { handleExtensions } from "../http/extensions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { clearAuditSink, setAuditSink } from "../rbac";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import {
  loadBundleFixture,
  resetFixtureCatalog,
  useFixtureCatalog,
} from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-http.sqlite";
const API_KEY = "test-extensions-http-key-1234567890";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

type TestResponse = {
  status: number;
  text: string;
  json: () => Promise<Record<string, unknown>>;
};

async function dispatch(
  path: string,
  init: RequestInit & { agentId?: string; asUser?: string } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.agentId) headers["X-Agent-ID"] = init.agentId;
  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    if (init.asUser) {
      setRequestAuth(req, { kind: "user", userId: init.asUser, user: { id: init.asUser } as User });
    }
    const pathSegments = getPathSegments(path);
    const queryParams = parseQueryParams(path);
    if (!(await handleExtensions(req, res, pathSegments, queryParams, agentId))) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return {
    status,
    text,
    json: async () => JSON.parse(text) as Record<string, unknown>,
  };
}

/** Fixtures registered as the catalog before every test; install accepts only these names. */
const CATALOG_FIXTURES = [
  "minimal",
  "post-logger",
  "bad-import",
  "worker-runtime",
  "reserved-assets",
];

async function install(
  template = "minimal",
  agentId?: string,
  extra: { priority?: number; config?: Record<string, unknown> } = {},
): Promise<TestResponse> {
  return dispatch("/api/extensions/install", {
    method: "POST",
    agentId,
    body: JSON.stringify({ template, ...extra }),
  });
}

/** Replace the `minimal` catalog entry with a changed hooks file, as a new template release would. */
async function useChangedMinimal(suffix: string): Promise<void> {
  const bundle = await loadBundleFixture("minimal");
  bundle.files["hooks.ts"] += suffix;
  await useFixtureCatalog({ minimal: bundle });
}

let leadId: string;
let workerId: string;
let savedEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  // Tests delete template scripts right after install: keep background embeddings out of the way.
  setScriptEmbeddingProviderForTests({
    name: "test/noop-extensions-http",
    dimensions: 1,
    async embed() {
      return null;
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => null);
    },
  });
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  leadId = (await createAgent({ name: "extensions-lead", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "extensions-worker", isLead: false, status: "idle" })).id;
});

afterAll(async () => {
  resetFixtureCatalog();
  await stopExtensionRuntime();
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  await stopExtensionRuntime();
  await getDbClient().run("DELETE FROM extensions");
  await useFixtureCatalog(CATALOG_FIXTURES);
});

describe("/api/extensions HTTP", () => {
  test("lead activation defaults on, is attributable, and the deployment gate denies lifecycle calls", async () => {
    const original = process.env.EXTENSION_ALLOW_LEAD_ACTIVATION;
    const auditDisabled = process.env.RBAC_AUDIT_DISABLED;
    delete process.env.EXTENSION_ALLOW_LEAD_ACTIVATION;
    delete process.env.RBAC_AUDIT_DISABLED;
    setAuditSink(enqueueAuditRow);
    try {
      expect((await install("minimal", leadId)).status).toBe(200);
      const extension = (await getExtensionByName("minimal"))!;
      const path = `/api/extensions/${extension.id}`;
      expect((await dispatch(`${path}/enable`, { method: "POST", agentId: leadId })).status).toBe(
        200,
      );
      expect(await listExtensionRuns(extension.id)).toContainEqual(
        expect.objectContaining({
          event: "lifecycle.enable.requested",
          agentId: leadId,
          version: 1,
        }),
      );
      for (const operation of ["activate-version", "disable"]) {
        expect(
          (
            await dispatch(`${path}/${operation}`, {
              method: "POST",
              agentId: leadId,
              body: JSON.stringify({ version: 1 }),
            })
          ).status,
        ).toBe(200);
        expect(await listExtensionRuns(extension.id)).toContainEqual(
          expect.objectContaining({
            event: `lifecycle.${operation}.requested`,
            agentId: leadId,
            version: 1,
          }),
        );
      }
      for (const value of ["false", "0"]) {
        process.env.EXTENSION_ALLOW_LEAD_ACTIVATION = value;
        for (const operation of ["enable", "disable", "activate-version"]) {
          expect(
            (
              await dispatch(`${path}/${operation}`, {
                method: "POST",
                agentId: leadId,
                body: JSON.stringify({ version: 1 }),
              })
            ).status,
          ).toBe(403);
        }
      }
      expect((await getExtensionByName("minimal"))!.enabled).toBe(false);
      expect((await dispatch(`${path}/enable`, { method: "POST" })).status).toBe(200);
      expect(
        (await dispatch(`${path}/disable`, { method: "POST", asUser: crypto.randomUUID() })).status,
      ).toBe(200);
      await flushAuditBuffer();
      const decisions = await getDbClient().query<{ decision: string }>(
        "SELECT decision FROM permission_audit WHERE verb = ? AND principalId = ?",
        ["extension.activate", leadId],
      );
      expect(decisions).toContainEqual({ decision: "allow" });
      expect(decisions).toContainEqual({ decision: "deny" });
    } finally {
      await flushAuditBuffer();
      clearAuditSink();
      if (original === undefined) delete process.env.EXTENSION_ALLOW_LEAD_ACTIVATION;
      else process.env.EXTENSION_ALLOW_LEAD_ACTIVATION = original;
      if (auditDisabled === undefined) delete process.env.RBAC_AUDIT_DISABLED;
      else process.env.RBAC_AUDIT_DISABLED = auditDisabled;
    }
  });

  test("operator install, list, get, versions, and changed hooks round-trip", async () => {
    const first = await install();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const extension = firstBody.extension as { id: string; version: number };
    expect(extension.version).toBe(1);

    const list = await dispatch("/api/extensions");
    expect(list.status).toBe(200);
    expect((await list.json()).extensions).toHaveLength(1);

    const detail = await dispatch(`/api/extensions/${extension.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect((detailBody.manifest as { name: string }).name).toBe("minimal");
    expect((detailBody.files as Record<string, string>)["hooks.ts"]).toContain("SwarmExtension");

    await useChangedMinimal("\n// changed hooks\n");
    const changed = await install();
    expect(changed.status).toBe(200);
    expect(((await changed.json()).extension as { version: number }).version).toBe(2);

    const versions = await dispatch(`/api/extensions/${extension.id}/versions`);
    expect(versions.status).toBe(200);
    expect((await versions.json()).versions).toHaveLength(2);
  });

  test("GET runs returns both rows newest-first", async () => {
    await install();
    const extension = await getExtensionByName("minimal");
    const first = await insertExtensionRun({
      extensionId: extension!.id,
      version: 1,
      event: "pre.task.create",
      action: "continue",
      message: "First run",
    });
    const second = await insertExtensionRun({
      extensionId: extension!.id,
      version: 1,
      event: "post.task.created",
      action: "continue",
      message: "Second run",
    });

    const response = await dispatch(`/api/extensions/${extension!.id}/runs`);
    expect(response.status).toBe(200);
    expect((await response.json()).runs).toEqual([second, first]);
  });

  test("worker installs are owned, disabled, and cannot activate their own extension", async () => {
    const response = await install("minimal", workerId);
    expect(response.status).toBe(200);
    const extension = (await response.json()).extension as {
      enabled: boolean;
      createdByAgentId: string | null;
    };
    expect(extension.enabled).toBe(false);
    expect(extension.createdByAgentId).toBe(workerId);
    const stored = (await getExtensionByName("minimal"))!;
    expect(stored.status).toBe("disabled");
    expect(stored.agentId).toBeNull();
    for (const operation of ["enable", "disable", "activate-version"]) {
      expect(
        (
          await dispatch(`/api/extensions/${stored.id}/${operation}`, {
            method: "POST",
            agentId: workerId,
            body: JSON.stringify({ version: 1 }),
          })
        ).status,
      ).toBe(403);
    }
    expect(await listExtensionRuns(stored.id)).toHaveLength(0);
    expect((await dispatch(`/api/extensions/${stored.id}`)).text).toContain(workerId);
    expect((await dispatch("/api/extensions")).text).toContain(workerId);
    await useChangedMinimal("\n// worker draft v2\n");
    expect((await install("minimal", workerId)).status).toBe(200);
    expect(await getExtensionByName("minimal")).toMatchObject({
      version: 2,
      activeVersion: 1,
      enabled: false,
      status: "disabled",
      createdByAgentId: workerId,
    });
    const versions = await listExtensionVersions(stored.id);
    expect(versions).toHaveLength(2);
    expect(versions.every((version) => version.changedByAgentId === workerId)).toBe(true);
  });

  test("install never evaluates worker bundle code", async () => {
    await useChangedMinimal('\nthrow new Error("must only run on activation");\n');
    const response = await install("minimal", workerId);
    expect(response.status).toBe(200);
    const stored = (await getExtensionByName("minimal"))!;
    expect(stored).toMatchObject({ enabled: false, status: "disabled", agentId: null });
    expect(await listExtensionRuns(stored.id)).toHaveLength(0);
    const activation = await dispatch(`/api/extensions/${stored.id}/enable`, { method: "POST" });
    expect(activation.status).toBe(500);
    expect(activation.text).toContain("must only run on activation");
  });

  test("workers cannot overwrite, patch, or delete another owner's extension", async () => {
    await install("minimal", leadId);
    const stored = (await getExtensionByName("minimal"))!;
    expect((await install("minimal", workerId)).status).toBe(403);
    for (const method of ["PATCH", "DELETE"]) {
      expect(
        (
          await dispatch(`/api/extensions/${stored.id}`, {
            method,
            agentId: workerId,
            ...(method === "PATCH" ? { body: JSON.stringify({ priority: 7 }) } : {}),
          })
        ).status,
      ).toBe(403);
    }
    expect(await getExtensionByName("minimal")).toMatchObject({
      createdByAgentId: leadId,
      priority: 100,
      version: 1,
    });
  });

  test("worker owners edit and delete disabled drafts, but cannot reload live code", async () => {
    await install("minimal", workerId);
    const stored = (await getExtensionByName("minimal"))!;
    const path = `/api/extensions/${stored.id}`;
    expect(
      (
        await dispatch(path, {
          method: "PATCH",
          agentId: workerId,
          body: JSON.stringify({ priority: 7 }),
        })
      ).status,
    ).toBe(200);
    expect((await dispatch(`${path}/enable`, { method: "POST", agentId: leadId })).status).toBe(
      200,
    );
    expect(
      (
        await dispatch(path, {
          method: "PATCH",
          agentId: workerId,
          body: JSON.stringify({ config: { live: true } }),
        })
      ).status,
    ).toBe(403);
    await useChangedMinimal('\nthrow new Error("inactive worker version executed");\n');
    expect((await install("minimal", workerId, { config: { live: true } })).status).toBe(403);
    expect((await install("minimal", workerId)).status).toBe(200);
    // A permitted reload must keep using version 1, never evaluate the worker draft.
    expect(
      (
        await dispatch(path, {
          method: "PATCH",
          agentId: leadId,
          body: JSON.stringify({ priority: 7 }),
        })
      ).status,
    ).toBe(200);
    expect(await getExtensionByName("minimal")).toMatchObject({
      version: 2,
      activeVersion: 1,
      enabled: true,
      configJson: "{}",
    });
    expect((await dispatch(path, { method: "DELETE", agentId: workerId })).status).toBe(409);
    expect((await dispatch(`${path}/disable`, { method: "POST" })).status).toBe(200);
    expect((await dispatch(path, { method: "DELETE", agentId: workerId })).status).toBe(200);
    expect(await getExtensionByName("minimal")).toBeNull();
  });

  test("operator reinstall activates a new version when the extension is enabled", async () => {
    await install();
    const existing = await getExtensionByName("minimal");
    await setExtensionState(existing!.id, { enabled: true, status: "enabled" });

    await useChangedMinimal("\n// operator update\n");
    const response = await install();

    expect(response.status).toBe(200);
    const extension = (await response.json()).extension as {
      version: number;
      activeVersion: number;
      enabled: boolean;
    };
    expect(extension).toMatchObject({ version: 2, activeVersion: 2, enabled: true });
  });

  test("lead reinstall never activates a new version", async () => {
    await install();
    const existing = await getExtensionByName("minimal");
    await setExtensionState(existing!.id, { enabled: true, status: "enabled" });

    await useChangedMinimal("\n// lead update\n");
    const response = await install("minimal", leadId);

    expect(response.status).toBe(200);
    const extension = (await response.json()).extension as {
      version: number;
      activeVersion: number;
      enabled: boolean;
    };
    expect(extension).toMatchObject({ version: 2, activeVersion: 1, enabled: true });
  });

  test("PATCH updates priority and DELETE rejects enabled extensions", async () => {
    await install();
    const extension = await getExtensionByName("minimal");
    expect(extension).not.toBeNull();

    const patched = await dispatch(`/api/extensions/${extension!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ priority: 10 }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()).extension as { priority: number }).priority).toBe(10);

    await setExtensionState(extension!.id, { enabled: true, status: "enabled" });
    const rejected = await dispatch(`/api/extensions/${extension!.id}`, { method: "DELETE" });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error).toContain("Disable");
  });

  test("type definitions are plain text and workers cannot activate extensions", async () => {
    await install();
    const extension = await getExtensionByName("minimal");
    const types = await dispatch("/api/extensions/type-defs");
    expect(types.status).toBe(200);
    expect(types.text).toContain('declare module "swarm-extension"');

    expect(
      (
        await dispatch(`/api/extensions/${extension!.id}/enable`, {
          method: "POST",
          agentId: workerId,
        })
      ).status,
    ).toBe(403);
    expect(
      (await dispatch(`/api/extensions/${extension!.id}/enable`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      (await dispatch(`/api/extensions/${extension!.id}/disable`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      (
        await dispatch(`/api/extensions/${extension!.id}/activate-version`, {
          method: "POST",
          body: JSON.stringify({ version: 1 }),
        })
      ).status,
    ).toBe(200);
  });

  test("dashboard users can install and activate extensions", async () => {
    const installed = await install("minimal", undefined);
    expect(installed.status).toBe(200);
    const extension = await getExtensionByName("minimal");
    const patched = await dispatch(`/api/extensions/${extension!.id}`, {
      method: "PATCH",
      asUser: "user-1",
      body: JSON.stringify({ priority: 7 }),
    });
    expect(patched.status).toBe(200);
    expect(
      (
        await dispatch(`/api/extensions/${extension!.id}/enable`, {
          method: "POST",
          asUser: "user-1",
        })
      ).status,
    ).toBe(200);
  });

  test("enable returns 400 for config that fails the hooks schema", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.manifest = { ...bundle.manifest, name: "configured" };
    bundle.files["hooks.ts"] = `
import { z } from "zod";
import type { SwarmExtension } from "swarm-extension";
export const config = z.object({ channelId: z.string() });
const extension: SwarmExtension = () => {};
export default extension;
`;
    await useFixtureCatalog({ configured: bundle });
    const installed = await install("configured");
    expect(installed.status).toBe(200);
    const extension = (await installed.json()).extension as { id: string };

    const invalid = await dispatch(`/api/extensions/${extension.id}/enable`, { method: "POST" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("config is invalid");

    expect(
      (
        await dispatch(`/api/extensions/${extension.id}`, {
          method: "PATCH",
          body: JSON.stringify({ config: { channelId: "C1" } }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await dispatch(`/api/extensions/${extension.id}/enable`, { method: "POST" })).status,
    ).toBe(200);
  });

  test("configJson is scrubbed on every read path", async () => {
    process.env.EXT_QA_TOKEN = "extqaTOKENvalue_1234567890abcdef";
    refreshSecretScrubberCache();
    try {
      const installed = await install("minimal", undefined, {
        config: { token: "extqaTOKENvalue_1234567890abcdef", other: "a" },
      });
      expect(installed.status).toBe(200);
      const extension = await getExtensionByName("minimal");
      expect(extension!.configJson).toContain("extqaTOKENvalue_1234567890abcdef");
      for (const body of [
        await installed.json(),
        await (await dispatch(`/api/extensions/${extension!.id}`)).json(),
        await (
          await dispatch(`/api/extensions/${extension!.id}`, {
            method: "PATCH",
            body: JSON.stringify({ priority: 3 }),
          })
        ).json(),
      ]) {
        expect(JSON.stringify(body)).not.toContain("extqaTOKENvalue_1234567890abcdef");
        expect(JSON.stringify(body)).toContain("[REDACTED:EXT_QA_TOKEN]");
      }
      const list = JSON.stringify(await (await dispatch("/api/extensions")).json());
      expect(list).not.toContain("extqaTOKENvalue_1234567890abcdef");

      const patched = await dispatch(`/api/extensions/${extension!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          config: { token: "[REDACTED:EXT_QA_TOKEN]", other: "b" },
        }),
      });
      expect(patched.status).toBe(200);
      expect(JSON.parse((await getExtensionByName("minimal"))!.configJson)).toEqual({
        token: "extqaTOKENvalue_1234567890abcdef",
        other: "b",
      });

      // Nested objects, arrays, and structural (lowercase) markers survive a round trip.
      const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const nested = await dispatch(`/api/extensions/${extension!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          config: {
            token: "extqaTOKENvalue_1234567890abcdef",
            github: { token: ghToken, list: [ghToken, "plain"] },
          },
        }),
      });
      expect(nested.status).toBe(200);
      const nestedBody = JSON.stringify(await nested.json());
      expect(nestedBody).not.toContain(ghToken);
      expect(nestedBody).toContain("[REDACTED:github_token]");
      const roundTrip = await dispatch(`/api/extensions/${extension!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          config: {
            token: "[REDACTED:EXT_QA_TOKEN]",
            github: {
              token: "[REDACTED:github_token]",
              list: ["[REDACTED:github_token]", "changed"],
            },
          },
        }),
      });
      expect(roundTrip.status).toBe(200);
      expect(JSON.parse((await getExtensionByName("minimal"))!.configJson)).toEqual({
        token: "extqaTOKENvalue_1234567890abcdef",
        github: { token: ghToken, list: [ghToken, "changed"] },
      });
    } finally {
      delete process.env.EXT_QA_TOKEN;
      refreshSecretScrubberCache();
    }
  });

  test("invalid fixtures return readable diagnostics", async () => {
    const expected = [
      ["bad-import", "node:fs"],
      ["worker-runtime", 'runtime "worker" is not supported in v1'],
      ["reserved-assets", "assets.skills.0"],
    ];
    for (const [fixture, diagnostic] of expected) {
      const response = await install(fixture);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("extension_validation_failed");
      expect((body.diagnostics as string[]).join("\n")).toContain(diagnostic!);
    }
    expect((await (await dispatch("/api/extensions")).json()).extensions).toEqual([]);
  });

  test("inline bundles are rejected before anything is stored", async () => {
    const bundle = await loadBundleFixture("minimal");
    for (const body of [bundle, { template: "minimal", files: bundle.files }]) {
      const response = await dispatch("/api/extensions/install", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("inline_install_disabled");
      expect(json.message).toContain("template");
    }
    expect(await getExtensionByName("minimal")).toBeNull();
  });

  test("unknown templates return 404", async () => {
    const response = await install("not-in-catalog");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("extension_template_not_found");
    expect(body.message).toContain("not-in-catalog");
    expect(await getExtensionByName("not-in-catalog")).toBeNull();
  });

  test("install reports asset changes for the active version and null for a staged one", async () => {
    const first = await install("minimal", leadId);
    expect((await first.json()).assets).toEqual({
      created: [],
      updated: [],
      skipped: [],
      deleted: [],
      detached: [],
    });
    const stored = (await getExtensionByName("minimal"))!;
    await setExtensionState(stored.id, { enabled: true, status: "enabled" });
    await useChangedMinimal("\n// staged by lead\n");
    const staged = await install("minimal", leadId);
    expect(staged.status).toBe(200);
    const stagedBody = await staged.json();
    expect(stagedBody.extension).toMatchObject({ version: 2, activeVersion: 1 });
    expect(stagedBody.assets).toBeNull();
  });

  test("template assets are created on install and removed on delete", async () => {
    await useFixtureCatalog(["with-assets"]);
    const installed = await install("with-assets");
    expect(installed.status).toBe(200);
    const body = await installed.json();
    expect(body.assets).toMatchObject({
      created: expect.arrayContaining([
        { kind: "script", name: "with-assets-echo" },
        { kind: "schedule", name: "with-assets-hourly" },
      ]),
      deleted: [],
      detached: [],
    });
    const catalog = (await (await dispatch("/api/extensions/catalog")).json()).extensions;
    expect(catalog).toEqual([
      expect.objectContaining({ name: "with-assets", assets: { scripts: 1, schedules: 1 } }),
    ]);

    const id = (body.extension as { id: string }).id;
    const deleted = await dispatch(`/api/extensions/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()).assets as { deleted: unknown[] }).deleted).toEqual(
      expect.arrayContaining([
        { kind: "script", name: "with-assets-echo" },
        { kind: "schedule", name: "with-assets-hourly" },
      ]),
    );
  });

  test("GET catalog lists templates with their installed state", async () => {
    const before = await dispatch("/api/extensions/catalog");
    expect(before.status).toBe(200);
    const beforeItems = (await before.json()).extensions as Array<Record<string, unknown>>;
    expect(beforeItems.map((item) => item.name).sort()).toEqual([...CATALOG_FIXTURES].sort());
    expect(beforeItems.find((item) => item.name === "minimal")).toEqual({
      name: "minimal",
      description: "Minimal extension",
      version: "1.0.0",
      manifestFile: "manifest.json",
      assets: {},
      readme: null,
      installed: null,
    });
    expect(beforeItems.find((item) => item.name === "reserved-assets")?.assets).toEqual({
      skills: 1,
    });

    const installed = await install("minimal", workerId);
    expect(installed.status).toBe(200);
    const id = ((await installed.json()).extension as { id: string }).id;
    const after = (await (await dispatch("/api/extensions/catalog", { agentId: workerId })).json())
      .extensions as Array<Record<string, unknown>>;
    expect(after.find((item) => item.name === "minimal")?.installed).toEqual({
      id,
      version: 1,
      enabled: false,
    });
    expect(after.find((item) => item.name === "post-logger")?.installed).toBeNull();
  });

  test("extensions installed inline before the catalog keep their lifecycle", async () => {
    // Simulate a pre-catalog inline install: no catalog entry and no extension_assets rows.
    const bundle = await loadBundleFixture("minimal");
    bundle.manifest = { ...bundle.manifest, name: "legacy-inline" };
    const { extension } = await installExtension({ ...bundle, createdBy: "legacy-operator" });
    const path = `/api/extensions/${extension.id}`;
    expect(
      (await (await dispatch("/api/extensions/catalog")).json()).extensions as unknown[],
    ).not.toContainEqual(expect.objectContaining({ name: "legacy-inline" }));

    const enabled = await dispatch(`${path}/enable`, { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(await getExtensionByName("legacy-inline")).toMatchObject({
      enabled: true,
      status: "enabled",
      activeVersion: 1,
    });
    expect((await dispatch(`${path}/disable`, { method: "POST" })).status).toBe(200);
    expect(await getExtensionByName("legacy-inline")).toMatchObject({ enabled: false });

    const deleted = await dispatch(path, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, assets: { deleted: [], detached: [] } });
    expect(await getExtensionByName("legacy-inline")).toBeNull();
  });
  test("activate-version with an asset conflict answers 400 and keeps the old version on", async () => {
    await useFixtureCatalog(["with-assets"]);
    const installed = await install("with-assets");
    const id = ((await installed.json()).extension as { id: string }).id;
    const path = `/api/extensions/${id}`;
    expect((await dispatch(`${path}/enable`, { method: "POST" })).status).toBe(200);

    // Stage v2 (a lead install never activates it) with a schedule someone else holds.
    const next = await loadBundleFixture("with-assets");
    next.manifest = {
      ...next.manifest,
      version: "1.1.0",
      assets: {
        ...next.manifest.assets,
        schedules: [
          ...(next.manifest.assets.schedules ?? []),
          { name: "with-assets-daily", script: "with-assets-echo", intervalMs: 86_400_000 },
        ],
      },
    };
    await useFixtureCatalog({ "with-assets": next });
    expect((await install("with-assets", leadId)).status).toBe(200);
    await createScheduledTask({
      name: "with-assets-daily",
      intervalMs: 60_000,
      taskTemplate: "someone else's",
    });

    try {
      const response = await dispatch(`${path}/activate-version`, {
        method: "POST",
        body: JSON.stringify({ version: 2 }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "extension_validation_failed",
        diagnostics: [
          'schedule "with-assets-daily" already exists and does not belong to this extension',
        ],
      });
      expect(await getExtensionByName("with-assets")).toMatchObject({
        enabled: true,
        status: "enabled",
        activeVersion: 1,
      });
      expect((await getScheduledTaskByName("with-assets-hourly"))?.enabled).toBe(true);
    } finally {
      await dispatch(`${path}/disable`, { method: "POST" });
      await dispatch(path, { method: "DELETE" });
      await getDbClient().run("DELETE FROM scheduled_tasks WHERE name = 'with-assets-daily'");
    }
  });
});
