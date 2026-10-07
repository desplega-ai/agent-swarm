/**
 * The API-side secret registry (src/be/secret-registry.ts) and the scrubber's
 * combined known-value matcher.
 *
 * Every secret here is built at runtime from random bytes. Assertions check
 * both directions: the value is gone, and the `[REDACTED:` marker plus the
 * surrounding non-secret text survive.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetEncryptionKeyForTests, encryptSecret } from "../be/crypto";
import {
  closeDb,
  createAgent,
  createMcpServer,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { upsertMcpOAuthToken } from "../be/db-queries/mcp-oauth";
import {
  getOAuthApp,
  updateAuthorizationTokens,
  upsertAuthorization,
  upsertOAuthApp,
} from "../be/db-queries/oauth";
import { createScriptApi, insertScript, rotateScriptApiSecret } from "../be/scripts/db";
import { encodedForms, loadSecretRegistry, registerStoredSecret } from "../be/secret-registry";
import {
  clearVolatileSecretsForTesting,
  refreshSecretScrubberCache,
  registerVolatileSecret,
  scrubSecrets,
} from "../utils/secret-scrubber";
import { randomToken } from "./synthetic-secret-helpers";

let tempDir: string;
let savedKey: string | undefined;
let agentId: string;

/**
 * A synthetic secret with `/`, `+` and `=` in it, so its URL-encoded form
 * differs from the raw value and its base64 is not just alphanumerics.
 */
function makeSecret(label: string): string {
  return [label, `${randomToken(12)}/${randomToken(12)}+${randomToken(8)}=`].join("_");
}

const PREFIX = "deploy step 4 printed";
const SUFFIX = "and moved on";

function wrap(form: string): string {
  return `${PREFIX} ${form} ${SUFFIX}`;
}

/** Every encoded shape of `value` a log line can carry, keyed by shape name. */
function shapes(value: string): Record<string, string> {
  return {
    raw: value,
    base64: Buffer.from(value).toString("base64"),
    base64url: Buffer.from(value).toString("base64url"),
    urlEncoded: encodeURIComponent(value),
  };
}

/** The value survives scrubbing in every shape (nothing knows it yet). */
function expectKnownNowhere(value: string): void {
  for (const form of Object.values(shapes(value))) {
    expect(scrubSecrets(wrap(form))).toBe(wrap(form));
  }
}

