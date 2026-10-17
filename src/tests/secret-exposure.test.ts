import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import {
  DEFAULT_UNKNOWN_SECRET_EXPOSURE,
  NEW_UNKNOWN_SECRET_EXPOSURE,
  registryExposureFor,
  secretExposureFor,
  unknownSecretExposureDefault,
} from "../be/secret-exposure";
import { validateConfigValue } from "../be/swarm-config-guard";
import { handleConfig } from "../http/config";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-secret-exposure.sqlite";
const originalDefault = process.env.SECRET_EXPOSURE_DEFAULT;

// Built at runtime so no secret-shaped literal lives in the repo.
function syntheticValue(): string {
  return `synthetic-${crypto.randomUUID()}`;
}

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, { kind: "operator" });
    const ok = await handleConfig(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
    );
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

afterEach(() => {
  if (originalDefault === undefined) delete process.env.SECRET_EXPOSURE_DEFAULT;
  else process.env.SECRET_EXPOSURE_DEFAULT = originalDefault;
});

async function storedRow(key: string) {
  const [row] = await getSwarmConfigs({ scope: "global", key });
  if (!row) throw new Error(`missing row ${key}`);
  return row;
}

describe("registry defaults", () => {
  test("each inventory class resolves to its exposure", () => {
    expect(registryExposureFor("ANTHROPIC_API_KEY")).toBe("worker");
    expect(registryExposureFor("GITHUB_TOKEN")).toBe("worker");
    expect(registryExposureFor("codex_oauth")).toBe("worker");
    expect(registryExposureFor("SLACK_BOT_TOKEN")).toBe("lead");
    expect(registryExposureFor("GITHUB_APP_PRIVATE_KEY")).toBe("lead");
    expect(registryExposureFor("API_AGENT_FS_API_KEY")).toBe("api");
    expect(registryExposureFor("SLACK_SIGNING_SECRET")).toBe("api");
  });

  test("pattern keys match only their exact shape", () => {
    expect(registryExposureFor("codex_oauth_0")).toBe("worker");
    expect(registryExposureFor("codex_oauth_42")).toBe("worker");
    expect(registryExposureFor("codex_oauth_x")).toBeNull();
    expect(registryExposureFor("connection.github.secret")).toBe("lead");
    expect(registryExposureFor("connection.a.b.secret")).toBeNull();
    expect(registryExposureFor("connection.github.oauth")).toBeNull();
  });

  test("matching is case-sensitive, like the API-only list it replaces", () => {
    expect(registryExposureFor("slack_signing_secret")).toBeNull();
  });
});

describe("secretExposureFor", () => {
  test("a row override beats the registry default", () => {
    expect(secretExposureFor({ key: "ANTHROPIC_API_KEY", exposure: "lead" })).toBe("lead");
    expect(secretExposureFor({ key: "SLACK_BOT_TOKEN", exposure: "worker" })).toBe("worker");
  });

  test("an unknown key falls back to SECRET_EXPOSURE_DEFAULT", () => {
    delete process.env.SECRET_EXPOSURE_DEFAULT;
    expect(DEFAULT_UNKNOWN_SECRET_EXPOSURE).toBe("worker");
    expect(secretExposureFor({ key: "SOME_UNKNOWN_KEY" })).toBe("worker");
    process.env.SECRET_EXPOSURE_DEFAULT = "lead";
    expect(secretExposureFor({ key: "SOME_UNKNOWN_KEY" })).toBe("lead");
    expect(secretExposureFor({ key: "SOME_UNKNOWN_KEY", exposure: "worker" })).toBe("worker");
  });

  test("an invalid SECRET_EXPOSURE_DEFAULT falls back to the constant", () => {
    for (const value of ["api", "bogus", ""]) {
      process.env.SECRET_EXPOSURE_DEFAULT = value;
      expect(unknownSecretExposureDefault()).toBe(DEFAULT_UNKNOWN_SECRET_EXPOSURE);
    }
  });

  test("the config guard accepts only worker and lead for SECRET_EXPOSURE_DEFAULT", () => {
    expect(validateConfigValue("SECRET_EXPOSURE_DEFAULT", "worker")).toBeNull();
    expect(validateConfigValue("SECRET_EXPOSURE_DEFAULT", "lead")).toBeNull();
    expect(validateConfigValue("SECRET_EXPOSURE_DEFAULT", "api")).not.toBeNull();
  });
});

