import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  buildContextPreamble,
  buildResumeContextPreamble,
  buildSessionFollowUpPreamble,
  buildSessionTurnsPreamble,
  CONTEXT_PREAMBLE_MAX_CHARS,
  CONTEXT_PREAMBLE_MAX_TOKENS,
  fetchTaskContextForPreamble,
  prependContextPreamble,
  SESSION_TURNS_MAX_CHARS,
  SESSION_TURNS_MAX_TURNS,
  type TaskContextForPreamble,
} from "../commands/context-preamble";
import { listenOnFreePort } from "./test-net";

let API_URL = "";
const API_KEY = "example-test-key";

// In-memory task store for the mock server
const mockTasks: Record<string, TaskContextForPreamble> = {};
// Session-log rows served by /api/tasks/:id/session-logs
const mockSessionLogs: Record<string, { createdAt: string; content: string }[]> = {};
// Open intent rows served by /api/tasks/:id/tool-intents
const mockToolIntents: Record<
  string,
  { toolCallId: string; toolName: string; argsSummary?: string; createdAt: string }[]
> = {};

let server: Server;
let lineageReads = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const logsMatch = url.match(/^\/api\/tasks\/([^/?]+)\/session-logs/);
    if (logsMatch) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ logs: mockSessionLogs[logsMatch[1]] ?? [] }));
      return;
    }
    const intentsMatch = url.match(/^\/api\/tasks\/([^/?]+)\/tool-intents/);
    if (intentsMatch) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ intents: mockToolIntents[intentsMatch[1]] ?? [] }));
      return;
    }
    // Mirrors GET /api/tasks/{id}/lineage: the path to the topmost of at most 50 ancestors.
    const lineageMatch = url.match(/^\/api\/tasks\/([^/?]+)\/lineage/);
    if (lineageMatch) {
      lineageReads++;
      let row = mockTasks[lineageMatch[1]];
      if (!row) {
        res.writeHead(404);
        res.end();
        return;
      }
      const tasks = [row];
      for (let hops = 0; hops < 50 && row.parentTaskId && mockTasks[row.parentTaskId]; hops++) {
        row = mockTasks[row.parentTaskId];
        tasks.push(row);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rootTaskId: row.id, tasks, truncated: false }));
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

