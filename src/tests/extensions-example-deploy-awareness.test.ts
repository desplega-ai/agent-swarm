import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDb, getDbClient, getKv, initDb, upsertSwarmConfig } from "../be/db";
import { getExtensionById, installExtension } from "../be/extensions/db";
import { getCatalogEntry } from "../extensions/catalog";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { __resetInjectedEnvTracking, loadGlobalConfigsIntoEnv } from "../http/core";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-extensions-example-deploy-awareness.sqlite";
const DOKPLOY_KEY = "deploy-awareness-test-dokploy-key-abcdef";
const DOKPLOY_URL = "https://dokploy.test";
const COMPOSE_ID = "compose-under-test";

type DokployRequest = { url: string; apiKey: string | null };
type Deployment = { status: string; createdAt: string; startedAt?: string };

let fetchSpy: ReturnType<typeof spyOn>;
let requests: DokployRequest[];
let respond: (req: Request) => Response | Promise<Response>;
let savedEnv: NodeJS.ProcessEnv;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const note = (startedAt: string) =>
  `Note: a prod deploy started at ${startedAt.slice(11, 16)} UTC is in progress; your worker may restart in the next few minutes. Checkpoint with store-progress before long steps.`;

function deployments(list: Deployment[]) {
  respond = () => Response.json(list);
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function enableTemplate(config: Record<string, unknown> = {}) {
  const template = getCatalogEntry("deploy-awareness");
  if (!template) throw new Error("deploy-awareness is missing from the catalog");
  const installed = await installExtension({
    manifest: template.manifest,
    files: template.files,
    config: { composeId: COMPOSE_ID, ...config },
  });
  return await enableExtension(installed.extension.id);
}

const createTask = async (description = "do the thing") =>
  (await createTaskWithSiblingAwareness(description, { source: "api" }, { origin: "rest" })).task;

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await upsertSwarmConfig({
    scope: "global",
    key: "DOKPLOY_API_KEY",
    value: DOKPLOY_KEY,
    isSecret: true,
  });
  // The API server does this at boot, which is how the key reaches process.env in prod.
  await loadGlobalConfigsIntoEnv(true);

  // Calls to Dokploy (the default host and the .test hosts these tests use) land here, so a
  // request to a host the test never expected is recorded instead of leaving the process.
  // Anything else, such as the background pricing refresh, goes to the real fetch. An aborted
  // signal rejects, like the real fetch.
  const realFetch = globalThis.fetch;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const { hostname } = new URL(request.url);
    if (hostname !== "app.dokploy.com" && !hostname.endsWith(".test")) {
      return await realFetch(input, init);
    }
    requests.push({ url: request.url, apiKey: request.headers.get("x-api-key") });
    return await Promise.race([
      Promise.resolve(respond(request)),
      new Promise<never>((_, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        }),
      ),
    ]);
  }) as unknown as typeof fetch);
});

afterAll(async () => {
  await stopExtensionRuntime();
  fetchSpy.mockRestore();
  closeDb();
  await removeDbFiles();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  __resetInjectedEnvTracking();
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  await stopExtensionRuntime();
  await getDbClient().run("DELETE FROM extensions");
  await getDbClient().run("DELETE FROM kv_entries");
  process.env.DOKPLOY_API_KEY = DOKPLOY_KEY;
  process.env.DOKPLOY_BASE_URL = DOKPLOY_URL;
  requests = [];
  deployments([]);
});