describe("upsertSwarmConfig exposure", () => {
  test("INSERT of an unknown secret stamps lead; UPDATE without exposure keeps it", async () => {
    expect(NEW_UNKNOWN_SECRET_EXPOSURE).toBe("lead");
    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_UNKNOWN_SECRET_A",
      value: syntheticValue(),
      isSecret: true,
    });
    expect(await storedRow("TEST_UNKNOWN_SECRET_A")).toMatchObject({
      exposure: "lead",
      effectiveExposure: "lead",
    });

    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_UNKNOWN_SECRET_A",
      value: syntheticValue(),
      isSecret: true,
    });
    expect(await storedRow("TEST_UNKNOWN_SECRET_A")).toMatchObject({
      exposure: "lead",
      effectiveExposure: "lead",
    });
  });

  test("UPDATE keeps a NULL exposure NULL, even when the row becomes secret", async () => {
    await upsertSwarmConfig({ scope: "global", key: "TEST_UNKNOWN_PLAIN", value: "one" });
    expect((await storedRow("TEST_UNKNOWN_PLAIN")).exposure).toBeNull();
    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_UNKNOWN_PLAIN",
      value: syntheticValue(),
      isSecret: true,
    });
    expect(await storedRow("TEST_UNKNOWN_PLAIN")).toMatchObject({
      exposure: null,
      effectiveExposure: "worker",
    });
  });

  test("INSERT with an explicit null exposure stores NULL, not the lead stamp", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_UNKNOWN_SECRET_NULL",
      value: syntheticValue(),
      isSecret: true,
      exposure: null,
    });
    expect(await storedRow("TEST_UNKNOWN_SECRET_NULL")).toMatchObject({
      exposure: null,
      effectiveExposure: "worker",
    });
  });

  test("a registry-worker key rewritten without exposure stays worker", async () => {
    for (let i = 0; i < 2; i++) {
      await upsertSwarmConfig({
        scope: "global",
        key: "ANTHROPIC_API_KEY",
        value: syntheticValue(),
        isSecret: true,
      });
      expect(await storedRow("ANTHROPIC_API_KEY")).toMatchObject({
        exposure: null,
        effectiveExposure: "worker",
      });
    }
  });

  test("an explicit exposure is stored on INSERT and on UPDATE; null clears it", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_EXPLICIT",
      value: syntheticValue(),
      isSecret: true,
      exposure: "worker",
    });
    expect((await storedRow("TEST_EXPLICIT")).exposure).toBe("worker");

    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_EXPLICIT",
      value: syntheticValue(),
      isSecret: true,
      exposure: "api",
    });
    expect(await storedRow("TEST_EXPLICIT")).toMatchObject({
      exposure: "api",
      effectiveExposure: "api",
    });

    await upsertSwarmConfig({
      scope: "global",
      key: "TEST_EXPLICIT",
      value: syntheticValue(),
      isSecret: true,
      exposure: null,
    });
    expect(await storedRow("TEST_EXPLICIT")).toMatchObject({
      exposure: null,
      effectiveExposure: "worker",
    });
  });

  test("a stored override on a pinned key does not widen it", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "SLACK_SIGNING_SECRET",
      value: syntheticValue(),
      isSecret: true,
      exposure: "worker",
    });
    expect((await storedRow("SLACK_SIGNING_SECRET")).effectiveExposure).toBe("api");
  });
});

describe("HTTP PUT /api/config exposure", () => {
  async function put(body: Record<string, unknown>) {
    const res = await fetch(`http://localhost:${port}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", isSecret: true, ...body }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("sets, keeps and clears the override and masks the value", async () => {
    const value = syntheticValue();
    const first = await put({ key: "TEST_HTTP_EXPOSURE", value, exposure: "worker" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ exposure: "worker", effectiveExposure: "worker" });
    expect(first.body.value).not.toBe(value);

    const kept = await put({ key: "TEST_HTTP_EXPOSURE", value: syntheticValue() });
    expect(kept.body).toMatchObject({ exposure: "worker", effectiveExposure: "worker" });

    const cleared = await put({
      key: "TEST_HTTP_EXPOSURE",
      value: syntheticValue(),
      exposure: null,
    });
    expect(cleared.body).toMatchObject({ exposure: null, effectiveExposure: "worker" });
  });

  test("rejects an exposure outside the enum", async () => {
    const res = await put({ key: "TEST_HTTP_BOGUS", value: syntheticValue(), exposure: "bogus" });
    expect(res.status).toBe(400);
  });

  test("INSERT with an explicit null exposure stores NULL", async () => {
    const res = await put({
      key: "TEST_HTTP_INSERT_NULL",
      value: syntheticValue(),
      exposure: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exposure: null, effectiveExposure: "worker" });
  });

  test("list reads keep an ordinary row with an api override and still omit pinned keys", async () => {
    await put({ key: "TEST_HTTP_API_OVERRIDE", value: syntheticValue(), exposure: "api" });
    await put({ key: "SLACK_SIGNING_SECRET", value: syntheticValue() });
    for (const path of ["/api/config?scope=global", "/api/config/resolved"]) {
      const res = await fetch(`http://localhost:${port}${path}`);
      expect(res.status).toBe(200);
      const { configs } = (await res.json()) as { configs: Array<Record<string, unknown>> };
      const keys = configs.map((config) => config.key);
      expect(keys).toContain("TEST_HTTP_API_OVERRIDE");
      expect(keys).not.toContain("SLACK_SIGNING_SECRET");
    }
  });

  test("list reads return exposure and effectiveExposure on every row", async () => {
    const res = await fetch(`http://localhost:${port}/api/config?scope=global`);
    const { configs } = (await res.json()) as { configs: Array<Record<string, unknown>> };
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(config).toHaveProperty("exposure");
      expect(["worker", "lead", "api"]).toContain(config.effectiveExposure as string);
    }
  });
});
