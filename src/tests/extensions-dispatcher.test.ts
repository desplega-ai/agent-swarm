import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDb, getDbClient, getKv, initDb } from "../be/db";
import type { InstallExtensionArgs as ExtensionInstallBody } from "../be/extensions/db";
import {
  getExtensionById,
  installExtension,
  listExtensionRuns,
  setExtensionState,
} from "../be/extensions/db";
import { buildCtx } from "../extensions/ctx";
import {
  dispatchPost,
  dispatchPre,
  ExtensionAbortedError,
  extensionIdForAgent,
  isExtensionAgentId,
  listRegistered,
  registerLoaded,
  unregister,
} from "../extensions/dispatcher";
import { ensureExtensionAgent } from "../extensions/identity";
import {
  ExtensionLifecycleError,
  setExtensionLoopbackBaseUrl,
  stopExtensionRuntime,
} from "../extensions/lifecycle";
import { cleanExtensionTmpRoot, loadExtension } from "../extensions/loader";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-dispatcher.sqlite";
let savedTimeout: string | undefined;
let savedFailureLimit: string | undefined;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function loadAndRegister(bundle: ExtensionInstallBody, priority = 100) {
  const installed = await installExtension({ ...bundle, priority });
  const record = await setExtensionState(installed.extension.id, {
    agentId: await ensureExtensionAgent(installed.extension.name),
  });
  const loaded = await loadExtension({ record: record!, ...bundle });
  registerLoaded(loaded);
  return loaded;
}

async function fixture(name: string, priority = 100) {
  return await loadAndRegister(await loadBundleFixture(name), priority);
}

function taskPayload(description = "start") {
  return { options: {}, description, origin: "rest" as const };
}

async function blockBundle(name: string, reason: string): Promise<ExtensionInstallBody> {
  const bundle = await loadBundleFixture("minimal");
  bundle.manifest = { ...bundle.manifest, name, description: reason };
  bundle.files["hooks.ts"] = `
import { block, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => block(${JSON.stringify(reason)}));
};
export default extension;
`;
  return bundle;
}

