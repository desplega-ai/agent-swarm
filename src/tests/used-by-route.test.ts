import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { closeDb, createAgent, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { fillOrgLogoFromWebsite } from "../be/org-profile";
import { handleUsedBy } from "../http/used-by";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-used-by-route.sqlite";
const OPERATOR: HttpRequestAuth = { kind: "operator", fingerprint: "op:test" };
const WORKER_ID = "bbbb0000-0000-4000-8000-0000000000e1";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // Not there.
    }
  }
}

async function post(body: unknown, auth: HttpRequestAuth | null, agentId?: string) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = "POST";
  req.url = "/api/used-by";
  req.headers = {
    "content-type": "application/json",
    ...(agentId ? { "x-agent-id": agentId } : {}),
  };
  setRequestAuth(req as never, auth);
  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  await handleUsedBy(
    req as never,
    res as never,
    getPathSegments(req.url),
    parseQueryParams(req.url),
    agentId,
  );
  return { statusCode, body: chunks.join("") };
}

const configValue = async (key: string) =>
  (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value;

describe("POST /api/used-by", () => {
  const originalFetch = globalThis.fetch;
  const savedEnvWebsite = process.env.SWARM_ORG_WEBSITE;
  const savedEnvName = process.env.SWARM_ORG_NAME;
  let proxied: Array<{ url: string; body: Record<string, unknown> }>;
  let proxyStatus: number;

  beforeAll(async () => {
    delete process.env.SWARM_ORG_WEBSITE;
    delete process.env.SWARM_ORG_NAME;
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    await createAgent({ id: WORKER_ID, name: "Worker", isLead: false, status: "idle" });
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      proxied.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      return new Response(null, { status: proxyStatus });
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    if (savedEnvWebsite !== undefined) process.env.SWARM_ORG_WEBSITE = savedEnvWebsite;
    if (savedEnvName !== undefined) process.env.SWARM_ORG_NAME = savedEnvName;
    globalThis.fetch = originalFetch;
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    proxied = [];
    proxyStatus = 202;
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Acme" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "acme.com" });
  });

  test("a non-lead agent gets 403 and nothing reaches the proxy", async () => {
    const result = await post({ granted: true }, null, WORKER_ID);
    expect(result.statusCode).toBe(403);
    expect(proxied).toEqual([]);
  });

  test("grant and revoke both reach the proxy and are stored", async () => {
    const grant = await post({ granted: true }, OPERATOR);
    expect(grant.statusCode).toBe(200);
    expect(proxied[0]?.url).toBe("https://proxy.desplega.sh/v1/used-by");
    expect(proxied[0]?.body).toMatchObject({
      org_name: "Acme",
      org_website: "acme.com",
      granted: true,
    });
    expect(await configValue("SWARM_USED_BY_CONSENT")).toBe("true");

    const revoke = await post({ granted: false }, OPERATOR);
    expect(revoke.statusCode).toBe(200);
    expect(proxied[1]?.body).toMatchObject({ granted: false });
    expect(await configValue("SWARM_USED_BY_CONSENT")).toBe("false");
  });

  test("with telemetry off the install ID stays home", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "telemetry_installation_id",
      value: "install_0123456789abcdef",
    });
    const saved = process.env.ANONYMIZED_TELEMETRY;
    process.env.ANONYMIZED_TELEMETRY = "true";
    await post({ granted: true }, OPERATOR);
    process.env.ANONYMIZED_TELEMETRY = "false";
    await post({ granted: true }, OPERATOR);
    if (saved === undefined) delete process.env.ANONYMIZED_TELEMETRY;
    else process.env.ANONYMIZED_TELEMETRY = saved;
    expect(proxied[0]?.body.install_id).toBe("install_0123456789abcdef");
    expect(proxied[1]?.body).not.toHaveProperty("install_id");
  });

  test("follows a stubbed feedback_endpoint", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "feedback_endpoint",
      value: "http://stub.test/v1/feedback",
    });
    await post({ granted: true }, OPERATOR);
    expect(proxied[0]?.url).toBe("http://stub.test/v1/used-by");
    await upsertSwarmConfig({
      scope: "global",
      key: "feedback_endpoint",
      value: "https://proxy.desplega.sh/v1/feedback",
    });
  });

  test("a proxy failure is a 502 and leaves the stored consent alone", async () => {
    await upsertSwarmConfig({ scope: "global", key: "SWARM_USED_BY_CONSENT", value: "false" });
    proxyStatus = 500;
    const result = await post({ granted: true }, OPERATOR);
    expect(result.statusCode).toBe(502);
    expect(await configValue("SWARM_USED_BY_CONSENT")).toBe("false");
  });

  test("a revoke after the website is cleared or changed uses the granted identity", async () => {
    expect((await post({ granted: true }, OPERATOR)).statusCode).toBe(200);
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "" });
    const revoke = await post({ granted: false }, OPERATOR);
    expect(revoke.statusCode).toBe(200);
    expect(proxied[1]?.body).toMatchObject({
      org_name: "Acme",
      org_website: "acme.com",
      granted: false,
    });

    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Acme Labs" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "acme.io" });
    expect((await post({ granted: false }, OPERATOR)).statusCode).toBe(200);
    expect(proxied[2]?.body).toMatchObject({ org_name: "Acme", org_website: "acme.com" });

    // A new grant sends, and from then on revokes with, the current identity.
    expect((await post({ granted: true }, OPERATOR)).statusCode).toBe(200);
    expect(proxied[3]?.body).toMatchObject({ org_name: "Acme Labs", org_website: "acme.io" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "" });
    await post({ granted: false }, OPERATOR);
    expect(proxied[4]?.body).toMatchObject({ org_name: "Acme Labs", org_website: "acme.io" });
  });

  test("without a website it is a 400", async () => {
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "" });
    const result = await post({ granted: true }, OPERATOR);
    expect(result.statusCode).toBe(400);
    expect(proxied).toEqual([]);
  });
});

