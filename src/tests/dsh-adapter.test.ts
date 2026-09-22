import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProviderCredentials } from "../commands/provider-credentials";
import { createProviderAdapter } from "../providers";
import { checkDshCredentials, DshAdapter } from "../providers/dsh-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import { resolveHarnessProvider } from "../utils/harness-provider";

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
    env: { DSH_BINARY: binary, DEEPSEEK_API_KEY: "dsh-test-credential-value", DSH_TEST_MODE: mode },
  };
}

describe("dsh harness", () => {
  test("registry, model defaults, and credential dispatch select dsh", async () => {
    expect(await createProviderAdapter("dsh")).toBeInstanceOf(DshAdapter);
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "dsh" }, {})).toBe("dsh");
    expect(DEFAULT_MODEL_TIER_MAP.dsh.regular).toBe("deepseek-flash");
    expect(checkDshCredentials({ OPENAI_API_KEY: "unrelated" }).ready).toBe(false);
    expect(checkDshCredentials({ DEEPSEEK_API_KEY: " " }).ready).toBe(false);
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
    expect(invocation.cwd).toBe(config.cwd);
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

  test("uses the pinned npx package when no dsh binary is installed", async () => {
    const config = await fixture();
    await rename(join(config.cwd, "dsh"), join(config.cwd, "npx"));
    config.env = { ...config.env, DSH_BINARY: "", PATH: config.cwd };
    const session = await new DshAdapter().createSession(config);
    expect((await session.waitForCompletion()).isError).toBe(false);
    const invocation = await Bun.file(join(config.cwd, "invocation.json")).json();
    expect(invocation.args.slice(0, 2)).toEqual(["--yes", "@deepseek-ai/dsh@0.1.7-alpha.2"]);
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
