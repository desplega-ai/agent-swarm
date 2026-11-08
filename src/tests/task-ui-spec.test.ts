import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { standardComponentDefinitions } from "@json-render/chat";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import {
  getTaskUiSpec,
  getTaskUiSpecsForTasks,
  reserveTaskUiActionRun,
  setTaskUiActionResult,
  upsertTaskUiSpec,
} from "../be/task-ui-spec";
import { registerStoreProgressTool } from "../tools/store-progress";
import { taskUiSpecSlackBlocks } from "../ui-spec/slack";
import { validateTaskUiSpec } from "../ui-spec/validate";
import {
  type TaskUiSpecInput,
  UI_SPEC_ACTION_PREFIX,
  UI_SPEC_COMPONENTS,
  UI_SPEC_MAX_BLOCKS,
} from "../utils/task-ui-spec";

const TASK_ID = "11111111-2222-4333-8444-555555555555";

// The example from the plan's uiSpec contract (shared with the E2E scenario and the skill).
const example = (): TaskUiSpecInput => ({
  spec: {
    root: "c",
    elements: {
      c: { type: "Card", props: { title: "Weekly deploys" }, children: ["f", "t", "a"] },
      f: { type: "Fields", props: {}, children: ["k"] },
      k: { type: "Field", props: { label: "Deploys", value: "1,284" }, children: [] },
      t: {
        type: "Table",
        props: {
          headers: ["Service", "Deploys"],
          rows: [
            ["api", 812],
            ["ui", 472],
          ],
        },
        children: [],
      },
      a: { type: "Actions", props: {}, children: ["l"] },
      l: {
        type: "LinkButton",
        props: { label: "Open dashboard", url: "https://example.com/deploys" },
        children: [],
      },
    },
  },
});

const off = { taskId: TASK_ID, actionsEnabled: false };
const on = { taskId: TASK_ID, actionsEnabled: true };

function withButton(input: TaskUiSpecInput, id: string): TaskUiSpecInput {
  const a = input.spec.elements.a as { children: string[] };
  a.children.push("b");
  input.spec.elements.b = { type: "Button", props: { id, label: "Rerun" }, children: [] };
  return input;
}

function issuesOf(result: ReturnType<typeof validateTaskUiSpec>): string[] {
  if (result.ok) throw new Error("expected ok: false");
  return result.issues;
}

describe("validateTaskUiSpec", () => {
  test("the contract example converts to Slack blocks and fallback text", () => {
    const result = validateTaskUiSpec(example(), off);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.blocks.length).toBeLessThanOrEqual(UI_SPEC_MAX_BLOCKS);
    expect(result.fallbackText).toContain("Weekly deploys");
    expect(result.spec).toEqual(example().spec);
  });

  test("a LinkButton with a javascript: URL is refused", () => {
    const input = example();
    (input.spec.elements.l as { props: { url: string } }).props.url = "javascript:alert(1)";
    expect(issuesOf(validateTaskUiSpec(input, off))).toContain("l.url must be an https: URL.");
  });

  test("an Image and a Card imageUrl need https: too", () => {
    const input = example();
    (input.spec.elements.c as { props: Record<string, unknown> }).props.imageUrl =
      "http://example.com/a.png";
    expect(issuesOf(validateTaskUiSpec(input, off))).toContain("c.imageUrl must be an https: URL.");
  });

  test("a spec over 32 KB is refused", () => {
    const input = example();
    (input.spec.elements.k as { props: { value: string } }).props.value = "x".repeat(33 * 1024);
    const issues = issuesOf(validateTaskUiSpec(input, off));
    expect(issues[0]).toStartWith("uiSpec is ");
    expect(issues[0]).toEndWith("bytes; the limit is 32768.");
  });

  test("2 Tables are refused by the toCard table limit", () => {
    const input = example();
    input.spec.elements.t2 = structuredClone(input.spec.elements.t);
    (input.spec.elements.c as { children: string[] }).children.push("t2");
    expect(issuesOf(validateTaskUiSpec(input, off))).toEqual(["at most 1 Table per message"]);
  });

  test("a root that is not a Card is refused", () => {
    const input: TaskUiSpecInput = {
      spec: {
        root: "x",
        elements: { x: { type: "Text", props: { content: "hi" }, children: [] } },
      },
    };
    expect(issuesOf(validateTaskUiSpec(input, off))).toEqual(["root must be a Card"]);
  });

  test("a Button needs the action flag", () => {
    const input = withButton(example(), "rerun");
    input.actions = { rerun: { kind: "follow_up", prompt: "Run it again" } };
    expect(issuesOf(validateTaskUiSpec(input, off))).toEqual([
      "Button b needs UI_SPEC_ACTIONS_ENABLED=true; use LinkButton.",
    ]);
  });

  test("a Button that names an undeclared action is refused", () => {
    const input = withButton(example(), "rerun");
    input.actions = { other: { kind: "follow_up", prompt: "Something else" } };
    expect(issuesOf(validateTaskUiSpec(input, on))).toEqual([
      'Button b names action "rerun", which uiSpec.actions does not declare.',
    ]);
  });

  test("a Button cannot name an inherited object key", () => {
    const input = withButton(example(), "constructor");
    input.actions = {};
    expect(issuesOf(validateTaskUiSpec(input, on))).toEqual([
      'Button b names action "constructor", which uiSpec.actions does not declare.',
    ]);
  });

  test("a declared Button renders with the swarm_ui: prefix and the task id; the stored spec keeps its id", () => {
    const input = withButton(example(), "rerun");
    input.actions = { rerun: { kind: "follow_up", prompt: "Run it again" } };
    const result = validateTaskUiSpec(input, on);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.blocks);
    expect(json).toContain(`"action_id":"${UI_SPEC_ACTION_PREFIX}rerun"`);
    expect(json).toContain(`"value":"${TASK_ID}"`);
    expect((result.spec.elements.b as { props: { id: string } }).props.id).toBe("rerun");
    expect(result.actions).toEqual({ rerun: { kind: "follow_up", prompt: "Run it again" } });
  });
});

