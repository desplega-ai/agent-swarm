import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchTemplate } from "../commands/runner";

const validTemplate = {
  config: {
    name: "coder",
    displayName: "Coder",
    version: "1.0.0",
    agentDefaults: { role: "coder", capabilities: ["typescript"], maxTasks: 2, isLead: false },
  },
  files: {
    claudeMd: "claude",
    soulMd: "soul",
    identityMd: "identity",
    toolsMd: "tools",
    setupScript: "echo ready",
    heartbeatMd: "",
  },
};

const otherTemplate = {
  ...validTemplate,
  files: { ...validTemplate.files, setupScript: "echo changed", soulMd: "changed soul" },
};

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const bodies = new Map<string, string>();
const registry = Bun.serve({
  port: 0,
  fetch(request) {
    const id = new URL(request.url).pathname.replace(/^\/api\/templates\//, "");
    const body = bodies.get(id);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  },
});
const registryUrl = `http://127.0.0.1:${registry.port}`;
const cacheDirs: string[] = [];

async function freshCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runner-template-fetch-"));
  cacheDirs.push(dir);
  return dir;
}

beforeEach(() => bodies.clear());

afterAll(async () => {
  registry.stop(true);
  await Promise.all(cacheDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fetchTemplate", () => {
  test("returns a well-formed template unchanged", async () => {
    bodies.set("official/coder", JSON.stringify(validTemplate));
    const template = await fetchTemplate("official/coder", registryUrl, await freshCacheDir());
    expect(template).toEqual(validTemplate);
  });

  test("returns a template whose body matches the configured sha256", async () => {
    const body = JSON.stringify(validTemplate);
    bodies.set("official/coder", body);
    const template = await fetchTemplate(
      "official/coder",
      registryUrl,
      await freshCacheDir(),
      sha256(body),
    );
    expect(template).toEqual(validTemplate);
  });

  // One bad field per case, so dropping any single schema guard fails its case.
  const badFields: Array<[string, (t: typeof validTemplate) => unknown]> = [
    [
      "isLead as a string",
      (t) => ({
        ...t,
        config: { ...t.config, agentDefaults: { ...t.config.agentDefaults, isLead: "false" } },
      }),
    ],
    [
      "maxTasks as a string",
      (t) => ({
        ...t,
        config: { ...t.config, agentDefaults: { ...t.config.agentDefaults, maxTasks: "99" } },
      }),
    ],
    [
      "capabilities as a string",
      (t) => ({
        ...t,
        config: { ...t.config, agentDefaults: { ...t.config.agentDefaults, capabilities: "all" } },
      }),
    ],
    ["setupScript as a number", (t) => ({ ...t, files: { ...t.files, setupScript: 42 } })],
  ];
  for (const [label, mutate] of badFields) {
    test(`rejects a template with ${label}`, async () => {
      bodies.set("official/coder", JSON.stringify(mutate(validTemplate)));
      const template = await fetchTemplate("official/coder", registryUrl, await freshCacheDir());
      expect(template).toBeNull();
    });
  }

  test("rejects a template whose body does not match the configured sha256", async () => {
    const pinned = sha256(JSON.stringify(validTemplate));
    bodies.set("official/coder", JSON.stringify(otherTemplate));
    const cacheDir = await freshCacheDir();
    expect(await fetchTemplate("official/coder", registryUrl, cacheDir, pinned)).toBeNull();
    // The rejected body must not be cached and served on a later boot either.
    bodies.clear();
    expect(await fetchTemplate("official/coder", registryUrl, cacheDir, pinned)).toBeNull();
  });
});