describe("extension dispatcher", () => {
  beforeAll(async () => {
    savedTimeout = process.env.EXTENSION_HANDLER_TIMEOUT_MS;
    savedFailureLimit = process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES;
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    for (const loaded of listRegistered()) {
      unregister(loaded.record.id);
      await loaded.dispose();
    }
    await cleanExtensionTmpRoot();
    closeDb();
    await removeDbFiles();
    if (savedTimeout === undefined) delete process.env.EXTENSION_HANDLER_TIMEOUT_MS;
    else process.env.EXTENSION_HANDLER_TIMEOUT_MS = savedTimeout;
    if (savedFailureLimit === undefined) delete process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES;
    else process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = savedFailureLimit;
  });

  beforeEach(async () => {
    for (const loaded of listRegistered()) {
      unregister(loaded.record.id);
      await loaded.dispose();
    }
    await cleanExtensionTmpRoot();
    await getDbClient().run("DELETE FROM extensions");
    process.env.EXTENSION_HANDLER_TIMEOUT_MS = "5000";
    process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = "5";
  });

  test("runs by priority and feeds each modify into the next handler", async () => {
    await fixture("priority-a", 20);
    await fixture("priority-b", 10);
    expect(await dispatchPre("pre.task.create", taskPayload())).toEqual({
      action: "modify",
      data: { description: "startba" },
    });
  });

  test("returns the first block", async () => {
    await loadAndRegister(await blockBundle("block-first", "first"), 10);
    await loadAndRegister(await blockBundle("block-second", "second"), 20);
    const result = await dispatchPre("pre.task.create", taskPayload());
    expect(result).toMatchObject({ action: "block", reason: "first" });
  });

  test("fails open and records thrown handlers", async () => {
    const loaded = await fixture("throws");
    expect(await dispatchPre("pre.task.create", taskPayload())).toEqual({ action: "continue" });
    expect((await getExtensionById(loaded.record.id))?.consecutiveFailures).toBe(1);
    expect(await listExtensionRuns(loaded.record.id)).toMatchObject([
      { action: "error", event: "pre.task.create", message: "fixture failure" },
    ]);
  });

  test("auto-disables after five consecutive failures", async () => {
    const loaded = await fixture("throws");
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await dispatchPre("pre.task.create", taskPayload())).toEqual({ action: "continue" });
    }
    expect(await getExtensionById(loaded.record.id)).toMatchObject({
      enabled: false,
      status: "auto-disabled",
      consecutiveFailures: 5,
    });
    expect(listRegistered()).toHaveLength(0);
  });

  test("times out and fails open", async () => {
    process.env.EXTENSION_HANDLER_TIMEOUT_MS = "5";
    const loaded = await fixture("slow");
    const handler = loaded.handlers[0]!;
    const original = handler.handler;
    const finished = Promise.withResolvers<void>();
    let lateError: unknown;
    handler.handler = async (event, ctx) => {
      try {
        return await original(event, ctx);
      } catch (error) {
        lateError = error;
        throw error;
      } finally {
        finished.resolve();
      }
    };
    expect(await dispatchPre("pre.task.create", taskPayload())).toEqual({ action: "continue" });
    expect(
      (await listExtensionRuns(loaded.record.id)).some((run) => run.action === "timeout"),
    ).toBe(true);
    await finished.promise;
    expect(lateError).toBeInstanceOf(ExtensionAbortedError);
    expect(await getKv(`task:agent:${loaded.record.agentId}`, "ext:slow:after-timeout")).toBeNull();
  });

  test("uses the script SDK through the bound loopback URL and rejects before listen", async () => {
    await stopExtensionRuntime();
    const loaded = await fixture("minimal");
    const ctx = buildCtx(loaded, "pre.task.create", new AbortController().signal);
    await expect(ctx.swarm.task_get({ taskId: "x" })).rejects.toBeInstanceOf(
      ExtensionLifecycleError,
    );
    await expect(ctx.swarm.task_get({ taskId: "x" })).rejects.toThrow(
      "extension loopback not ready",
    );
    const savedFetch = globalThis.fetch;
    const savedKey = process.env.AGENT_SWARM_API_KEY;
    const requests: Request[] = [];
    try {
      process.env.AGENT_SWARM_API_KEY = "123123";
      setExtensionLoopbackBaseUrl("http://127.0.0.1:1");
      globalThis.fetch = (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ task: { id: "x" } });
      }) as typeof fetch;
      let result: unknown;
      loaded.handlers[0]!.handler = async (_event, handlerCtx) => {
        result = await handlerCtx.swarm.task_get({ taskId: "x" });
      };
      await dispatchPre("pre.task.create", taskPayload());
      expect(requests[0]?.url).toBe("http://127.0.0.1:1/api/tasks/x");
      expect(requests[0]?.headers.get("X-Agent-ID")).toBe(loaded.record.agentId);
      expect(requests[0]?.headers.get("Authorization")).toBe("Bearer 123123");
      expect(result).toEqual({ success: true, status: 200, data: { task: { id: "x" } } });
      expect(isExtensionAgentId(loaded.record.agentId)).toBe(true);
      expect(extensionIdForAgent(loaded.record.agentId)).toBe(loaded.record.id);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
      else process.env.AGENT_SWARM_API_KEY = savedKey;
      await stopExtensionRuntime();
    }
    expect(isExtensionAgentId(loaded.record.agentId)).toBe(false);
    expect(extensionIdForAgent(loaded.record.agentId)).toBeUndefined();
  });

  test("post dispatch skips its creator and runs the other extension", async () => {
    const first = await fixture("priority-a");
    const second = await fixture("priority-b");
    const calls: string[] = [];
    for (const loaded of [first, second]) {
      loaded.handlers = [
        {
          event: "post.slack.message",
          priority: 100,
          handler: () => {
            calls.push(loaded.record.name);
          },
        },
      ];
    }
    await dispatchPost(
      "post.slack.message",
      { channelId: "C1", userId: "U1", text: "test" },
      { skipExtensionId: first.record.id },
    );
    expect(calls).toEqual(["priority-b"]);
  });

  test("auto-disable skips remaining handlers in the same chain", async () => {
    process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = "1";
    const loaded = await fixture("throws");
    let called = false;
    loaded.handlers.push({
      event: "pre.task.create",
      priority: 200,
      handler: () => {
        called = true;
      },
    });
    await dispatchPre("pre.task.create", taskPayload());
    expect(called).toBe(false);
  });

  test("refuses to dispatch inside a transaction", async () => {
    const loaded = await fixture("priority-a");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await getDbClient().transaction(async () =>
        dispatchPre("pre.task.create", taskPayload()),
      );
      expect(result).toEqual({ action: "continue" });
      expect(error).toHaveBeenCalledWith(
        "[extensions] pre dispatch inside transaction:",
        "pre.task.create",
      );
      expect(await listExtensionRuns(loaded.record.id)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  test("skips the requested extension id", async () => {
    const loaded = await fixture("priority-a");
    expect(
      await dispatchPre("pre.task.create", taskPayload(), {
        skipExtensionId: loaded.record.id,
      }),
    ).toEqual({ action: "continue" });
  });
});
