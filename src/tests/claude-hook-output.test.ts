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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
};

const state: FakeState = { isLead: false, cancelledTaskId: null, shouldBlockPolling: false };
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

async function runHook(event: Record<string, unknown>, taskId: string) {
  const taskFile = join(projectDir, `task-${taskId}.json`);
  await Bun.write(
    taskFile,
    JSON.stringify({ taskId, agentId: "a", startedAt: new Date().toISOString() }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    TASK_FILE: taskFile,
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

const bashTouch = {
  tool_name: "Bash",
  tool_input: { command: "touch /tmp/probe" },
};

describe("claude hook stdout", () => {
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
});