describe("buildSessionTurnsPreamble", () => {
  // root (lead) -> worker child -> lead review -> ui follow-up (lead) -> message parent
  function seedSession(prefix: string): void {
    seedTask({
      id: `${prefix}-root`,
      task: "List the roadmap items for Q1",
      output: "Roadmap: auth rewrite, billing v2, board embeds",
      status: "completed",
      isLeadTask: true,
      agentId: "lead",
    });
    seedTask({
      id: `${prefix}-worker`,
      task: "Research defer-task wakeOn",
      status: "completed",
      isLeadTask: false,
      agentId: "worker",
      parentTaskId: `${prefix}-root`,
    });
    seedTask({
      id: `${prefix}-review`,
      task: "Worker task completed — review needed",
      output: "wakeOn works as documented",
      status: "completed",
      isLeadTask: true,
      agentId: "lead",
      parentTaskId: `${prefix}-worker`,
    });
    seedTask({
      id: `${prefix}-turn`,
      task: "make a board of the roadmap",
      output: "Board created",
      status: "completed",
      isLeadTask: true,
      agentId: "lead",
      parentTaskId: `${prefix}-review`,
      attachments: [{ kind: "url", name: "Roadmap board", url: "https://example.com/board" }],
    });
  }

  test("shows the original ask once on top, then the Lead turns oldest first", async () => {
    seedSession("st1");
    const preamble = await buildSessionTurnsPreamble(API_URL, API_KEY, "st1-turn");
    expect(preamble).not.toBeNull();
    const text = preamble ?? "";
    expect(text).toContain("## Prior Conversation Context");
    expect(text).toContain("your last 2 turns");
    expect(text).toContain("### Original ask (session root) (task `st1-root`, completed)");
    const root = text.indexOf("List the roadmap items for Q1");
    const review = text.indexOf("wakeOn works as documented");
    const turn = text.indexOf("make a board of the roadmap");
    expect(root).toBeGreaterThan(-1);
    expect(root).toBeLessThan(review);
    expect(review).toBeLessThan(turn);
    // Shown once, and nothing was skipped.
    expect(text.split("List the roadmap items for Q1").length).toBe(2);
    expect(text).not.toContain("earlier turn");
    expect(text).toContain("Roadmap: auth rewrite, billing v2, board embeds");
    expect(text).toContain("https://example.com/board");
    // The delegated worker task is not a turn.
    expect(text).not.toContain("Research defer-task wakeOn");
  });

  test("points at get-task-details and the task-context-gathering script", async () => {
    seedSession("st3");
    const text = (await buildSessionTurnsPreamble(API_URL, API_KEY, "st3-turn")) ?? "";
    expect(text).toContain("`get-task-details` with any task id above");
    expect(text).toContain('`name: "task-context-gathering"`, `scope: "global"`');
    expect(text).toContain('`args: { "taskId": "<id>", "queries": ["<topic>"] }`');
  });

  test("names the parent when the message was sent on another agent's task", async () => {
    seedSession("st2");
    const preamble = await buildSessionTurnsPreamble(API_URL, API_KEY, "st2-worker");
    expect(preamble).toContain("sent on task `st2-worker`, a task of another agent");
    expect(preamble).toContain("### Turn 1, session root (task `st2-root`, completed)");
    expect(preamble).not.toContain("Original ask (session root)");
    expect(preamble).toContain("your last 1 turns");
  });

  test("keeps the root and the last turns, and marks the turns between as skipped", async () => {
    let parent: string | undefined;
    const count = SESSION_TURNS_MAX_TURNS + 2;
    for (let i = 0; i < count; i++) {
      seedTask({
        id: `cap-${i}`,
        task: `ask number ${i}`,
        output: `answer number ${i}`,
        status: "completed",
        isLeadTask: true,
        agentId: "lead",
        parentTaskId: parent,
      });
      parent = `cap-${i}`;
    }
    const text = (await buildSessionTurnsPreamble(API_URL, API_KEY, `cap-${count - 1}`)) ?? "";
    expect(text).toContain(`your last ${SESSION_TURNS_MAX_TURNS} turns`);
    expect(text).toContain("### Original ask (session root) (task `cap-0`");
    expect(text).toContain("ask number 0");
    expect(text).toContain(`ask number ${count - 1}`);
    expect(text).toContain(`ask number ${count - SESSION_TURNS_MAX_TURNS}`);
    expect(text).not.toContain("ask number 1\n");
    expect(text).toContain("### … 1 earlier turn skipped");
    expect(text).toContain("newest first: `cap-1`.");
    const order = ["ask number 0", "earlier turn skipped", `ask number ${count - 1}`];
    const at = order.map((s) => text.indexOf(s));
    expect(at[0]).toBeLessThan(at[1]!);
    expect(at[1]).toBeLessThan(at[2]!);
  });

  test("finds the original ask past the hop walk and the 50-ancestor lineage cap", async () => {
    // long-0 is the root; odd tasks are delegated worker tasks, even ones Lead turns.
    const total = 120;
    for (let i = 0; i < total; i++) {
      const lead = i % 2 === 0;
      seedTask({
        id: `long-${i}`,
        task: i === 0 ? "Original ask: plan the Q1 launch" : `step ${i}`,
        output: `result ${i}`,
        status: "completed",
        isLeadTask: lead,
        agentId: lead ? "lead" : "worker",
        parentTaskId: i === 0 ? undefined : `long-${i - 1}`,
      });
    }
    lineageReads = 0;
    const text = (await buildSessionTurnsPreamble(API_URL, API_KEY, `long-${total - 1}`)) ?? "";
    expect(text).toContain("### Original ask (session root) (task `long-0`");
    expect(text).toContain("Original ask: plan the Q1 launch");
    // Shown turns: long-118 .. long-108. Skipped: the Lead turns long-106 .. long-2.
    expect(text).toContain("step 108");
    expect(text).not.toContain("step 106\n");
    expect(text).toContain("### … 53 earlier turns skipped");
    expect(text).toContain("newest first: `long-106`, `long-104`");
    expect(text).toContain(", and 45 more.");
    expect(text).toContain("task-context-gathering");
    expect(lineageReads).toBeGreaterThan(1);
  });

  test("drops the oldest of the last turns to fit the budget, never the root", async () => {
    const big = "x".repeat(4000);
    seedTask({
      id: "bud-0",
      task: "first ask",
      output: big,
      status: "completed",
      isLeadTask: true,
      agentId: "lead",
    });
    for (let i = 1; i < SESSION_TURNS_MAX_TURNS; i++) {
      seedTask({
        id: `bud-${i}`,
        task: `ask ${i} ${big}`,
        output: big,
        status: "completed",
        isLeadTask: true,
        agentId: "lead",
        parentTaskId: `bud-${i - 1}`,
      });
    }
    const last = SESSION_TURNS_MAX_TURNS - 1;
    const text = (await buildSessionTurnsPreamble(API_URL, API_KEY, `bud-${last}`)) ?? "";
    expect(text.length).toBeLessThanOrEqual(SESSION_TURNS_MAX_CHARS);
    expect(text).toContain("**Asked:** first ask");
    expect(text).toContain(`task \`bud-${last}\``);
    expect(text).toMatch(/### … \d+ earlier turns? skipped/);
    expect(text).toContain("newest first: `bud-");
    expect(text).not.toContain("[context preamble truncated");
  });

  test("returns null without a Lead turn, and the follow-up falls back", async () => {
    seedTask({ id: "w-only", task: "Worker-only parent task", status: "completed" });
    expect(await buildSessionTurnsPreamble(API_URL, API_KEY, "w-only")).toBeNull();
    const fallback = await buildSessionFollowUpPreamble(API_URL, API_KEY, "w-only");
    expect(fallback).toContain("### Immediate Prior Task (ID: `w-only`)");
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

  // Parallel batches: a later call can answer before an earlier one.
  const codexStart = (id: string, item: Record<string, unknown>) =>
    raw({ type: "item.started", item: { id, status: "inProgress", ...item } });
  const codexDone = (id: string, item: Record<string, unknown>) =>
    raw({ type: "item.completed", item: { id, status: "completed", ...item } });
  const parallelCases: {
    name: string;
    logs: () => ReturnType<typeof logLine>[];
    expected: string | null;
  }[] = [
    {
      name: "codex: start push, start search, complete search flags the push",
      logs: () => [
        codexStart("push", { type: "command_execution", command: "git push origin fix/x" }),
        codexStart("search", { type: "web_search", query: "bun test" }),
        codexDone("search", { type: "web_search", query: "bun test" }),
      ],
      expected: "bash git push origin fix/x",
    },
    {
      name: "codex: start push, start mcp comment, complete comment flags the push",
      logs: () => [
        codexStart("push", { type: "command_execution", command: "git push origin fix/x" }),
        codexStart("comment", {
          type: "mcp_tool_call",
          server: "agent-swarm",
          tool: "slack-reply",
          arguments: { text: "hi" },
        }),
        codexDone("comment", { type: "mcp_tool_call", server: "agent-swarm", tool: "slack-reply" }),
      ],
      expected: "bash git push origin fix/x",
    },
    {
      name: "codex: two open side-effecting calls are both flagged in start order",
      logs: () => [
        codexStart("push", { type: "command_execution", command: "git push origin fix/x" }),
        codexStart("comment", { type: "command_execution", command: "gh pr comment 1 --body hi" }),
      ],
      expected: "bash git push origin fix/x; bash gh pr comment 1 --body hi",
    },
    {
      name: "codex: a parallel batch answered out of order is not flagged",
      logs: () => [
        codexStart("push", { type: "command_execution", command: "git push origin fix/x" }),
        codexStart("search", { type: "web_search", query: "bun test" }),
        codexDone("search", { type: "web_search" }),
        codexDone("push", { type: "command_execution" }),
      ],
      expected: null,
    },
    {
      name: "claude: one message with two calls, only the second answered, flags the first",
      logs: () => [
        logLine({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "git push" } },
              { type: "tool_use", id: "toolu_b", name: "Grep", input: { pattern: "x" } },
            ],
          },
        }),
        toolResult("toolu_b"),
      ],
      expected: "Bash git push",
    },
    {
      name: "opencode: start push, start read, end read flags the push",
      logs: () => [
        raw({
          type: "tool_start",
          toolCallId: "c1",
          toolName: "shell",
          args: { command: "git push" },
        }),
        raw({ type: "tool_start", toolCallId: "c2", toolName: "read", args: { path: "/a.ts" } }),
        raw({ type: "tool_end", toolCallId: "c2", toolName: "read", result: "ok" }),
      ],
      expected: "shell git push",
    },
    {
      name: "claude-managed: use push, use mcp, mcp result flags the push",
      logs: () => [
        raw({ type: "agent.tool_use", id: "t1", name: "bash", input: { command: "git push" } }),
        raw({
          type: "agent.mcp_tool_use",
          id: "t2",
          mcp_server_name: "agent-swarm",
          name: "send-task",
          input: { task: "x" },
        }),
        raw({ type: "agent.mcp_tool_result", id: "r2", mcp_tool_use_id: "t2", content: [] }),
      ],
      expected: "bash git push",
    },
    {
      name: "dsh: call push, call read, read result flags the push",
      logs: () => [
        raw({ type: "tool_call", callId: "d1", tool: "bash", input: { command: "git push" } }),
        raw({ type: "tool_call", callId: "d2", tool: "read", input: { path: "/a.ts" } }),
        raw({ type: "tool_result", callId: "d2", status: "completed", result: "ok" }),
      ],
      expected: "bash git push",
    },
    {
      name: "cursor: repeated running rows on one call_id flag it once",
      logs: () => [
        raw({
          type: "tool_call",
          call_id: "k1",
          name: "shell",
          status: "running",
          args: { command: "git push" },
        }),
        raw({
          type: "tool_call",
          call_id: "k1",
          name: "shell",
          status: "running",
          args: { command: "git push" },
        }),
        raw({
          type: "tool_call",
          call_id: "k2",
          name: "read",
          status: "running",
          args: { path: "/a" },
        }),
        raw({ type: "tool_call", call_id: "k2", name: "read", status: "completed" }),
      ],
      expected: "shell git push",
    },
  ];

  for (const c of parallelCases) {
    test(c.name, async () => {
      const preamble = await preambleFor(c.logs());
      if (c.expected === null) expect(preamble).not.toContain("Interrupted:");
      else
        expect(preamble).toContain(
          `Interrupted: ${c.expected} may have landed. Check its effect before calling it again.`,
        );
    });
  }

  test("caps the flagged calls at the newest three", async () => {
    const preamble = await preambleFor(
      [1, 2, 3, 4].map((n) =>
        codexStart(`c${n}`, { type: "command_execution", command: `gh pr comment ${n}` }),
      ),
    );
    expect(preamble).toContain(
      "Interrupted: bash gh pr comment 2; bash gh pr comment 3; bash gh pr comment 4 may have landed.",
    );
  });

  test("does not flag an open call from an earlier resume attempt", async () => {
    seedTask({ id: "attempt-1", task: "Ship the fix", status: "failed" });
    seedTask({
      id: "attempt-2",
      task: "Resume interrupted task",
      status: "failed",
      taskType: "resume",
      parentTaskId: "attempt-1",
    });
    mockSessionLogs["attempt-1"] = [toolUse("toolu_old", "Bash", { command: "git push origin x" })];
    mockSessionLogs["attempt-2"] = [
      toolUse("toolu_new", "Bash", { command: "git status" }),
      toolResult("toolu_new"),
    ];
    const preamble = (await buildResumeContextPreamble(API_URL, API_KEY, "attempt-2")) ?? "";
    expect(preamble).toContain("## Resuming Interrupted Task");
    expect(preamble).not.toContain("Interrupted:");
  });

  describe("with intent rows", () => {
    const intent = (toolCallId: string, toolName: string, argsSummary: string) => ({
      toolCallId,
      toolName,
      argsSummary,
      createdAt: "2026-11-03T10:01:00.000Z",
    });

    test("flags an intent whose tool_use line never reached session_logs", async () => {
      mockToolIntents[TASK_ID] = [
        intent("toolu_9", "mcp__agent-swarm__slack-reply", '{"message":"Shipped"}'),
      ];
      try {
        const preamble = await preambleFor([]);
        expect(preamble).toContain(
          'Interrupted: mcp__agent-swarm__slack-reply {"message":"Shipped"} may have landed.',
        );
      } finally {
        delete mockToolIntents[TASK_ID];
      }
    });

    test("skips an intent the logs pair, and never lists a call twice", async () => {
      mockToolIntents[TASK_ID] = [
        intent("toolu_1", "Bash", "gh pr create --fill"),
        intent("toolu_2", "Bash", "gh pr create --title x"),
      ];
      try {
        const preamble = await preambleFor([
          toolUse("toolu_1", "Bash", { command: "gh pr create --fill" }),
          toolResult("toolu_1"),
          toolUse("toolu_2", "Bash", { command: "gh pr create --title x" }),
        ]);
        expect(preamble).toContain(
          "Interrupted: Bash gh pr create --title x may have landed. Check its effect",
        );
        expect(preamble).not.toContain("--fill may have landed");
        expect(preamble).not.toContain("--title x; Bash");
      } finally {
        delete mockToolIntents[TASK_ID];
      }
    });
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
