/**
 * Issue #1800 end to end: the real Claude Code CLI completes a prompt on each
 * claude default route (LiteLLM-style gateway, Microsoft Foundry, Amazon
 * Bedrock, Google Vertex AI) against a fake endpoint, through the worker's
 * credential gate and the claude adapter's spawn path.
 *
 * The CLI is the binary @anthropic-ai/claude-agent-sdk ships for this platform
 * (the version the SDK pins), or `CLAUDE_ROUTES_E2E_BINARY`. Without either the
 * suite skips. `CLAUDE_ROUTES_E2E_LOG=1` prints each fake server's requests,
 * auth redacted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deriveDefaultRoute } from "@desplega/model-routing";
import { closeDb, createAgent, getAgentById, initDb, updateAgentCredentialState } from "../be/db";
import { awaitCredentials } from "../commands/credential-wait";
import { buildCredStatusReport } from "../commands/provider-credentials";
import { ClaudeAdapter } from "../providers/claude-adapter";
import type { CredStatus } from "../providers/types";
import {
  type CapturedRequest,
  type FakeRouteKind,
  redactedRequestLine,
  startFakeRouteServer,
} from "./fixtures/fake-claude-routes";
import { runChild } from "./test-proc";

const OAUTH_TOKEN = "sk-ant-oat01-route-e2e-must-not-leak";
const REPLY = "ROUTE-E2E-FAKE-REPLY";
const SPAWN_TIMEOUT_MS = 90_000;

function sdkClaudeBinary(): string | null {
  const override = process.env.CLAUDE_ROUTES_E2E_BINARY;
  if (override) return existsSync(override) ? override : null;
  const require = createRequire(import.meta.url);
  const platform = `${process.platform}-${process.arch}`;
  for (const pkg of [platform, `${platform}-musl`]) {
    try {
      const dir = dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${pkg}/package.json`));
      const binary = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
      if (existsSync(binary)) return binary;
    } catch {
      // Optional dependency not installed for this platform.
    }
  }
  return null;
}

const CLAUDE_BINARY = sdkClaudeBinary();

interface RouteCase {
  kind: FakeRouteKind;
  provider: string;
  env(baseUrl: string): Record<string, string>;
  /** The streamed turn that carries the prompt. */
  turnPath: RegExp;
  /** Credential header the CLI must send, or null for none (skip-auth). */
  auth: { header: string; value: string } | null;
  /** True when the route has a free key check the credential report runs. */
  liveChecked: boolean;
}

const ROUTES: RouteCase[] = [
  {
    kind: "gateway",
    provider: "anthropic-gateway",
    env: (baseUrl) => ({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "sk-gateway-e2e" }),
    turnPath: /^\/v1\/messages(\?|$)/,
    auth: { header: "authorization", value: "Bearer sk-gateway-e2e" },
    liveChecked: true,
  },
  {
    kind: "foundry",
    provider: "foundry",
    env: (baseUrl) => ({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: `${baseUrl}/anthropic`,
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-e2e-key",
    }),
    turnPath: /^\/anthropic\/v1\/messages(\?|$)/,
    auth: { header: "x-api-key", value: "foundry-e2e-key" },
    liveChecked: false,
  },
  {
    kind: "bedrock",
    provider: "bedrock",
    env: (baseUrl) => ({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_BEDROCK_BASE_URL: baseUrl,
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-e2e-token",
    }),
    turnPath: /^\/model\/[^/]+\/invoke-with-response-stream$/,
    auth: { header: "authorization", value: "Bearer bedrock-e2e-token" },
    liveChecked: false,
  },
  {
    kind: "vertex",
    provider: "vertex",
    env: (baseUrl) => ({
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_VERTEX_PROJECT_ID: "route-e2e",
      ANTHROPIC_VERTEX_BASE_URL: `${baseUrl}/v1`,
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    }),
    turnPath:
      /^\/v1\/projects\/route-e2e\/locations\/us-east5\/publishers\/anthropic\/models\/[^/]+:streamRawPredict$/,
    auth: null,
    liveChecked: false,
  },
];

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * The env an operator gives a worker on this route, plus the two things a
 * fleet carries over from subscription days: a Claude OAuth token and
 * claude-bridge switched on. Isolated HOME so no host settings or hooks load.
 */
function operatorEnv(route: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: tempDir("claude-route-home-"),
    CLAUDE_BINARY: CLAUDE_BINARY ?? "claude",
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    SWARM_USE_CLAUDE_BRIDGE: "true",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...route,
  };
}

class GateParked extends Error {}

/** Runs the worker's boot gate once. Returns the final status, or the first parked one. */
async function runGate(env: Record<string, string>): Promise<CredStatus> {
  const ticks: CredStatus[] = [];
  try {
    return await awaitCredentials({
      provider: "claude",
      initialEnv: env,
      refreshEnv: async () => ({}),
      onTick: (status) => ticks.push(status),
      sleep: async () => {
        throw new GateParked();
      },
      log: () => {},
    });
  } catch (err) {
    if (!(err instanceof GateParked) || !ticks[0]) throw err;
    return ticks[0];
  }
}

