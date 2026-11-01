import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createSwarmRepo, initDb, upsertSwarmConfig } from "../be/db";
import {
  approveAndSend,
  buildImprovementPayload,
  createImprovement,
  improvementLeakHints,
} from "../be/improvements";

const TEST_DB_PATH = "./test-improvements-payload.sqlite";
const AGENT_ID = "aaaa0000-0000-4000-8000-0000000000a1";
const ENDPOINT = "http://proxy.test/v1/improvements";
const ALLOWED_KEYS = ["install_id", "text", "email"];

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // Not there.
    }
  }
}

describe("improvement payload whitelist", () => {
  const originalFetch = globalThis.fetch;
  const savedTelemetry = process.env.ANONYMIZED_TELEMETRY;
  let sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    await createAgent({ id: AGENT_ID, name: "Picasso-Worker", isLead: false, status: "idle" });
    await createSwarmRepo({ url: "https://github.com/acme/secret-repo", name: "acme/secret-repo" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Acme Corp" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "acme.com" });
    await upsertSwarmConfig({
      scope: "global",
      key: "telemetry_installation_id",
      value: "install-123",
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({
        url: String(url),
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ status: "accepted", id: "proxy-1" }), { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (savedTelemetry === undefined) delete process.env.ANONYMIZED_TELEMETRY;
    else process.env.ANONYMIZED_TELEMETRY = savedTelemetry;
    closeDb();
    await removeDbFiles();
  });

  beforeEach(() => {
    sent = [];
  });

  test("the builder copies only install_id, text and email", () => {
    const loaded = {
      installId: "install-123",
      text: "Make the inbox faster",
      email: "me@example.com",
      requestedByAgentId: AGENT_ID,
      approvedBy: "operator",
      repo: "https://github.com/acme/secret-repo",
      orgName: "Acme Corp",
    };
    const payload = buildImprovementPayload(loaded);
    expect(Object.keys(payload).sort()).toEqual(["email", "install_id", "text"]);
    expect(payload).toEqual({
      install_id: "install-123",
      text: "Make the inbox faster",
      email: "me@example.com",
    });
    expect(buildImprovementPayload({ text: "t", installId: null, email: null })).toEqual({
      text: "t",
    });
  });

  test("an approved agent draft sends exactly the three fields with one header", async () => {
    process.env.ANONYMIZED_TELEMETRY = "true";
    const { improvement } = await createImprovement({
      text: "Please add bulk retry to the tasks page",
      source: "mcp",
      requestedByAgentId: AGENT_ID,
    });
    const result = await approveAndSend(improvement.id, {
      approvedBy: "operator",
      email: "person@example.com",
      endpoint: ENDPOINT,
    });
    expect(result.status).toBe("sent");
    expect(result.proxyId).toBe("proxy-1");
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(ENDPOINT);
    for (const key of Object.keys(request?.body ?? {})) expect(ALLOWED_KEYS).toContain(key);
    expect(request?.body).toEqual({
      install_id: "install-123",
      text: "Please add bulk retry to the tasks page",
      email: "person@example.com",
    });
    expect(Object.keys(request?.headers ?? {})).toEqual(["Content-Type"]);
    const wire = JSON.stringify(request?.body);
    for (const leaked of [AGENT_ID, "operator", "Acme Corp", "secret-repo", "mcp"]) {
      expect(wire).not.toContain(leaked);
    }
  });

  test("install_id is absent while telemetry is off, and a missing email is omitted", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    const { improvement } = await createImprovement({ text: "Dark mode", source: "ui" });
    await approveAndSend(improvement.id, { approvedBy: "operator", endpoint: ENDPOINT });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ text: "Dark mode" });
  });

  test("leak hints flag install-specific substrings without changing the text", async () => {
    const text =
      "Picasso-Worker failed on acme/secret-repo for Acme Corp, see https://acme.com/x and bob@acme.com";
    const hints = await improvementLeakHints(text);
    for (const hint of [
      "Picasso-Worker",
      "acme/secret-repo",
      "Acme Corp",
      "https://acme.com/x",
      "bob@acme.com",
    ]) {
      expect(hints).toContain(hint);
    }
    expect(await improvementLeakHints("Make search faster")).toEqual([]);
  });
});
