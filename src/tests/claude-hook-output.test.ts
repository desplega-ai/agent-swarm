/**
 * Claude Code hook stdout contract.
 *
 * Claude Code parses hook stdout as JSON only when the whole stdout is one
 * JSON object. A plain status line before a block made the block land as
 * text, and the tool call ran anyway. Plain stdout on PreToolUse/PostToolUse
 * never reaches the model, so nudges on those events must be JSON
 * `additionalContext`.
 *
 * Each test runs the real hook as a subprocess against a fake API.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const SERVER_NAME = pkg.config?.name ?? "agent-swarm";
const HOOK_PATH = join(import.meta.dir, "..", "hooks", "hook.ts");

type FakeState = {
  isLead: boolean;
  cancelledTaskId: string | null;
  shouldBlockPolling: boolean;
  /** When set, the fake API reports native extensions and answers each tool hook with this. */
  nativeDecision: Record<string, unknown> | null;
};

const state: FakeState = {
  isLead: false,
  cancelledTaskId: null,
  shouldBlockPolling: false,
  nativeDecision: null,
};
let server: ReturnType<typeof Bun.serve>;
let projectDir: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/me") {
        return Response.json({
          id: "00000000-0000-4000-8000-000000000001",
          name: "probe",
          isLead: state.isLead,
          status: "busy",
          shouldBlockPolling: state.shouldBlockPolling,
          inbox: {
            unreadCount: 2,
            mentionsCount: 0,
            offeredTasksCount: 1,
            poolTasksCount: 0,
            inProgressCount: 1,
            recentMentions: [],
          },
        });
      }
      if (url.pathname === "/cancelled-tasks") {
        const cancelled = state.cancelledTaskId
          ? [{ id: state.cancelledTaskId, task: "t", failureReason: "stop now" }]
          : [];
        return Response.json({ cancelled });
      }
      if (url.pathname === "/api/tool-hooks/status") {
        return Response.json({ native: state.nativeDecision !== null });
      }
      if (url.pathname === "/api/tool-hooks") {
        return Response.json(state.nativeDecision ?? { action: "continue" });
      }
      return Response.json({ ok: true });
    },
  });
  projectDir = await mkdtemp(join(tmpdir(), "claude-hook-output-"));
  await Bun.write(
    join(projectDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          url: `http://127.0.0.1:${server.port}/mcp`,
          headers: {
            Authorization: "Bearer test",
            "X-Agent-ID": "00000000-0000-4000-8000-000000000001",
          },
        },
      },
    }),
  );
});

afterAll(async () => {
  server.stop(true);
  await rm(projectDir, { recursive: true, force: true });
});

async function runHook(
  event: Record<string, unknown>,
  taskId: string,
  extraEnv: Record<string, string> = {},
) {
  const taskFile = join(projectDir, `task-${taskId}.json`);
  await Bun.write(
    taskFile,
    JSON.stringify({ taskId, agentId: "a", startedAt: new Date().toISOString() }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    TASK_FILE: taskFile,
    CONTEXT_BOUND_NOTE_TOKENS: undefined,
    ...extraEnv,
  };
  return runChild(["bun", HOOK_PATH], {
    cwd: projectDir,
    env,
    stdin: JSON.stringify({ cwd: projectDir, ...event }),
  });
}

/** Assert stdout is exactly one JSON object and return it. */
function parseSoleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.split("\n")).toHaveLength(1);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

/** The note is off unless CONTEXT_BOUND_NOTE_TOKENS is set. */
const noteOn = { CONTEXT_BOUND_NOTE_TOKENS: "200000" };

const bashTouch = {
  tool_name: "Bash",
  tool_input: { command: "touch /tmp/probe" },
};

