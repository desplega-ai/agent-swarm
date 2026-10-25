import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../providers/codex-adapter";
import type { ProviderSessionConfig } from "../providers/types";

const keyVars = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
let savedEnv: Record<string, string | undefined>;
let home: string;

beforeEach(async () => {
  savedEnv = Object.fromEntries(["HOME", ...keyVars].map((key) => [key, process.env[key]]));
  home = await mkdtemp(join(tmpdir(), "credential-validation-codex-"));
  process.env.HOME = home;
  for (const key of keyVars) process.env[key] = "example-first, example-second";
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

function config(env?: Record<string, string>): ProviderSessionConfig {
  return {
    agentId: crypto.randomUUID(),
    prompt: "test",
    systemPrompt: "",
    cwd: home,
    logFile: "/dev/null",
    env,
  };
}

describe("Codex credential pools", () => {
  for (const source of ["container", "task", "task-pool"] as const) {
    test(`app-server uses one OpenAI key from ${source}`, async () => {
      let capturedEnv: Record<string, string> | undefined;
      const adapter = new CodexAdapter({
        bypassSubprocess: true,
        appServerFactory: ({ env }) => {
          capturedEnv = env;
          throw new Error("test stops before app-server spawn");
        },
      });
      const env =
        source === "container"
          ? {}
          : {
              OPENAI_API_KEY:
                source === "task" ? "example-task" : "example-task-first, example-task-second",
            };
      await expect(adapter.createSession(config(env))).rejects.toThrow(
        "test stops before app-server spawn",
      );
      expect(
        source === "container"
          ? ["example-first", "example-second"]
          : source === "task"
            ? ["example-task"]
            : ["example-task-first", "example-task-second"],
      ).toContain(capturedEnv?.OPENAI_API_KEY);
    });

    test(`subprocess forwards one key per provider from ${source}`, async () => {
      let capturedEnv: Record<string, string | undefined> | undefined;
      const spawn = spyOn(Bun, "spawn").mockImplementation(((
        ...args: Parameters<typeof Bun.spawn>
      ) => {
        capturedEnv = args[1]?.env;
        throw new Error("test stops before subprocess spawn");
      }) as typeof Bun.spawn);
      try {
        const env =
          source === "container"
            ? {}
            : Object.fromEntries(
                keyVars.map((key) => [
                  key,
                  source === "task" ? "example-task" : "example-task-first, example-task-second",
                ]),
              );
        await expect(new CodexAdapter().createSession(config(env))).rejects.toThrow(
          "test stops before subprocess spawn",
        );
        for (const key of keyVars) {
          expect(
            source === "container"
              ? ["example-first", "example-second"]
              : source === "task"
                ? ["example-task"]
                : ["example-task-first", "example-task-second"],
          ).toContain(capturedEnv?.[key]);
        }
      } finally {
        spawn.mockRestore();
      }
    });
  }

  test("chatgpt mode still removes the OpenAI API key", async () => {
    await Bun.write(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    let capturedEnv: Record<string, string> | undefined;
    const adapter = new CodexAdapter({
      bypassSubprocess: true,
      appServerFactory: ({ env }) => {
        capturedEnv = env;
        throw new Error("test stops before app-server spawn");
      },
    });
    await expect(adapter.createSession(config({ OPENAI_API_KEY: "example-task" }))).rejects.toThrow(
      "test stops before app-server spawn",
    );
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined();
  });
});
