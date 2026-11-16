import { beforeEach, describe, expect, test } from "bun:test";
import { codexNativePre } from "../hooks/codex-hook";
import {
  canonicalArgs,
  canonicalToolName,
  type NativeCall,
  nativeHooksActive,
  rawArgsFromCanonical,
  resetNativeHookCache,
  runNativePost,
  runNativePre,
} from "../hooks/native-tool-hooks";

const call: NativeCall = {
  harness: "pi",
  tool: "bash",
  nativeTool: "bash",
  args: { command: "echo hi" },
  rawArgs: { command: "echo hi" },
};

function target(agent: string) {
  return { apiUrl: `http://api.test`, headers: { "X-Agent-ID": agent } };
}

/** A fetch that answers the status read and the hook POST, and records each request. */
function fakeApi(opts: { native: boolean; hook?: () => Response }) {
  const seen: { url: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/status")) return Response.json({ native: opts.native });
    return opts.hook?.() ?? Response.json({ action: "continue" });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("native tool hook shim", () => {
  beforeEach(() => resetNativeHookCache());

  test("no native extension: one cached status read, no hook request", async () => {
    const api = fakeApi({ native: false });
    const t = target(`a-${crypto.randomUUID()}`);
    expect((await runNativePre(t, call, api.fetchImpl)).action).toBe("continue");
    await runNativePre(t, call, api.fetchImpl);
    await runNativePost(t, call, { result: "x", durationMs: 1 }, api.fetchImpl);
    expect(api.seen.map((r) => r.url)).toEqual(["http://api.test/api/tool-hooks/status"]);
  });

  test("a failed status read is cached briefly, so a dead API costs one attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const t = target(`a-${crypto.randomUUID()}`);
    expect(await nativeHooksActive(t, fetchImpl)).toBe(false);
    expect(await nativeHooksActive(t, fetchImpl)).toBe(false);
    expect(calls).toBe(1);
  });

  test("the status answer expires", async () => {
    const api = fakeApi({ native: true });
    const t = target(`a-${crypto.randomUUID()}`);
    let now = 1_000_000;
    await nativeHooksActive(t, api.fetchImpl, () => now);
    now += 29_000;
    await nativeHooksActive(t, api.fetchImpl, () => now);
    expect(api.seen).toHaveLength(1);
    now += 2_000;
    await nativeHooksActive(t, api.fetchImpl, () => now);
    expect(api.seen).toHaveLength(2);
  });

  test("block and modify come back; a secret leaves the process scrubbed", async () => {
    const secret = `ghp_${"aB3dE6".repeat(6)}`;
    const blocking = fakeApi({
      native: true,
      hook: () => Response.json({ action: "block", reason: "no" }),
    });
    const t = target(`a-${crypto.randomUUID()}`);
    const withSecret = { ...call, args: { command: `echo ${secret}` } };
    expect(await runNativePre(t, withSecret, blocking.fetchImpl)).toEqual({
      action: "block",
      reason: "no",
    });
    const sent = JSON.stringify(blocking.seen.at(-1)?.body);
    expect(sent).not.toContain(secret);
    expect(sent).toContain("[REDACTED:");

    resetNativeHookCache();
    const rewriting = fakeApi({
      native: true,
      hook: () => Response.json({ action: "modify", args: { command: "echo ok" } }),
    });
    expect(
      await runNativePre(target(`b-${crypto.randomUUID()}`), call, rewriting.fetchImpl),
    ).toEqual({ action: "modify", args: { command: "echo ok" } });
  });

  test("non-2xx, a bad body and a thrown fetch all continue", async () => {
    for (const hook of [
      () => new Response("boom", { status: 500 }),
      () => Response.json({ action: "block" }),
      () => Response.json({ action: "modify", args: "not-an-object" }),
      () => {
        throw new Error("network down");
      },
    ]) {
      resetNativeHookCache();
      const api = fakeApi({ native: true, hook });
      const decision = await runNativePre(target(`c-${crypto.randomUUID()}`), call, api.fetchImpl);
      expect(decision.action).toBe("continue");
    }
  });

  test("canonical names and args round-trip Claude's file_path", () => {
    expect(canonicalToolName("Bash")).toBe("bash");
    expect(canonicalToolName("shell")).toBe("bash");
    expect(canonicalToolName("MultiEdit")).toBe("edit");
    expect(canonicalToolName("WebFetch")).toBe("webfetch");
    const raw = { file_path: "/a", content: "x" };
    const args = canonicalArgs(raw);
    expect(args).toEqual({ path: "/a", content: "x" });
    expect(rawArgsFromCanonical({ ...args, path: "/b" }, raw)).toEqual({
      file_path: "/b",
      content: "x",
    });
    // pi and opencode already say `path`: nothing to map back.
    expect(rawArgsFromCanonical({ path: "/b" }, { path: "/a" })).toEqual({ path: "/b" });
  });

  describe("codex rewrite of a Bash command runs the PR guards on the final command", () => {
    const config = { apiUrl: "http://api.test", apiKey: "k", agentId: "a" };
    const msg = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo safe" },
      cwd: "/w",
    };
    const leaky = `gh pr create --repo desplega-ai/agent-swarm --title x --body 'taskId = ${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'`;
    const guardDeps = {
      env: {},
      readFile: async () => "",
      repoVisibility: async () => "PUBLIC",
    };
    const roomDeps = {
      env: { PR_ROOM_REPOS: "desplega-ai/agent-swarm" },
      readFile: async () => "",
      remoteOrigin: async () => "https://github.com/desplega-ai/agent-swarm.git",
    };
    const rewriteApi = (command: string) =>
      fakeApi({
        native: true,
        hook: () => Response.json({ action: "modify", args: { command } }),
      }).fetchImpl;
    const run = (command: string) =>
      codexNativePre(
        { ...msg, tool_use_id: `t-${crypto.randomUUID()}` },
        { ...config, agentId: `a-${crypto.randomUUID()}` },
        rewriteApi(command),
        guardDeps,
        roomDeps,
      );

    test("a rewrite into a leaking gh pr body is blocked", async () => {
      const decision = await run(leaky);
      expect(decision.action).toBe("block");
      expect((decision as { reason: string }).reason).toContain("PR body leak check");
    });

    test("a rewrite into a gh pr create with no PR room is blocked", async () => {
      const decision = await run(
        "gh pr create --repo desplega-ai/agent-swarm --title x --body hello",
      );
      expect(decision.action).toBe("block");
      expect((decision as { reason: string }).reason).toContain("PR rooms");
    });

    test("a safe rewrite is still emitted as updatedInput", async () => {
      const decision = await run("echo rewritten");
      expect(decision.action).toBe("modify");
      const out = (decision as { output: { hookSpecificOutput: { updatedInput: unknown } } })
        .output;
      expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "echo rewritten" });
    });
  });
});