describe("claude hook stdout", () => {
  afterEach(() => {
    state.nativeDecision = null;
  });

  test(
    "blocked PreToolUse prints exactly one deny JSON object",
    async () => {
      const taskId = crypto.randomUUID();
      Object.assign(state, { isLead: false, cancelledTaskId: taskId, shouldBlockPolling: false });
      const result = await runHook({ hook_event_name: "PreToolUse", ...bashTouch }, taskId);
      expect(result.exitCode).toBe(0);
      const out = parseSoleJson(result.stdout) as {
        hookSpecificOutput: Record<string, string>;
      };
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("TASK CANCELLED");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "blocked UserPromptSubmit prints only the block JSON, no status line",
    async () => {
      const taskId = crypto.randomUUID();
      Object.assign(state, { isLead: false, cancelledTaskId: taskId, shouldBlockPolling: false });
      const result = await runHook({ hook_event_name: "UserPromptSubmit", prompt: "go" }, taskId);
      expect(result.exitCode).toBe(0);
      const out = parseSoleJson(result.stdout);
      expect(out.decision).toBe("block");
      expect(String(out.reason)).toContain("TASK CANCELLED");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "UserPromptSubmit without a block still prints the status line and tray",
    async () => {
      Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
      const result = await runHook(
        { hook_event_name: "UserPromptSubmit", prompt: "go" },
        crypto.randomUUID(),
      );
      expect(result.stdout).toContain('You are registered as worker agent "probe"');
      expect(result.stdout).toContain("📬 2 unread");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "unblocked PreToolUse prints nothing on stdout",
    async () => {
      Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
      const result = await runHook(
        { hook_event_name: "PreToolUse", ...bashTouch },
        crypto.randomUUID(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "polling limit blocks poll-task with one deny JSON object",
    async () => {
      Object.assign(state, { isLead: true, cancelledTaskId: null, shouldBlockPolling: true });
      const result = await runHook(
        { hook_event_name: "PreToolUse", tool_name: "mcp__agent-swarm__poll-task", tool_input: {} },
        crypto.randomUUID(),
      );
      const out = parseSoleJson(result.stdout) as {
        hookSpecificOutput: Record<string, string>;
      };
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("POLLING LIMIT");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "loop warning reaches the model as PreToolUse additionalContext",
    async () => {
      Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
      const taskId = crypto.randomUUID();
      let stdout = "";
      try {
        for (let i = 0; i < 14 && stdout.trim() === ""; i++) {
          stdout = (await runHook({ hook_event_name: "PreToolUse", ...bashTouch }, taskId)).stdout;
        }
      } finally {
        await rm(`/tmp/agent-swarm-tool-history/${taskId}.json`, { force: true });
      }
      const out = parseSoleJson(stdout) as { hookSpecificOutput: Record<string, string> };
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.additionalContext).toStartWith("Warning: ");
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 3,
  );

  test(
    "lead send-task reminder reaches the model as PostToolUse additionalContext",
    async () => {
      Object.assign(state, { isLead: true, cancelledTaskId: null, shouldBlockPolling: false });
      const result = await runHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "mcp__agent-swarm__send-task",
          tool_input: {},
          tool_response: { task: { id: "task-123" } },
        },
        crypto.randomUUID(),
      );
      const out = parseSoleJson(result.stdout) as {
        hookSpecificOutput: Record<string, string>;
      };
      expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(out.hookSpecificOutput.additionalContext).toContain("Task ID: task-123.");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "worker context-bound note fires once as PostToolUse additionalContext",
    async () => {
      Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
      const taskId = crypto.randomUUID();
      await Bun.write(
        join(projectDir, `task-${taskId}.json.context.json`),
        JSON.stringify({ contextTokens: 250_000, model: "claude-opus-5-5" }),
      );
      const event = { hook_event_name: "PostToolUse", ...bashTouch, tool_response: {} };

      const first = await runHook(event, taskId, noteOn);
      const out = parseSoleJson(first.stdout) as { hookSpecificOutput: Record<string, string> };
      expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(out.hookSpecificOutput.additionalContext).toStartWith(
        "Context is 250,000 tokens (25% of the 1,000,000-token window). Keep this task bounded",
      );

      const second = await runHook(event, taskId, noteOn);
      expect(second.exitCode).toBe(0);
      expect(second.stdout.trim()).toBe("");
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 2,
  );

  test(
    "a subagent tool call does not consume the context-bound note",
    async () => {
      Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
      const taskId = crypto.randomUUID();
      await Bun.write(
        join(projectDir, `task-${taskId}.json.context.json`),
        JSON.stringify({ contextTokens: 250_000, model: "made-up-model" }),
      );
      const event = { hook_event_name: "PostToolUse", ...bashTouch, tool_response: {} };

      const child = await runHook({ ...event, agent_id: "child" }, taskId, noteOn);
      expect(child.exitCode).toBe(0);
      expect(child.stdout.trim()).toBe("");

      // Unknown model: no window share rather than a percent of the 200k fallback.
      const main = await runHook(event, taskId, noteOn);
      const out = parseSoleJson(main.stdout) as { hookSpecificOutput: Record<string, string> };
      expect(out.hookSpecificOutput.additionalContext).toStartWith(
        "Context is 250,000 tokens. Keep this task bounded",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS * 2,
  );

  test(
    "the context-bound note is off when CONTEXT_BOUND_NOTE_TOKENS is unset",
    async () => {
      Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
      const taskId = crypto.randomUUID();
      await Bun.write(
        join(projectDir, `task-${taskId}.json.context.json`),
        JSON.stringify({ contextTokens: 900_000, model: "claude-opus-5-5" }),
      );
      const result = await runHook(
        { hook_event_name: "PostToolUse", ...bashTouch, tool_response: {} },
        taskId,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  describe("native rewrite of a Bash command", () => {
    const leaky = `gh pr create --repo desplega-ai/agent-swarm --title x --body 'taskId = ${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'`;
    const room = "gh pr create --repo desplega-ai/agent-swarm --title x --body hello";
    const rewriteTo = (command: string) => {
      state.nativeDecision = { action: "modify", args: { command } };
    };
    /** A fresh TMPDIR keeps the 30 s status cache from leaking between tests. */
    const runRewrite = async (extraEnv: Record<string, string> = {}) => {
      const tmp = await mkdtemp(join(tmpdir(), "claude-hook-native-"));
      try {
        return await runHook(
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "echo safe" },
          },
          crypto.randomUUID(),
          { TMPDIR: tmp, ...extraEnv },
        );
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    };

    test(
      "a rewrite into a leaking gh pr body is blocked, not emitted",
      async () => {
        rewriteTo(leaky);
        const result = await runRewrite();
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("PR body leak check");
        expect(result.stdout.trim()).toBe("");
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );

    test(
      "a rewrite into a gh pr create with no PR room is blocked, not emitted",
      async () => {
        rewriteTo(room);
        const result = await runRewrite({ PR_ROOM_REPOS: "desplega-ai/agent-swarm" });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("PR rooms");
        expect(result.stdout.trim()).toBe("");
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );

    test(
      "a safe rewrite is emitted as one updatedInput object",
      async () => {
        rewriteTo("echo rewritten");
        const result = await runRewrite({ PR_ROOM_REPOS: "desplega-ai/agent-swarm" });
        expect(result.exitCode).toBe(0);
        const out = parseSoleJson(result.stdout) as {
          hookSpecificOutput: { updatedInput: { command: string } };
        };
        expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "echo rewritten" });
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );

    test(
      "a safe rewrite keeps the loop warning in the same single object",
      async () => {
        rewriteTo("echo rewritten");
        Object.assign(state, { isLead: false, cancelledTaskId: null, shouldBlockPolling: false });
        const taskId = crypto.randomUUID();
        const tmp = await mkdtemp(join(tmpdir(), "claude-hook-native-"));
        let out: { hookSpecificOutput: Record<string, unknown> } | undefined;
        try {
          for (let i = 0; i < 14 && !out?.hookSpecificOutput.additionalContext; i++) {
            const result = await runHook({ hook_event_name: "PreToolUse", ...bashTouch }, taskId, {
              TMPDIR: tmp,
            });
            out = parseSoleJson(result.stdout) as typeof out;
          }
        } finally {
          await rm(`/tmp/agent-swarm-tool-history/${taskId}.json`, { force: true });
          await rm(tmp, { recursive: true, force: true });
        }
        expect(out?.hookSpecificOutput.updatedInput).toEqual({ command: "echo rewritten" });
        expect(out?.hookSpecificOutput.additionalContext).toStartWith("Warning: ");
      },
      CHILD_PROCESS_TEST_BUDGET_MS * 3,
    );
  });
});