/** The value is redacted in every shape, marker and context intact. */
function expectRedactedEverywhere(value: string, name: string): void {
  for (const [shape, form] of Object.entries(shapes(value))) {
    const out = scrubSecrets(wrap(form));
    expect({ shape, leaked: out.includes(form) }).toEqual({ shape, leaked: false });
    expect(out).toBe(`${PREFIX} [REDACTED:${name}] ${SUFFIX}`);
  }
  // Embedded in a larger base64 blob at each byte offset mod 3 (Basic auth).
  for (const user of ["ab:", "abc:", "abcd:"]) {
    const basic = `Authorization: Basic ${Buffer.from(`${user}${value}`).toString("base64")} ok`;
    expect(scrubSecrets(basic)).toMatch(
      new RegExp(
        `^Authorization: Basic [A-Za-z0-9+/]{4,8}\\[REDACTED:${escapeRe(name)}\\][A-Za-z0-9+/=]{0,4} ok$`,
      ),
    );
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

beforeAll(async () => {
  savedKey = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  __resetEncryptionKeyForTests();
  tempDir = mkdtempSync(join(tmpdir(), "secret-registry-"));
  closeDb();
  initDb(join(tempDir, "registry.sqlite"));
  refreshSecretScrubberCache();
  const agent = await createAgent({ name: "registry-worker", isLead: false, status: "idle" });
  agentId = agent.id;
});

afterAll(() => {
  closeDb();
  clearVolatileSecretsForTesting();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  __resetEncryptionKeyForTests();
  refreshSecretScrubberCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("secret registry boot load", () => {
  test("redacts every stored secret and its encoded forms after a simulated restart", async () => {
    const configValue = makeSecret("regcfg");
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "REGISTRY_PROBE_TOKEN",
      value: configValue,
      isSecret: true,
    });

    const clientSecret = makeSecret("regclient");
    const accessToken = makeSecret("regaccess");
    const refreshToken = makeSecret("regrefresh");
    await upsertOAuthApp("regprovider", {
      clientId: "registry-client",
      clientSecret,
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      redirectUri: "https://swarm.example.test/callback",
      scopes: "read",
    });
    const app = await getOAuthApp("regprovider");
    if (!app) throw new Error("oauth app missing");
    await upsertAuthorization({ appId: app.id, accessToken, refreshToken });

    const server = await createMcpServer({
      name: `registry-mcp-${randomToken(6)}`,
      transport: "http",
      url: "https://mcp.example.test",
      scope: "swarm",
    });
    const mcpAccess = makeSecret("regmcp");
    await upsertMcpOAuthToken({
      mcpServerId: server.id,
      accessToken: mcpAccess,
      refreshToken: null,
      resourceUrl: "https://mcp.example.test/",
      authorizationServerIssuer: "https://as.example.test",
      authorizeUrl: "https://as.example.test/authorize",
      tokenUrl: "https://as.example.test/token",
      clientSource: "manual",
    });

    const script = await insertScript({
      name: `registry-probe-${randomToken(6)}`,
      scope: "agent",
      scopeId: agentId,
      source: "export default async function run() { return {}; }",
      description: "registry probe",
      intent: "test fixture",
      signatureJson: "{}",
      argsJsonSchema: null,
      agentId,
      typeChecked: true,
    });
    const api = await createScriptApi({ scriptId: script.id, agentId, authMode: "bearer" });
    if (!api.token) throw new Error("bearer token missing");
    const scriptToken = api.token;

    // Simulated restart: the scrubber forgets everything registered at write time.
    clearVolatileSecretsForTesting();
    for (const value of [configValue, clientSecret, accessToken, refreshToken, mcpAccess]) {
      expectKnownNowhere(value);
    }
    expect(scrubSecrets(wrap(scriptToken))).toBe(wrap(scriptToken));

    const loaded = await loadSecretRegistry();
    expect(loaded.failed).toBe(0);
    expect(loaded.config).toBeGreaterThanOrEqual(1);
    expect(loaded.oauth).toBeGreaterThanOrEqual(4);
    expect(loaded.scriptApi).toBeGreaterThanOrEqual(1);

    expectRedactedEverywhere(configValue, "config:REGISTRY_PROBE_TOKEN");
    expectRedactedEverywhere(clientSecret, "oauth:regprovider:client_secret");
    expectRedactedEverywhere(accessToken, "oauth:regprovider:access_token");
    expectRedactedEverywhere(refreshToken, "oauth:regprovider:refresh_token");
    expectRedactedEverywhere(mcpAccess, `oauth:mcp-${server.id}:access_token`);
    expectRedactedEverywhere(scriptToken, `script-api:${api.id}`);
  });

  test("a row that cannot be decrypted is counted and does not block the rest", async () => {
    const good = makeSecret("reggood");
    await upsertSwarmConfig({
      scope: "global",
      key: "REGISTRY_GOOD_SECRET",
      value: good,
      isSecret: true,
    });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDbClient().run(
      `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
       VALUES (?, 'global', NULL, 'REGISTRY_WRONG_KEY_SECRET', ?, 1, NULL, NULL, ?, ?, 1)`,
      [id, encryptSecret(makeSecret("regbad"), randomBytes(32)), now, now],
    );
    try {
      clearVolatileSecretsForTesting();
      const loaded = await loadSecretRegistry();
      expect(loaded.failed).toBe(1);
      expectRedactedEverywhere(good, "config:REGISTRY_GOOD_SECRET");
    } finally {
      await getDbClient().run("DELETE FROM swarm_config WHERE id = ?", [id]);
    }
  });
});

describe("secret registry write hooks", () => {
  test("a write after boot is redacted without a reload", async () => {
    clearVolatileSecretsForTesting();
    await loadSecretRegistry();

    const configValue = makeSecret("regwrite");
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "REGISTRY_LATE_TOKEN",
      value: configValue,
      isSecret: true,
    });
    expectRedactedEverywhere(configValue, "config:REGISTRY_LATE_TOKEN");

    const app = await getOAuthApp("regprovider");
    if (!app) throw new Error("oauth app missing");
    const auth = await upsertAuthorization({ appId: app.id, accessToken: makeSecret("regseed") });
    const refreshedAccess = makeSecret("regrefreshed");
    const refreshedRefresh = makeSecret("regrotated");
    await updateAuthorizationTokens(auth.id, {
      accessToken: refreshedAccess,
      refreshToken: refreshedRefresh,
    });
    expectRedactedEverywhere(refreshedAccess, "oauth:regprovider:access_token");
    expectRedactedEverywhere(refreshedRefresh, "oauth:regprovider:refresh_token");

    const [scriptApiId] = (
      await getDbClient().query<{ id: string }>("SELECT id FROM script_apis LIMIT 1")
    ).map((r) => r.id);
    if (!scriptApiId) throw new Error("script api missing");
    const rotated = await rotateScriptApiSecret(scriptApiId);
    if (!rotated?.token) throw new Error("rotation failed");
    expectRedactedEverywhere(rotated.token, `script-api:${scriptApiId}`);
  });
});

