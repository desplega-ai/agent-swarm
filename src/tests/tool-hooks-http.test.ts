import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import type { InstallExtensionArgs as ExtensionInstallBody } from "../be/extensions/db";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { handleToolHooks } from "../http/tool-hooks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { loadBundleFixture } from "./fixtures/extensions/load";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-tool-hooks-http.sqlite";
const FAKE_PAT = `ghp_${"aB3dE6".repeat(6)}`;
const ENV_SECRET_NAME = "NATIVE_HOOK_TEST_API_KEY";
const ENV_SECRET = `zq${crypto.randomUUID().replaceAll("-", "")}`;

type Seen = { event: string; payload: Record<string, unknown> }[];
const holder = globalThis as { __nativeToolSeen?: Seen };
holder.__nativeToolSeen ??= [];
const seen = (): Seen => holder.__nativeToolSeen ?? [];

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function enableFixture(name: string, config?: Record<string, unknown>) {
  const bundle: ExtensionInstallBody = { ...(await loadBundleFixture(name)), config };
  const installed = await installExtension(bundle);
  return await enableExtension(installed.extension.id);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for a tool hook");
    await Bun.sleep(20);
  }
}

describe("POST /api/tool-hooks", () => {
  let server: Server;
  let baseUrl = "";
  let agentId = "";

  async function post(body: unknown, headers: Record<string, string> = { "X-Agent-ID": agentId }) {
    const response = await fetch(`${baseUrl}/api/tool-hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const secretCall = () => ({
    phase: "pre",
    harness: "pi",
    tool: "bash",
    nativeTool: "bash",
    args: { command: `curl -H "Authorization: token ${FAKE_PAT}" x && echo ${ENV_SECRET}` },
    rawArgs: { command: `echo ${ENV_SECRET}`, nested: [FAKE_PAT] },
    toolCallId: "call-1",
  });

  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    process.env[ENV_SECRET_NAME] = ENV_SECRET;
    refreshSecretScrubberCache();
    agentId = (
      await createAgent({
        name: "native-hook-worker",
        isLead: false,
        status: "busy",
        capabilities: [],
      })
    ).id;
    server = createHttpServer(async (req, res) => {
      const url = req.url || "/";
      const myAgentId = req.headers["x-agent-id"] as string | undefined;
      if (
        !(await handleToolHooks(req, res, getPathSegments(url), parseQueryParams(url), myAgentId))
      ) {
        res.writeHead(404).end();
      }
    });
    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    server.close();
    await stopExtensionRuntime();
    closeDb();
    delete process.env[ENV_SECRET_NAME];
    refreshSecretScrubberCache();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    seen().length = 0;
    const client = getDbClient();
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM kv_entries");
  });

  test("a handler sees secrets as redaction markers and nothing persisted holds them", async () => {
    const extension = await enableFixture("native-tool-recorder");

    const response = await post(secretCall());

    expect(response).toEqual({ status: 200, json: { action: "continue" } });
    expect(seen()).toHaveLength(1);
    const payload = seen()[0]!.payload;
    const delivered = JSON.stringify(payload);
    expect(delivered).not.toContain(FAKE_PAT);
    expect(delivered).not.toContain(ENV_SECRET);
    expect(JSON.stringify(payload.args)).toContain("[REDACTED:");
    expect(JSON.stringify(payload.rawArgs)).toContain(`[REDACTED:${ENV_SECRET_NAME}]`);
    expect(payload.requestInfo).toMatchObject({ agentId, callOrigin: "native", harness: "pi" });
    expect(payload).toMatchObject({ tool: "bash", nativeTool: "bash", toolCallId: "call-1" });

    const runs = await listExtensionRuns(extension.id);
    expect(runs).toEqual([expect.objectContaining({ event: "pre.tool.call", action: "continue" })]);
    const persisted = JSON.stringify([runs, await getDbClient().query("SELECT * FROM kv_entries")]);
    expect(persisted).toContain("[REDACTED:");
    expect(persisted).not.toContain(FAKE_PAT);
    expect(persisted).not.toContain(ENV_SECRET);
  });

  test("a modify whose args carry a redaction marker is rejected and the call continues", async () => {
    const extension = await enableFixture("native-tool-recorder", { echoArgs: true });

    expect(await post(secretCall())).toEqual({ status: 200, json: { action: "continue" } });
    const runs = await listExtensionRuns(extension.id);
    expect(runs).toEqual([
      expect.objectContaining({
        event: "pre.tool.call",
        action: "error",
        message: expect.stringContaining("redaction marker"),
      }),
    ]);

    // Control: the same echo on clean args is a real modify.
    const clean = await post({ ...secretCall(), args: { command: "ls" }, rawArgs: undefined });
    expect(clean).toEqual({ status: 200, json: { action: "modify", args: { command: "ls" } } });
  });

  test("an extension without native in toolSources is not invoked", async () => {
    const bundle = await loadBundleFixture("native-tool-recorder");
    const { toolSources: _omit, ...manifest } = bundle.manifest;
    const installed = await installExtension({ ...bundle, manifest });
    const extension = await enableExtension(installed.extension.id);

    expect(await post(secretCall())).toEqual({ status: 200, json: { action: "continue" } });
    expect(seen()).toHaveLength(0);
    expect(await listExtensionRuns(extension.id)).toEqual([]);
  });

  test("post phase returns 202 and runs post.tool.call with a scrubbed result", async () => {
    await enableFixture("native-tool-recorder");

    const response = await post({
      ...secretCall(),
      phase: "post",
      result: { stdout: FAKE_PAT },
      isError: false,
      durationMs: 12,
    });

    expect(response).toEqual({ status: 202, json: { accepted: true } });
    await waitFor(() => seen().length === 1);
    const payload = seen()[0]!;
    expect(payload.event).toBe("post");
    expect(JSON.stringify(payload.payload.result)).not.toContain(FAKE_PAT);
    expect(payload.payload).toMatchObject({ durationMs: 12, isError: false });
  });

  test("rejects a missing agent header and an unknown phase", async () => {
    expect((await post(secretCall(), {})).status).toBe(400);
    expect((await post({ ...secretCall(), phase: "during" })).status).toBe(400);
  });
});