/** The runner's report, as the API applies it to the agent row. */
async function reportedAgentStatus(env: Record<string, string>) {
  const report = await buildCredStatusReport("claude", env, {}, "boot");
  const agent = await createAgent({
    name: `route-e2e-${crypto.randomUUID().slice(0, 8)}`,
    isLead: false,
    status: "idle",
    capabilities: [],
  });
  await updateAgentCredentialState(agent.id, report.ready, report.missing);
  return { report, agent: await getAgentById(agent.id) };
}

function assertNoOAuthToken(requests: CapturedRequest[]): void {
  for (const req of requests) {
    expect(Object.values(req.headers).some((value) => value.includes(OAUTH_TOKEN))).toBe(false);
    expect(req.body.includes(OAUTH_TOKEN)).toBe(false);
  }
}

function logRequests(label: string, requests: CapturedRequest[]): void {
  if (!process.env.CLAUDE_ROUTES_E2E_LOG) return;
  console.log(`[${label}] ${requests.length} request(s)`);
  for (const req of requests) console.log(`  ${redactedRequestLine(req)}`);
}

const TEST_DB_PATH = "./test-claude-routes-e2e.sqlite";

describe.skipIf(!CLAUDE_BINARY)("claude routes e2e (real CLI, fake endpoints)", () => {
  beforeAll(() => {
    rmSync(TEST_DB_PATH, { force: true });
    initDb(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDb();
    for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
      rmSync(path, { force: true });
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  for (const route of ROUTES) {
    test(
      `${route.kind}: gate passes and the CLI completes a prompt on the route`,
      async () => {
        const fake = startFakeRouteServer(route.kind, REPLY);
        try {
          const env = operatorEnv(route.env(fake.baseUrl));
          expect(deriveDefaultRoute("claude", env)?.provider).toBe(route.provider);

          const gate = await runGate(env);
          expect(gate).toMatchObject({ ready: true, missing: [] });
          const { report, agent } = await reportedAgentStatus(env);
          expect(agent?.status).toBe("idle");
          if (route.liveChecked) {
            expect(report.liveTest).toMatchObject({ ok: true });
          } else {
            expect(report.liveTest).toBeNull();
          }

          const cwd = tempDir("claude-route-cwd-");
          const session = await new ClaudeAdapter(async () => {}).createSession({
            prompt: "Reply with the text the model gives you.",
            systemPrompt: "",
            model: "sonnet",
            role: "worker",
            agentId: crypto.randomUUID(),
            taskId: crypto.randomUUID(),
            apiUrl: "",
            apiKey: "",
            cwd,
            logFile: join(cwd, "session.jsonl"),
            env,
          });
          const result = await session.waitForCompletion();
          logRequests(route.kind, fake.requests);

          expect(result).toMatchObject({ isError: false, exitCode: 0 });
          expect(result.output).toContain(REPLY);

          const turn = fake.requests.find(
            (req) => req.method === "POST" && route.turnPath.test(req.path),
          );
          expect(turn).toBeDefined();
          if (route.auth) {
            expect(turn?.headers[route.auth.header]).toBe(route.auth.value);
          } else {
            expect(turn?.headers.authorization).toBeUndefined();
            expect(turn?.headers["x-api-key"]).toBeUndefined();
          }
          assertNoOAuthToken(fake.requests);
        } finally {
          fake.stop();
        }
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test("gateway with only CLAUDE_CODE_OAUTH_TOKEN parks and never calls the gateway", async () => {
    const fake = startFakeRouteServer("gateway", REPLY);
    try {
      const env = operatorEnv({ ANTHROPIC_BASE_URL: fake.baseUrl });

      const gate = await runGate(env);
      expect(gate).toMatchObject({ ready: false, missing: ["ANTHROPIC_AUTH_TOKEN"] });
      const { report, agent } = await reportedAgentStatus(env);
      expect(report.liveTest).toBeNull();
      expect(agent?.status).toBe("waiting_for_credentials");
      expect(agent?.credentialMissing).toEqual(["ANTHROPIC_AUTH_TOKEN"]);

      const cwd = tempDir("claude-route-cwd-");
      await expect(
        new ClaudeAdapter(async () => {}).createSession({
          prompt: "Reply with the text the model gives you.",
          systemPrompt: "",
          model: "sonnet",
          role: "worker",
          agentId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          apiUrl: "",
          apiKey: "",
          cwd,
          logFile: join(cwd, "session.jsonl"),
          env,
        }),
      ).rejects.toThrow("No Claude credentials found");
      logRequests("gateway-oauth-only", fake.requests);
      expect(fake.requests).toHaveLength(0);
    } finally {
      fake.stop();
    }
  });

  // Control for the leak assertions above: the same env handed straight to the
  // CLI, without the gate or the adapter, does send the OAuth token to the gateway.
  test("control: the bare CLI sends CLAUDE_CODE_OAUTH_TOKEN to a gateway", async () => {
    const fake = startFakeRouteServer("gateway", REPLY);
    try {
      const env = operatorEnv({ ANTHROPIC_BASE_URL: fake.baseUrl });
      const result = await runChild(
        [env.CLAUDE_BINARY, "-p", "hi", "--model", "sonnet", "--output-format", "json"],
        { cwd: tempDir("claude-route-cwd-"), env },
      );
      logRequests("control-bare-cli", fake.requests);
      expect(result.stdout).toContain(REPLY);
      const turn = fake.requests.find((req) => req.method === "POST");
      expect(turn?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    } finally {
      fake.stop();
    }
  });
});