describe("taskUiSpecSlackBlocks", () => {
  test("renders a stored spec", () => {
    const blocks = taskUiSpecSlackBlocks({ ...example(), fallbackText: "Weekly deploys" }, TASK_ID);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  test("returns [] and logs issues, not the body, when a stored spec no longer converts", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stored = {
        spec: {
          root: "x",
          elements: { x: { type: "Text", props: { content: "secret body" }, children: [] } },
        },
        fallbackText: "secret body",
      };
      expect(taskUiSpecSlackBlocks(stored, TASK_ID)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain("root must be a Card");
      expect(logged).not.toContain("secret body");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("chat catalog drift", () => {
  test("UI_SPEC_COMPONENTS equals the @json-render/chat standard components", () => {
    expect([...UI_SPEC_COMPONENTS]).toEqual(Object.keys(standardComponentDefinitions));
  });
});

describe("task UI spec storage", () => {
  const dbPath = `/tmp/test-task-ui-spec-${crypto.randomUUID()}.sqlite`;
  let agentId: string;
  beforeAll(async () => {
    initDb(dbPath);
    agentId = (
      await createAgent({
        name: "UI spec test",
        role: "worker",
        isLead: false,
        status: "busy",
        capabilities: [],
      })
    ).id;
  });
  afterAll(async () => {
    closeDb();
    await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(dbPath + suffix, { force: true })));
  });

  test("upsert twice keeps one row with the latest spec", async () => {
    const task = await createTaskExtended("UI spec upsert", { agentId, source: "system" });
    const first = { ...example(), fallbackText: "first" };
    await upsertTaskUiSpec(task.id, first);
    const second = {
      ...example(),
      actions: { rerun: { kind: "follow_up" as const, prompt: "Run it again" } },
      fallbackText: "second",
    };
    await upsertTaskUiSpec(task.id, second);
    const rows = await getDbClient().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM task_ui_specs WHERE task_id = ?",
      [task.id],
    );
    expect(rows[0]!.n).toBe(1);
    expect(await getTaskUiSpec(task.id)).toEqual(second);
  });

  test("batch read maps every id, null when a task has no spec", async () => {
    const withSpec = await createTaskExtended("UI spec batch", { agentId, source: "system" });
    const without = await createTaskExtended("UI spec none", { agentId, source: "system" });
    await upsertTaskUiSpec(withSpec.id, { ...example(), fallbackText: "batch" });
    const byTask = await getTaskUiSpecsForTasks([withSpec.id, without.id, withSpec.id]);
    expect(byTask.size).toBe(2);
    expect(byTask.get(withSpec.id)?.fallbackText).toBe("batch");
    expect(byTask.get(without.id)).toBeNull();
    expect(await getTaskUiSpec(without.id)).toBeNull();
  });

  test("an action run is reserved once, then exists", async () => {
    const task = await createTaskExtended("UI action run", { agentId, source: "system" });
    const result = await createTaskExtended("UI action result", { agentId, source: "system" });
    const run = {
      taskId: task.id,
      actionId: "rerun",
      surface: "slack" as const,
      slackUserId: "U1",
    };
    expect(await reserveTaskUiActionRun({ ...run, userId: null })).toBe("reserved");
    expect(await reserveTaskUiActionRun({ ...run, userId: null })).toBe("exists");
    await setTaskUiActionResult(task.id, "rerun", result.id);
    const row = await getDbClient().get<{ resultTaskId: string }>(
      "SELECT result_task_id AS resultTaskId FROM task_ui_action_runs WHERE task_id = ? AND action_id = ?",
      [task.id, "rerun"],
    );
    expect(row?.resultTaskId).toBe(result.id);
  });

  describe("store-progress uiSpec", () => {
    type Result = { structuredContent: { success: boolean; message: string } };
    const handler = () => {
      const server = new McpServer({ name: "ui-spec-test", version: "1" });
      registerStoreProgressTool(server);
      return (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown, meta: unknown) => Promise<Result> }
          >;
        }
      )._registeredTools["store-progress"]!.handler;
    };
    const meta = () => ({ requestInfo: { headers: { "x-agent-id": agentId } } });
    const startedTask = async (title: string) => {
      const task = await createTaskExtended(title, { agentId, source: "system" });
      await startTask(task.id);
      return task;
    };
    const withFlag = async (value: string | undefined, fn: () => Promise<void>) => {
      const previous = process.env.UI_SPEC_ENABLED;
      if (value === undefined) delete process.env.UI_SPEC_ENABLED;
      else process.env.UI_SPEC_ENABLED = value;
      try {
        await fn();
      } finally {
        if (previous === undefined) delete process.env.UI_SPEC_ENABLED;
        else process.env.UI_SPEC_ENABLED = previous;
      }
    };
    const invalid = (): TaskUiSpecInput => {
      const spec = example();
      (spec.spec.elements.l as { props: { url: string } }).props.url = "javascript:alert(1)";
      return spec;
    };

    test("flag off: the task completes, no row, and the message says the spec was ignored", async () => {
      await withFlag(undefined, async () => {
        const task = await startedTask("UI spec flag off");
        const result = await handler()(
          { taskId: task.id, status: "completed", output: "Done", uiSpec: example() },
          meta(),
        );
        expect(result.structuredContent.success).toBe(true);
        expect(result.structuredContent.message).toContain("UI_SPEC_ENABLED is off");
        expect((await getTaskById(task.id))?.status).toBe("completed");
        expect(await getTaskUiSpec(task.id)).toBeNull();
      });
    });

    test("flag on and a valid spec: the row exists", async () => {
      await withFlag("true", async () => {
        const task = await startedTask("UI spec valid");
        const result = await handler()(
          { taskId: task.id, status: "completed", output: "Done", uiSpec: example() },
          meta(),
        );
        expect(result.structuredContent.success).toBe(true);
        expect((await getTaskById(task.id))?.status).toBe("completed");
        const stored = await getTaskUiSpec(task.id);
        expect(stored?.spec).toEqual(example().spec);
        expect(stored?.fallbackText).toContain("Weekly deploys");
      });
    });

    test("flag on and an invalid spec: refused once, then completed without the spec", async () => {
      await withFlag("true", async () => {
        const task = await startedTask("UI spec invalid");
        const args = { taskId: task.id, status: "completed", output: "Done", uiSpec: invalid() };
        const refused = await handler()(args, meta());
        expect(refused.structuredContent.success).toBe(false);
        expect(refused.structuredContent.message).toContain(
          "Completion refused: uiSpec is not valid. The task stays in_progress.",
        );
        expect(refused.structuredContent.message).toContain("l.url must be an https: URL.");
        expect((await getTaskById(task.id))?.status).toBe("in_progress");

        const accepted = await handler()(args, meta());
        expect(accepted.structuredContent.success).toBe(true);
        expect(accepted.structuredContent.message).toContain(
          "uiSpec dropped: l.url must be an https: URL.",
        );
        expect((await getTaskById(task.id))?.status).toBe("completed");
        expect(await getTaskUiSpec(task.id)).toBeNull();
      });
    });

    test("a uiSpec on a progress call is ignored", async () => {
      await withFlag("true", async () => {
        const task = await startedTask("UI spec progress");
        const result = await handler()(
          { taskId: task.id, progress: "Halfway", uiSpec: example() },
          meta(),
        );
        expect(result.structuredContent.success).toBe(true);
        expect(result.structuredContent.message).toContain(
          'uiSpec is stored only with status "completed".',
        );
        expect(await getTaskUiSpec(task.id)).toBeNull();
      });
    });
  });
});
