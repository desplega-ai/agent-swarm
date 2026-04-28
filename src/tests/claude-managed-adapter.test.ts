import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createProviderAdapter } from "../providers";
import { ClaudeManagedAdapter } from "../providers/claude-managed-adapter";

// Stash + restore env vars so this file plays nicely with the rest of the
// suite (other tests don't expect MANAGED_AGENT_ID / MANAGED_ENVIRONMENT_ID
// to be set).
const ORIGINAL_ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  MANAGED_AGENT_ID: process.env.MANAGED_AGENT_ID,
  MANAGED_ENVIRONMENT_ID: process.env.MANAGED_ENVIRONMENT_ID,
};

describe("ClaudeManagedAdapter (Phase 1 skeleton)", () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.MANAGED_AGENT_ID = "agent_x";
    process.env.MANAGED_ENVIRONMENT_ID = "env_x";
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("factory returns ClaudeManagedAdapter for 'claude-managed'", () => {
    const adapter = createProviderAdapter("claude-managed");
    expect(adapter).toBeInstanceOf(ClaudeManagedAdapter);
    expect(adapter.name).toBe("claude-managed");
  });

  test("factory still rejects unknown providers and lists claude-managed", () => {
    expect(() => createProviderAdapter("nope")).toThrow(
      'Unknown HARNESS_PROVIDER: "nope". Supported: claude, pi, codex, devin, claude-managed',
    );
  });

  test("formatCommand returns slash-prefixed name", () => {
    const adapter = new ClaudeManagedAdapter();
    expect(adapter.formatCommand("plan")).toBe("/plan");
  });

  test("canResume returns false in Phase 1", async () => {
    const adapter = new ClaudeManagedAdapter();
    await expect(adapter.canResume("any-session-id")).resolves.toBe(false);
  });

  test("createSession throws Not implemented (Phase 3)", async () => {
    const adapter = new ClaudeManagedAdapter();
    await expect(
      adapter.createSession({
        prompt: "hi",
        systemPrompt: "",
        model: "claude-sonnet-4-6",
        role: "worker",
        agentId: "agent-uuid",
        taskId: "task-uuid",
        apiUrl: "http://localhost:3013",
        apiKey: "123123",
        cwd: "/tmp",
        logFile: "/tmp/log.jsonl",
      }),
    ).rejects.toThrow("ClaudeManagedAdapter.createSession not yet implemented (Phase 3)");
  });

  test("ctor throws when MANAGED_AGENT_ID is missing", () => {
    const saved = process.env.MANAGED_AGENT_ID;
    delete process.env.MANAGED_AGENT_ID;
    try {
      expect(() => new ClaudeManagedAdapter()).toThrow(/MANAGED_AGENT_ID/);
    } finally {
      process.env.MANAGED_AGENT_ID = saved;
    }
  });

  test("ctor throws when ANTHROPIC_API_KEY is missing", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new ClaudeManagedAdapter()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
