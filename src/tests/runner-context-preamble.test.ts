import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  buildContextPreamble,
  buildResumeContextPreamble,
  CONTEXT_PREAMBLE_MAX_CHARS,
  CONTEXT_PREAMBLE_MAX_TOKENS,
  fetchTaskContextForPreamble,
  prependContextPreamble,
  type TaskContextForPreamble,
} from "../commands/context-preamble";
import { listenOnFreePort } from "./test-net";

let API_URL = "";
const API_KEY = "example-test-key";

// In-memory task store for the mock server
const mockTasks: Record<string, TaskContextForPreamble> = {};
// Session-log rows served by /api/tasks/:id/session-logs
const mockSessionLogs: Record<string, { createdAt: string; content: string }[]> = {};

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const logsMatch = url.match(/^\/api\/tasks\/([^/?]+)\/session-logs/);
    if (logsMatch) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: mockSessionLogs[logsMatch[1]] ?? [] }));
      return;
    }
    const match = url.match(/^\/api\/tasks\/([^/?]+)/);
    if (match) {
      const id = match[1];
      const task = mockTasks[id];
      if (task) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(task));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listenOnFreePort(server);
  API_URL = `http://localhost:${port}`;
});

afterAll(() => {
  server.close();
  // Clear mocks
  for (const k of Object.keys(mockTasks)) delete mockTasks[k];
});

function seedTask(task: TaskContextForPreamble): void {
  mockTasks[task.id] = task;
}

describe("prependContextPreamble", () => {
  const preamble = "\n---\n## Prior Conversation Context\nParent task evidence\n\n";

  test.each([
    "/work-on-task",
    "/skill:work-on-task",
    "/review-offered-task",
  ])("preserves the leading %s invocation and the full task body", (command) => {
    const prompt = `${command} task-id\n\nTask: follow up\nAttachments: artifact\n`;
    expect(prependContextPreamble(prompt, preamble)).toBe(
      `${command} task-id\n${preamble}\nTask: follow up\nAttachments: artifact\n`,
    );
  });

  test("preserves a command-only prompt and leaves empty context unchanged", () => {
    expect(prependContextPreamble("/work-on-task task-id", preamble)).toBe(
      `/work-on-task task-id\n${preamble}`,
    );
    expect(prependContextPreamble("/work-on-task task-id\n\nTask", "")).toBe(
      "/work-on-task task-id\n\nTask",
    );
  });

  test("prepends context normally when there is no leading skill", () => {
    const prompt = "Continue the task\n/work-on-task is quoted here";
    expect(prependContextPreamble(prompt, preamble)).toBe(preamble + prompt);
  });
});

describe("fetchTaskContextForPreamble", () => {
  test("returns null on 404", async () => {
    const result = await fetchTaskContextForPreamble(API_URL, API_KEY, "missing-id");
    expect(result).toBeNull();
  });

  test("fetches task context fields", async () => {
    await seedTask({
      id: "task-a",
      task: "Build the widget",
      output: "Widget built successfully",
      status: "completed",
      attachments: [{ kind: "url", name: "Report", url: "https://example.com/report" }],
    });

    const result = await fetchTaskContextForPreamble(API_URL, API_KEY, "task-a");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("task-a");
    expect(result?.task).toBe("Build the widget");
    expect(result?.output).toBe("Widget built successfully");
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("Report");
  });
});

