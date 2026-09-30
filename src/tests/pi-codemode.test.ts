import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  isPiCodemodeActive,
  PiMonoAdapter,
  piDefaultToolAdditions,
  piExtensionFactories,
} from "../providers/pi-mono-adapter";
import type { ModelTier } from "../types";

describe("PI_CODEMODE tier gate", () => {
  const tiers: Array<ModelTier | undefined> = ["smol", "regular", "smart", "ultra", undefined];

  test("flag off: codemode stays off on every tier", () => {
    for (const tier of tiers) expect(isPiCodemodeActive(tier, {})).toBe(false);
  });

  test("flag on: only smart and ultra tiers get codemode", () => {
    const env = { PI_CODEMODE: "true" };
    const active = tiers.map((tier) => isPiCodemodeActive(tier, env));
    expect(active).toEqual([false, false, true, true, false]);
  });
});

describe("pi extension factories and default tools — codemode", () => {
  const swarm: ExtensionFactory = () => {};

  test("codemode adds its extension and +codemode", () => {
    expect(piExtensionFactories(swarm, { toolDeferral: false, codemode: true })).toHaveLength(2);
    expect(piDefaultToolAdditions({ toolDeferral: false, codemode: true })).toEqual(["+codemode"]);
  });

  test("all features together", () => {
    const features = { toolDeferral: true, installedMcp: true, codemode: true };
    expect(piExtensionFactories(swarm, features)).toHaveLength(4);
    expect(piDefaultToolAdditions(features)).toEqual(["+tool_search", "+codemode"]);
  });
});

describe("PiMonoAdapter.createSession — codemode", () => {
  const envKeys = [
    "PI_CODEMODE",
    "PI_TOOL_DEFERRAL",
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
  ];
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "pi-codemode-"));
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.OPENROUTER_API_KEY = "example-test-key";
    // The session prompts on creation; keep that request off the network.
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.PI_CODEMODE = "true";
    delete process.env.PI_TOOL_DEFERRAL;
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function activeTools(modelTier: ModelTier | undefined): Promise<string[]> {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/mcp") return Response.json({ servers: [] });
        const body = (await req.json()) as { id?: number; method?: string };
        const result =
          body.method === "tools/list"
            ? {
                tools: [
                  { name: "store-progress", inputSchema: { type: "object" } },
                  { name: "create-page", inputSchema: { type: "object" } },
                ],
              }
            : { protocolVersion: "2025-03-26", capabilities: {} };
        return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
      },
    });
    let session: AgentSession | undefined;
    try {
      const provider = await new PiMonoAdapter().createSession({
        prompt: "hello",
        systemPrompt: "",
        model: "openrouter/google/gemini-3-flash-preview",
        modelTier,
        role: "worker",
        agentId: "test-agent",
        taskId: "test-task",
        apiUrl: `http://localhost:${server.port}`,
        apiKey: "example-test-key",
        cwd: dir,
        logFile: join(dir, "session.log"),
      });
      session = (provider as unknown as { agentSession: AgentSession }).agentSession;
      return session.getActiveToolNames();
    } finally {
      session?.dispose();
      server.stop(true);
    }
  }

  test("smart tier: codemode is added and swarm tools stay declared", async () => {
    const active = await activeTools("smart");
    expect(active).toContain("codemode");
    expect(active).toContain("store-progress");
    expect(active).toContain("create-page");
  });

  test("regular tier or no tier: no codemode", async () => {
    expect(await activeTools("regular")).not.toContain("codemode");
    expect(await activeTools(undefined)).not.toContain("codemode");
  });
});