describe("deploy-awareness extension", () => {
  test("appends the note while the newest deployment is running", async () => {
    const startedAt = minutesAgo(2);
    // Out of order on purpose: compose.one lists deployments in no chronological order.
    deployments([
      { status: "done", createdAt: minutesAgo(180) },
      { status: "running", createdAt: startedAt, startedAt },
      { status: "done", createdAt: minutesAgo(120) },
    ]);
    const extension = await enableTemplate();

    const description = await createTask("fix the flaky test");

    expect(description).toBe(`fix the flaky test\n\n${note(startedAt)}`);
    expect(requests).toEqual([
      {
        url: `${DOKPLOY_URL}/api/deployment.allByCompose?composeId=${COMPOSE_ID}`,
        apiKey: DOKPLOY_KEY,
      },
    ]);
    // The key must not reach the description or the cache entry.
    expect(description).not.toContain(DOKPLOY_KEY);
    const cached = await getKv(
      `task:agent:${extension.agentId}`,
      "ext:deploy-awareness:deploy-status",
    );
    expect(JSON.stringify(cached)).not.toContain(DOKPLOY_KEY);
  });

  test("leaves the description alone when the newest deployment is done", async () => {
    // An older record stuck in "running" must not count.
    deployments([
      { status: "running", createdAt: minutesAgo(300), startedAt: minutesAgo(300) },
      { status: "done", createdAt: minutesAgo(10) },
    ]);
    await enableTemplate();

    expect(await createTask("quiet deploy")).toBe("quiet deploy");
  });

  test("ignores a running deployment older than staleAfterMs", async () => {
    deployments([{ status: "running", createdAt: minutesAgo(90), startedAt: minutesAgo(90) }]);
    await enableTemplate({ staleAfterMs: 30 * 60_000 });

    expect(await createTask("stuck record")).toBe("stuck record");
  });

  test("a second task inside the window reuses the check, and the next window checks again", async () => {
    const startedAt = minutesAgo(1);
    deployments([{ status: "running", createdAt: startedAt, startedAt }]);
    await enableTemplate({ cacheTtlMs: 120_000 });

    expect(await createTask("first")).toContain(note(startedAt));
    expect(await createTask("second")).toContain(note(startedAt));
    expect(requests).toHaveLength(1);

    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    try {
      deployments([{ status: "done", createdAt: startedAt }]);
      expect(await createTask("third")).toBe("third");
      expect(requests).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("tasks created together share one Dokploy call", async () => {
    const startedAt = minutesAgo(1);
    deployments([{ status: "running", createdAt: startedAt, startedAt }]);
    await enableTemplate();

    const created = await Promise.all([createTask("a"), createTask("b"), createTask("c")]);

    expect(created.every((description) => description.includes(note(startedAt)))).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test("a Dokploy error adds no note, still creates the task, and is cached", async () => {
    respond = () => new Response("boom", { status: 500 });
    const extension = await enableTemplate();

    expect(await createTask("during outage")).toBe("during outage");
    expect(await createTask("still down")).toBe("still down");
    expect(requests).toHaveLength(1);
    expect((await getExtensionById(extension.id))?.status).toBe("enabled");
  });

  test("failures never auto-disable the extension", async () => {
    respond = () => new Response("boom", { status: 500 });
    const extension = await enableTemplate({ cacheTtlMs: 0 });

    // The default limit is five consecutive handler failures.
    for (let i = 0; i < 6; i++) expect(await createTask(`outage ${i}`)).toBe(`outage ${i}`);

    expect(requests).toHaveLength(6);
    expect((await getExtensionById(extension.id))?.status).toBe("enabled");
  });

  test("a hung Dokploy call is cut off at timeoutMs and the task is created", async () => {
    respond = () => new Promise<Response>(() => {});
    await enableTemplate({ timeoutMs: 100 });

    const started = Date.now();
    expect(await createTask("slow dokploy")).toBe("slow dokploy");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("an unset DOKPLOY_API_KEY skips the Dokploy call", async () => {
    deployments([{ status: "running", createdAt: minutesAgo(1) }]);
    await enableTemplate();
    delete process.env.DOKPLOY_API_KEY;

    expect(await createTask("no key")).toBe("no key");
    expect(requests).toHaveLength(0);
  });

  test("DOKPLOY_BASE_URL defaults to app.dokploy.com", async () => {
    deployments([{ status: "done", createdAt: minutesAgo(5) }]);
    await enableTemplate();
    delete process.env.DOKPLOY_BASE_URL;

    await createTask("default host");

    expect(requests).toEqual([
      {
        url: `https://app.dokploy.com/api/deployment.allByCompose?composeId=${COMPOSE_ID}`,
        apiKey: DOKPLOY_KEY,
      },
    ]);
  });

  // The old config let a lead name any env var as the key and any host as the target. Both
  // fields are gone, so a config that still carries them must change nothing.
  test("a baseUrl or apiKeySecret in the extension config is not a lever", async () => {
    const encryptionKey = "deploy-awareness-test-encryption-key-123456";
    process.env.SECRETS_ENCRYPTION_KEY = encryptionKey;
    const startedAt = minutesAgo(1);
    deployments([{ status: "running", createdAt: startedAt, startedAt }]);
    await enableTemplate({
      baseUrl: "https://attacker.test",
      apiKeySecret: "SECRETS_ENCRYPTION_KEY",
    });

    expect(await createTask("lever")).toContain(note(startedAt));

    expect(requests).toEqual([
      {
        url: `${DOKPLOY_URL}/api/deployment.allByCompose?composeId=${COMPOSE_ID}`,
        apiKey: DOKPLOY_KEY,
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain(encryptionKey);
  });

  test.each([
    ["an http URL", "http://dokploy.test"],
    ["a non-http scheme", "ftp://dokploy.test"],
    ["a value that is not a URL", "dokploy.test"],
  ])("%s in DOKPLOY_BASE_URL sends no request and the task is still created", async (_name, url) => {
    deployments([{ status: "running", createdAt: minutesAgo(1) }]);
    const extension = await enableTemplate();
    process.env.DOKPLOY_BASE_URL = url;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await createTask("insecure host")).toBe("insecure host");

      expect(requests).toHaveLength(0);
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("DOKPLOY_BASE_URL");
      expect(logged).not.toContain(url);
      expect(logged).not.toContain(DOKPLOY_KEY);
    } finally {
      warn.mockRestore();
    }
    expect((await getExtensionById(extension.id))?.status).toBe("enabled");
  });

  test("a description that already carries the note is not checked or changed again", async () => {
    const startedAt = minutesAgo(1);
    deployments([{ status: "running", createdAt: startedAt, startedAt }]);
    // No cache reuse, so a check would show up in `requests`.
    await enableTemplate({ cacheTtlMs: 0 });
    const first = await createTask("resume me");
    expect(requests).toHaveLength(1);

    expect(await createTask(first)).toBe(first);
    expect(requests).toHaveLength(1);
  });
});