describe("combined known-value matcher", () => {
  test("encodedForms covers base64, base64url and URL encoding without the raw value", () => {
    const value = makeSecret("regforms");
    const forms = encodedForms(value);
    expect(forms).toContain(Buffer.from(value).toString("base64"));
    expect(forms).toContain(Buffer.from(value).toString("base64url"));
    expect(forms).toContain(encodeURIComponent(value));
    expect(forms).not.toContain(value);
  });

  test("longest value wins when one known value is a prefix of another", () => {
    clearVolatileSecretsForTesting();
    const short = `regshort_${randomToken(16)}`;
    const long = `${short}${randomToken(12)}`;
    registerVolatileSecret(short, "SHORT_ONE");
    registerVolatileSecret(long, "LONG_ONE");
    expect(scrubSecrets(`a ${long} b ${short} c`)).toBe(
      "a [REDACTED:LONG_ONE] b [REDACTED:SHORT_ONE] c",
    );
  });

  test("regex metacharacters in a value match literally", () => {
    clearVolatileSecretsForTesting();
    const value = `reg.*+?^\${}()|[]\\_${randomToken(16)}`;
    registerVolatileSecret(value, "META_ONE");
    const lookalike = value.replace(".*", "xx");
    expect(scrubSecrets(`x ${value} y ${lookalike} z`)).toBe(
      `x [REDACTED:META_ONE] y ${lookalike} z`,
    );
  });

  test("an env value keeps its env name when it is also registered as volatile", () => {
    clearVolatileSecretsForTesting();
    const envKey = `REGISTRY_ENV_${randomToken(6).toUpperCase()}_TOKEN`;
    const value = `regenv_${randomToken(24)}`;
    process.env[envKey] = value;
    try {
      refreshSecretScrubberCache();
      registerVolatileSecret(value, "volatile-name");
      expect(scrubSecrets(`v=${value};`)).toBe(`v=[REDACTED:${envKey}];`);
    } finally {
      delete process.env[envKey];
      refreshSecretScrubberCache();
    }
  });

  // Timing-sensitive (wall-clock ratio on a shared CI runner): retry absorbs a
  // noisy-neighbour spike; a real regression fails every attempt.
  test(
    "200 known values cost no more than 2x the 20-value baseline over 10k lines",
    () => {
      const lines: string[] = [];
      for (let i = 0; i < 10_000; i++) {
        lines.push(
          `{"type":"assistant","line":${i},"text":"ran step ${i} in /workspace/repo with id ${randomToken(16)} and exit 0"}`,
        );
      }

      const timeWith = (count: number): number => {
        clearVolatileSecretsForTesting();
        const values: string[] = [];
        for (let i = 0; i < count; i++) {
          const value = makeSecret(`regbench${i}`);
          values.push(value);
          registerStoredSecret(value, `bench:${i}`);
        }
        // Some lines carry a known value, so the replace path is exercised too.
        const corpus = lines.map((line, i) =>
          i % 100 === 0 ? `${line} ${values[i % count]}` : line,
        );
        for (const line of corpus.slice(0, 500)) scrubSecrets(line); // warm-up + matcher build
        const runs: number[] = [];
        for (let r = 0; r < 3; r++) {
          const start = performance.now();
          for (const line of corpus) scrubSecrets(line);
          runs.push(performance.now() - start);
        }
        // Spot-check correctness on the same corpus.
        expect(scrubSecrets(corpus[100] ?? "")).toContain("[REDACTED:bench:");
        return runs.sort((a, b) => a - b)[1] ?? 0;
      };

      const baseline = timeWith(20);
      const scaled = timeWith(200);
      console.log(
        `[secret-registry bench] 20 values: ${baseline.toFixed(1)} ms, 200 values: ${scaled.toFixed(1)} ms (10k lines)`,
      );
      expect(scaled).toBeLessThanOrEqual(baseline * 2);
    },
    { retry: 2, timeout: 60_000 },
  );
});
