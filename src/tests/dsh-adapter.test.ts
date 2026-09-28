import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProviderCredentials } from "../commands/provider-credentials";
import { createProviderAdapter } from "../providers";
import { checkDshCredentials, DshAdapter } from "../providers/dsh-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import { getModelAwareCredentialVars } from "../utils/credentials";
import { resolveHarnessProvider } from "../utils/harness-provider";
import { DEFAULT_OPENROUTER_BASE_URL } from "../utils/openrouter-base-url";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(mode = "success"): Promise<ProviderSessionConfig> {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-adapter-test-"));
  directories.push(cwd);
  const binary = join(cwd, "dsh");
  await Bun.write(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
const patchPath = args[args.indexOf("--patch") + 1];
const patch = await Bun.file(patchPath).json();
const prompt = await Bun.stdin.text();
await Bun.write("invocation.json", JSON.stringify({ args, patchPath, patch, prompt, cwd: process.cwd() }));
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "session", sessionId: "dsh-test-session" });
const mode = process.env.DSH_TEST_MODE;
if (mode === "abort") { setInterval(() => {}, 1000); }
else {
  if (mode === "malformed") console.log("bad json");
  emit({ type: "status", phase: "turn_end", reason: { kind: mode === "failure" ? "error" : "completed" } });
  if (mode !== "missing-final") {
    // A split UTF-8 character plus a final line without a newline exercises both decoders.
    const line = Buffer.from(JSON.stringify({ type: "final", text: "Done ✓" }));
    const split = line.indexOf(Buffer.from("✓")) + 1;
    process.stdout.write(line.subarray(0, split));
    await Bun.sleep(10);
    process.stdout.write(line.subarray(split));
  }
  if (mode === "failure") { console.error(process.env.DEEPSEEK_API_KEY); process.exitCode = 7; }
}
`,
  );
  await chmod(binary, 0o700);
  return {
    prompt: "--not-a-flag\nKeep $() and `quotes` literal.",
    systemPrompt: "System instructions:\n!!js must remain text",
    model: "deepseek-v4-pro",
    role: "worker",
    agentId: "agent-test",
    taskId: "task-test",
    apiUrl: "http://unused.invalid",
    apiKey: "unused",
    cwd,
    logFile: join(cwd, "log.jsonl"),
    env: {
      DSH_BINARY: binary,
      DEEPSEEK_API_KEY: "dsh-test-credential-value",
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: "",
      DSH_TEST_MODE: mode,
    },
  };
}

describe("dsh harness", () => {
  test("registry, model defaults, and credential dispatch select dsh", async () => {
    expect(await createProviderAdapter("dsh")).toBeInstanceOf(DshAdapter);
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "dsh" }, {})).toBe("dsh");
    expect(DEFAULT_MODEL_TIER_MAP.dsh).toEqual(DEFAULT_MODEL_TIER_MAP.pi);
    expect(checkDshCredentials({ OPENAI_API_KEY: "unrelated" }).ready).toBe(false);
    expect(checkDshCredentials({ DEEPSEEK_API_KEY: " " }).ready).toBe(false);
    expect(checkDshCredentials({}).missing).toEqual(["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"]);
    expect((await checkProviderCredentials("dsh", { OPENROUTER_API_KEY: "present" })).ready).toBe(
      true,
    );
    expect(getModelAwareCredentialVars("dsh", DEFAULT_MODEL_TIER_MAP.dsh.ultra)).toEqual([
      "OPENROUTER_API_KEY",
    ]);
    expect(getModelAwareCredentialVars("dsh", "deepseek-v4-pro")).toEqual(["DEEPSEEK_API_KEY"]);
    expect((await checkProviderCredentials("dsh", { DEEPSEEK_API_KEY: "present" })).ready).toBe(
      true,
    );
  });

  test("passes prompt on stdin, patches model/system, preserves cwd and cleans up", async () => {
    const config = await fixture();
    const session = await new DshAdapter().createSession(config);
    const events: ProviderEvent[] = [];
    session.onEvent((event) => events.push(event));
    expect(await session.waitForCompletion()).toMatchObject({
      exitCode: 0,
      isError: false,
      output: "Done ✓",
      sessionId: "dsh-test-session",
    });
    const invocation = await Bun.file(join(config.cwd, "invocation.json")).json();
    expect(invocation.prompt).toBe(config.prompt);
    // macOS tmpdir is a /var -> /private/var symlink; the child reports the real path.
    expect(await realpath(invocation.cwd)).toBe(await realpath(config.cwd));
    expect(invocation.args).toEqual([
      "--profile",
      "headless",
      "--patch",
      invocation.patchPath,
      "--json",
      "-",
    ]);
    expect(invocation.patch).toContainEqual({
      id: "agent-default-model",
      config: { provider: "deepseek-official", model: config.model },
    });
    expect(invocation.patch).toContainEqual({
      id: "system-prompt",
      config: { personaPrefix: config.systemPrompt },
    });
    expect(await Bun.file(invocation.patchPath).exists()).toBe(false);
    expect(events).toContainEqual({
      type: "session_init",
      sessionId: "dsh-test-session",
      provider: "dsh",
    });
  });

  for (const model of [
    DEFAULT_MODEL_TIER_MAP.dsh.regular,
    DEFAULT_MODEL_TIER_MAP.dsh.ultra,
    "openrouter/vendor/new-model",
  ]) {
    test(`routes ${model} through OpenRouter with only its key`, async () => {
      const config = await fixture();
      config.model = model;
      config.env = {
        ...config.env,
        DEEPSEEK_API_KEY: "",
        OPENROUTER_API_KEY: "openrouter-test-key",
      };
      const session = await new DshAdapter().createSession(config);
      expect((await session.waitForCompletion()).isError).toBe(false);
      const { patch } = await Bun.file(join(config.cwd, "invocation.json")).json();
      const modelId = model.slice("openrouter/".length);
      expect(patch).toContainEqual({
        id: "agent-default-model",
        config: { provider: "openrouter", model: modelId },
      });
      expect(patch).toContainEqual({
        id: "llm-pi-ai",
        config: {
          providers: {
            openrouter: {
              apiKeyEnv: "OPENROUTER_API_KEY",
              baseURL: DEFAULT_OPENROUTER_BASE_URL,
              api: "openai-completions",
              models: [{ id: modelId }],
            },
          },
        },
      });
      expect(JSON.stringify(patch)).not.toContain("openrouter-test-key");
    });
  }

  test("defaults to OpenRouter and honors its base URL when both keys exist", async () => {
    const config = await fixture();
    config.model = undefined;
    config.env = {
      ...config.env,
      OPENROUTER_API_KEY: "openrouter-test-key",
      OPENROUTER_BASE_URL: " https://gateway.example/proxy/v1/// ",
    };
    const session = await new DshAdapter().createSession(config);
    expect((await session.waitForCompletion()).isError).toBe(false);
    const { patch } = await Bun.file(join(config.cwd, "invocation.json")).json();
    expect(patch[0].config).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(patch[2].config.providers.openrouter.baseURL).toBe("https://gateway.example/proxy/v1");
  });

  test("bare models keep direct DeepSeek when both keys exist", async () => {
    const config = await fixture();
    config.env = { ...config.env, OPENROUTER_API_KEY: "openrouter-test-key" };
    const session = await new DshAdapter().createSession(config);
    expect((await session.waitForCompletion()).isError).toBe(false);
    const { patch } = await Bun.file(join(config.cwd, "invocation.json")).json();
    expect(patch[0].config.provider).toBe("deepseek-official");
    expect(patch[2]).toEqual({ id: "llm-deepseek", config: { apiKeyEnv: "DEEPSEEK_API_KEY" } });
  });

  test("fails closed for absent or mismatched credentials and empty model IDs", async () => {
    const config = await fixture();
    config.env = { ...config.env, DEEPSEEK_API_KEY: "", OPENROUTER_API_KEY: "" };
    await expect(new DshAdapter().createSession(config)).rejects.toThrow(
      "DEEPSEEK_API_KEY or OPENROUTER_API_KEY",
    );
    config.env.DEEPSEEK_API_KEY = "direct-test-key";
    config.model = DEFAULT_MODEL_TIER_MAP.dsh.regular;
    await expect(new DshAdapter().createSession(config)).rejects.toThrow(
      "requires OPENROUTER_API_KEY",
    );
    config.env = { ...config.env, DEEPSEEK_API_KEY: "", OPENROUTER_API_KEY: "openrouter-test-key" };
    config.model = "deepseek-v4-pro";
    await expect(new DshAdapter().createSession(config)).rejects.toThrow(
      "requires DEEPSEEK_API_KEY",
    );
    config.model = "openrouter/";
    await expect(new DshAdapter().createSession(config)).rejects.toThrow("requires a model ID");
    expect(await Bun.file(join(config.cwd, "invocation.json")).exists()).toBe(false);
  });

  test("fails closed when only npx is installed", async () => {
    const config = await fixture();
    await rename(join(config.cwd, "dsh"), join(config.cwd, "npx"));
    config.env = { ...config.env, DSH_BINARY: "", PATH: config.cwd };
    await expect(new DshAdapter().createSession(config)).rejects.toThrow(
      "dsh CLI not found. Install @deepseek-ai/dsh@0.1.7-alpha.2",
    );
    expect(await Bun.file(join(config.cwd, "invocation.json")).exists()).toBe(false);
  });

  test("uses a preinstalled dsh from PATH without DSH_BINARY", async () => {
    const config = await fixture();
    config.env = { ...config.env, DSH_BINARY: "", PATH: config.cwd };
    const session = await new DshAdapter().createSession(config);
    expect((await session.waitForCompletion()).isError).toBe(false);
    const invocation = await Bun.file(join(config.cwd, "invocation.json")).json();
    expect(invocation.args[0]).toBe("--profile");
  });

  test("does not fall back when an explicit DSH_BINARY is missing", async () => {
    const config = await fixture();
    config.env = { ...config.env, DSH_BINARY: join(config.cwd, "missing"), PATH: config.cwd };
    await expect(new DshAdapter().createSession(config)).rejects.toThrow();
    expect(await Bun.file(join(config.cwd, "invocation.json")).exists()).toBe(false);
  });

  for (const mode of ["failure", "missing-final", "malformed"]) {
    test(`reports ${mode} as failure even with output or exit zero`, async () => {
      const config = await fixture(mode);
      const session = await new DshAdapter().createSession(config);
      const events: ProviderEvent[] = [];
      session.onEvent((event) => events.push(event));
      const result = await session.waitForCompletion();
      expect(result.isError).toBe(true);
      expect(result.exitCode).toBe(mode === "failure" ? 7 : 1);
      expect(JSON.stringify({ result, events })).not.toContain(config.env!.DEEPSEEK_API_KEY);
      const invocation = await Bun.file(join(config.cwd, "invocation.json")).json();
      expect(await Bun.file(invocation.patchPath).exists()).toBe(false);
    });
  }

  test("abort terminates a running process and removes its patch", async () => {
    const config = await fixture("abort");
    const session = await new DshAdapter().createSession(config);
    await new Promise<void>((resolve) =>
      session.onEvent((event) => {
        if (event.type === "session_init") resolve();
      }),
    );
    await session.abort();
    expect(await session.waitForCompletion()).toMatchObject({
      isError: true,
      failureReason: "dsh session aborted",
    });
    const invocation = await Bun.file(join(config.cwd, "invocation.json")).json();
    expect(await Bun.file(invocation.patchPath).exists()).toBe(false);
  });
});