describe("buildContextPreamble", () => {
  test("returns null when parent task not found", async () => {
    const result = await buildContextPreamble(API_URL, API_KEY, "nonexistent-parent");
    expect(result).toBeNull();
  });

  test("includes parent task subject and output in preamble", async () => {
    await seedTask({
      id: "parent-1",
      task: "Fix the auth bug in login flow",
      output: "Fixed by patching jwt validation in auth.ts:42",
      status: "completed",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-1");
    expect(preamble).not.toBeNull();
    expect(preamble).toContain("parent-1");
    expect(preamble).toContain("Fix the auth bug in login flow");
    expect(preamble).toContain("Fixed by patching jwt validation");
    expect(preamble).toContain("get-task-details");
    expect(preamble).toContain("Prior Conversation Context");
  });

  test("includes attachment pointers in preamble", async () => {
    await seedTask({
      id: "parent-2",
      task: "Generate a report",
      output: "Report generated",
      status: "completed",
      attachments: [
        { kind: "url", name: "Final Report", url: "https://example.com/report.pdf" },
        {
          kind: "agent-fs",
          name: "Raw Data",
          path: "thoughts/agent/research/data.md",
          orgId: "org-123",
          driveId: "drv-456",
        },
      ],
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-2");
    expect(preamble).toContain("Final Report");
    expect(preamble).toContain("https://example.com/report.pdf");
    expect(preamble).toContain("Raw Data");
    expect(preamble).toContain("live.agent-fs.dev");
    expect(preamble).toContain("org-123");
    expect(preamble).toContain("drv-456");
  });

  test("shows 'no output recorded' when task has no output or progress", async () => {
    await seedTask({
      id: "parent-no-output",
      task: "A task with no output yet",
      status: "in_progress",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-no-output");
    expect(preamble).toContain("no output recorded");
  });

  test("walks ancestor chain and includes older ancestors as pointers", async () => {
    await seedTask({
      id: "grandparent-1",
      task: "Initial research task",
      output: "Research complete",
      status: "completed",
    });
    await seedTask({
      id: "child-of-grandparent",
      task: "Second task referencing research",
      output: "Second task done",
      status: "completed",
      parentTaskId: "grandparent-1",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "child-of-grandparent");
    expect(preamble).not.toBeNull();
    // Immediate parent (child-of-grandparent) gets inline detail
    expect(preamble).toContain("child-of-grandparent");
    expect(preamble).toContain("Second task done");
    // Grandparent gets pointer-only entry
    expect(preamble).toContain("grandparent-1");
    expect(preamble).toContain("Older Ancestor Tasks");
    expect(preamble).toContain("Initial research task");
  });

  test("enforces token budget — truncates oversized output", async () => {
    // Generate output that exceeds the budget
    const hugeOutput = "x".repeat(CONTEXT_PREAMBLE_MAX_CHARS + 5000);
    await seedTask({
      id: "parent-big",
      task: "Task with very large output",
      output: hugeOutput,
      status: "completed",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-big");
    expect(preamble).not.toBeNull();
    // Preamble must be within budget (some slack for the truncation suffix)
    expect(preamble?.length ?? 0).toBeLessThanOrEqual(
      CONTEXT_PREAMBLE_MAX_CHARS + 300, // 300 chars slack for the truncation message
    );
  });

  test("preamble starts with context section and ends with separator", async () => {
    await seedTask({
      id: "parent-structure",
      task: "A well-structured task",
      output: "Done",
      status: "completed",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-structure");
    expect(preamble).toContain("---");
    expect(preamble).toContain("Prior Conversation Context");
    // Should end with trailing separator
    expect(preamble?.trimEnd()).toMatch(/---\s*$/);
  });

  test("CONTEXT_PREAMBLE_MAX_TOKENS is 2000 by default", () => {
    expect(CONTEXT_PREAMBLE_MAX_TOKENS).toBe(2000);
    expect(CONTEXT_PREAMBLE_MAX_CHARS).toBe(8000);
  });
});

describe("buildResumeContextPreamble interrupted tool call", () => {
  const TASK_ID = "resume-parent";
  let seq = 0;

  function logLine(content: unknown) {
    seq += 1;
    return {
      createdAt: `2026-11-03T10:00:${String(seq).padStart(2, "0")}.000Z`,
      content: JSON.stringify(content),
    };
  }
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    logLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
  const toolResult = (id: string) =>
    logLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });

  async function preambleFor(logs: { createdAt: string; content: string }[]) {
    seedTask({ id: TASK_ID, task: "Ship the fix", status: "failed" });
    mockSessionLogs[TASK_ID] = logs;
    const preamble = await buildResumeContextPreamble(API_URL, API_KEY, TASK_ID);
    expect(preamble).toBeTruthy();
    return preamble ?? "";
  }

  test("flags an unpaired last call before the task description", async () => {
    const preamble = await preambleFor([
      toolUse("toolu_1", "Bash", { command: "bun run check:local" }),
      toolResult("toolu_1"),
      toolUse("toolu_2", "Bash", { command: "git push origin fix/x" }),
    ]);
    const line =
      "Interrupted: Bash git push origin fix/x may have landed. Check its effect before calling it again.";
    expect(preamble).toContain(line);
    expect(preamble.indexOf(line)).toBeGreaterThan(
      preamble.indexOf("## Resuming Interrupted Task"),
    );
    expect(preamble.indexOf(line)).toBeLessThan(preamble.indexOf("### Original Task Description"));
  });

  test("does not flag a call that got its result", async () => {
    const preamble = await preambleFor([
      toolUse("toolu_1", "Bash", { command: "git push origin fix/x" }),
      toolResult("toolu_1"),
    ]);
    expect(preamble).not.toContain("Interrupted:");
  });

  test("does not flag an unpaired read-only call", async () => {
    const preamble = await preambleFor([
      toolUse("toolu_1", "Bash", { command: "git push origin fix/x" }),
      toolResult("toolu_1"),
      toolUse("toolu_2", "Read", { file_path: "/workspace/src/a.ts" }),
    ]);
    expect(preamble).not.toContain("Interrupted:");
  });

  // One row shape per harness, copied from real session_logs rows (scrubbed;
  // claude-managed from its adapter, which has no stored rows yet). Each case
  // lists the unanswered call's rows and the row that answers it.
  const raw = (content: unknown) => logLine(content);
  const harnessCases: {
    harness: string;
    call: ReturnType<typeof logLine>[];
    answer: ReturnType<typeof logLine>;
    expected: string;
  }[] = [
    {
      harness: "pi",
      call: [
        raw({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_00_ET_abc",
                name: "bash",
                input: { command: "git push origin fix/x" },
              },
            ],
          },
        }),
      ],
      answer: raw({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "call_00_ET_abc", content: "ok" }],
        },
      }),
      expected: "bash git push origin fix/x",
    },
    {
      harness: "amp",
      call: [
        raw({
          type: "assistant",
          message: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "TU-034ap7w",
                name: "shell_command",
                input: { command: "gh pr comment 1 --body hi" },
              },
            ],
          },
        }),
      ],
      answer: raw({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "TU-034ap7w", content: "ok" }],
        },
        parent_tool_use_id: null,
      }),
      expected: "shell_command gh pr comment 1 --body hi",
    },
    {
      harness: "codex",
      call: [
        raw({
          type: "item.started",
          item: {
            id: "exec-9b08ea05",
            type: "command_execution",
            command: "/bin/bash -lc 'git push origin fix/x'",
            aggregated_output: null,
            exit_code: null,
            status: "inProgress",
          },
        }),
      ],
      answer: raw({
        type: "item.completed",
        item: {
          id: "exec-9b08ea05",
          type: "command_execution",
          command: "/bin/bash -lc 'git push origin fix/x'",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
      }),
      expected: "bash /bin/bash -lc 'git push origin fix/x'",
    },
    {
      harness: "codex mcp",
      call: [
        raw({
          type: "item.started",
          item: {
            id: "exec-26e02993",
            type: "mcp_tool_call",
            server: "agent-swarm",
            tool: "send-task",
            arguments: { task: "ship it" },
            status: "inProgress",
            result: null,
            error: null,
          },
        }),
      ],
      answer: raw({
        type: "item.completed",
        item: {
          id: "exec-26e02993",
          type: "mcp_tool_call",
          server: "agent-swarm",
          tool: "send-task",
          arguments: { task: "ship it" },
          status: "completed",
          result: { content: [] },
          error: null,
        },
      }),
      expected: 'agent-swarm.send-task {"task":"ship it"}',
    },
    {
      harness: "opencode",
      call: [
        raw({
          type: "tool_start",
          toolCallId: "call_1f8a83e2",
          toolName: "shell",
          args: { command: "git push origin fix/x" },
        }),
      ],
      answer: raw({
        type: "tool_end",
        toolCallId: "call_1f8a83e2",
        toolName: "shell",
        result: "ok",
      }),
      expected: "shell git push origin fix/x",
    },
    {
      // grok and fx run through the same ACP adapter and store the same rows.
      harness: "acp",
      call: [
        raw({
          sessionId: "ses_f4fc",
          update: {
            toolCallId: "call_7d2aa750",
            title: "bash",
            kind: "execute",
            status: "pending",
            rawInput: { cwd: "/workspace" },
            sessionUpdate: "tool_call",
          },
        }),
        raw({
          type: "tool_start",
          toolCallId: "call_7d2aa750",
          toolName: "bash",
          args: { cwd: "/workspace" },
        }),
        raw({
          sessionId: "ses_f4fc",
          update: {
            toolCallId: "call_7d2aa750",
            kind: "execute",
            status: "in_progress",
            title: "git push origin fix/x",
            rawInput: { command: "git push origin fix/x", cwd: "/workspace" },
            sessionUpdate: "tool_call_update",
          },
        }),
      ],
      answer: raw({
        type: "tool_end",
        toolCallId: "call_7d2aa750",
        toolName: "git push origin fix/x",
        result: { status: "completed", content: [] },
      }),
      expected: "bash git push origin fix/x",
    },
    {
      harness: "claude-managed",
      call: [
        raw({
          type: "agent.tool_use",
          id: "sevt_tool_1",
          name: "bash",
          input: { command: "git push origin fix/x" },
        }),
      ],
      answer: raw({
        type: "agent.tool_result",
        id: "sevt_res_1",
        tool_use_id: "sevt_tool_1",
        content: [],
        is_error: false,
      }),
      expected: "bash git push origin fix/x",
    },
    {
      harness: "claude-managed mcp",
      call: [
        raw({
          type: "agent.mcp_tool_use",
          id: "sevt_mcp_1",
          mcp_server_name: "agent-swarm",
          name: "send-task",
          input: { task: "ship it" },
        }),
      ],
      answer: raw({
        type: "agent.mcp_tool_result",
        id: "sevt_res_2",
        mcp_tool_use_id: "sevt_mcp_1",
        content: [],
        is_error: false,
      }),
      expected: 'agent-swarm.send-task {"task":"ship it"}',
    },
    {
      harness: "cursor",
      call: [
        raw({
          type: "tool_call",
          agent_id: "agent-883d",
          run_id: "run-d9ad",
          call_id: "toolu_0199Lz",
          name: "mcp",
          status: "running",
          args: {
            providerIdentifier: "agent-swarm",
            toolName: "send-task",
            args: { task: "ship it" },
          },
        }),
      ],
      answer: raw({
        type: "tool_call",
        agent_id: "agent-883d",
        run_id: "run-d9ad",
        call_id: "toolu_0199Lz",
        name: "mcp",
        status: "completed",
        result: { status: "success", value: { content: [] } },
      }),
      expected: 'mcp__agent-swarm__send-task {"task":"ship it"}',
    },
    {
      harness: "dsh",
      call: [
        raw({
          type: "tool_call",
          callId: "call_cbebc13a",
          tool: "bash",
          input: { command: "git push origin fix/x" },
        }),
      ],
      answer: raw({
        type: "tool_result",
        callId: "call_cbebc13a",
        status: "completed",
        result: "ok",
      }),
      expected: "bash git push origin fix/x",
    },
  ];

  for (const c of harnessCases) {
    test(`${c.harness}: flags an unanswered call`, async () => {
      const preamble = await preambleFor(c.call);
      expect(preamble).toContain(
        `Interrupted: ${c.expected} may have landed. Check its effect before calling it again.`,
      );
    });

    test(`${c.harness}: does not flag an answered call`, async () => {
      const preamble = await preambleFor([...c.call, c.answer]);
      expect(preamble).not.toContain("Interrupted:");
    });
  }

  test("does not flag an unanswered lowercase read-only call (pi, opencode, acp)", async () => {
    const preamble = await preambleFor([
      toolUse("call_01_ET_read", "read", { path: "/workspace/a.ts" }),
    ]);
    expect(preamble).not.toContain("Interrupted:");
  });

  test("redacts a token in the interrupted call's args", async () => {
    const fakeToken = `ghp_${"a".repeat(36)}`;
    const preamble = await preambleFor([
      toolUse("toolu_1", "Bash", {
        command: `curl -H 'Authorization: token ${fakeToken}' https://api.github.com/x`,
      }),
    ]);
    expect(preamble).toContain("Interrupted: Bash curl");
    expect(preamble).not.toContain(fakeToken);
  });
});