describe("fillOrgLogoFromWebsite", () => {
  const savedEnvLogo = process.env.SWARM_ORG_LOGO_URL;

  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    delete process.env.SWARM_ORG_LOGO_URL;
  });

  afterAll(async () => {
    if (savedEnvLogo !== undefined) process.env.SWARM_ORG_LOGO_URL = savedEnvLogo;
    closeDb();
    await removeDbFiles();
  });

  test("fills an empty logo, follows a website change, and never overwrites a set logo", async () => {
    expect(await fillOrgLogoFromWebsite("acme.com")).toBe(true);
    expect(await configValue("SWARM_ORG_LOGO_URL")).toBe(
      "https://proxy.desplega.sh/v1/logo?domain=acme.com",
    );

    expect(await fillOrgLogoFromWebsite("acme.io")).toBe(true);
    expect(await configValue("SWARM_ORG_LOGO_URL")).toBe(
      "https://proxy.desplega.sh/v1/logo?domain=acme.io",
    );

    await upsertSwarmConfig({
      scope: "global",
      key: "SWARM_ORG_LOGO_URL",
      value: "https://cdn.acme.com/logo.svg",
    });
    expect(await fillOrgLogoFromWebsite("acme.com")).toBe(false);
    expect(await configValue("SWARM_ORG_LOGO_URL")).toBe("https://cdn.acme.com/logo.svg");
  });

  test("a person-set logo on the proxy's path or origin is never overwritten", async () => {
    for (const custom of [
      "https://brand.acme.com/v1/logo?domain=acme.com",
      "https://proxy.desplega.sh/v1/logo?domain=other.com",
    ]) {
      await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_LOGO_URL", value: custom });
      expect(await fillOrgLogoFromWebsite("acme.com")).toBe(false);
      expect(await configValue("SWARM_ORG_LOGO_URL")).toBe(custom);
    }
  });

  test("a logo set in the deployment env is not overwritten either", async () => {
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_LOGO_URL", value: "" });
    process.env.SWARM_ORG_LOGO_URL = "https://env.acme.com/logo.png";
    expect(await fillOrgLogoFromWebsite("acme.com")).toBe(false);
    delete process.env.SWARM_ORG_LOGO_URL;
  });
});
