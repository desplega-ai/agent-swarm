import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../apps/ui/src/api/types";
import { extractRequestText } from "../../apps/ui/src/lib/json-render/session-thread-model";
import { parseAppDefinition } from "../apps/definition";
import { resolveTemplateFromCode } from "../prompts/resolver";
import "../prompts/session-templates";

async function expectParseIssue(definition: unknown, message: string): Promise<void> {
  const parsed = await parseAppDefinition(definition);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.issues.some((entry) => entry.message.includes(message))).toBe(true);
}

function sessionThreadDefinition(model = "screen", overrides: Record<string, unknown> = {}) {
  return {
    models: {
      screen: { columns: { rootTaskId: { kind: "string" } } },
    },
    queries: { screenById: { model: "screen" } },
    actions: {
      dispatchCoder: { kind: "task", prompt: "Edit the screen per the user's message" },
    },
    pages: {
      main: {
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["thread", "draftEcho"] },
          thread: {
            type: "SessionThread",
            props: {
              id: "thread",
              rootTaskId: { $state: "/queries/screenById/data/0/rootTaskId" },
              onDispatch: [
                { action: "app.action", params: { name: "dispatchCoder", input: { $form: "" } } },
                {
                  action: "app.mutate",
                  params: {
                    model,
                    op: "update",
                    rowId: "r1",
                    values: { rootTaskId: { $state: "/actions/dispatchCoder/taskId" } },
                  },
                },
              ],
              ...overrides,
            },
          },
          draftEcho: { type: "Text", props: { content: { $state: "/ui/thread/value" } } },
        },
      },
    },
    defaultPage: "main",
  };
}

describe("SessionThread validation", () => {
  test("accepts a SessionThread with a bound rootTaskId and an app.action + app.mutate onDispatch chain", async () => {
    const parsed = await parseAppDefinition(sessionThreadDefinition());
    expect(parsed.success).toBe(true);
  });

  test("accepts a minimal SessionThread (only id) that still claims /ui/<id>", async () => {
    // Every prop but `id` is optional, so `id` alone must validate, and
    // `draftEcho` binding `/ui/thread/value` proves the bare component still
    // registers its UI state slot.
    const definition = sessionThreadDefinition();
    definition.pages.main.elements.thread.props = { id: "thread" } as never;
    const parsed = await parseAppDefinition(definition);
    expect(parsed.success).toBe(true);
  });

  test("binding /ui/<id>/value without a matching SessionThread id fails", async () => {
    const definition = sessionThreadDefinition();
    definition.pages.main.elements.draftEcho.props = {
      content: { $state: "/ui/phantom/value" },
    };
    await expectParseIssue(definition, 'state reference targets unknown UI control "phantom"');
  });

  test("rejects an onDispatch app.mutate against an undeclared model", async () => {
    await expectParseIssue(sessionThreadDefinition("ghost"), 'unknown model "ghost"');
  });

  test("rejects an onDispatch app.action naming an undeclared app action", async () => {
    await expectParseIssue(
      sessionThreadDefinition("screen", {
        onDispatch: [{ action: "app.action", params: { name: "nope" } }],
      }),
      'unknown app action "nope"',
    );
  });

  test("rejects an onDispatch step with an unknown action type", async () => {
    await expectParseIssue(
      sessionThreadDefinition("screen", { onDispatch: [{ action: "app.explode", params: {} }] }),
      'unknown action type "app.explode"',
    );
  });

  test("accepts a $chain sentinel (e.g. parentTaskId) inside an onDispatch app.action's params", async () => {
    const definition = sessionThreadDefinition("screen", {
      onDispatch: [
        {
          action: "app.action",
          params: {
            name: "dispatchCoder",
            input: { $form: "" },
            parentTaskId: { $chain: "leafTaskId" },
          },
        },
      ],
    });
    const parsed = await parseAppDefinition(definition);
    expect(parsed.success).toBe(true);
  });

  test("rejects a $chain sentinel outside action params (not a resolvable literal there)", async () => {
    const definition = sessionThreadDefinition();
    definition.pages.main.elements.draftEcho.props = {
      content: { $chain: "leafTaskId" },
    };
    await expectParseIssue(
      definition,
      "$row, $rowIndex, $form, and $chain bindings are only allowed in action params",
    );
  });

  test("accepts an onRootCreated app.mutate writing $chain.newTaskId onto rootTaskId", async () => {
    const definition = sessionThreadDefinition("screen", {
      onDispatch: [
        {
          action: "app.action",
          params: {
            name: "dispatchCoder",
            input: { $form: "" },
            parentTaskId: { $chain: "leafTaskId" },
          },
        },
      ],
      onRootCreated: [
        {
          action: "app.mutate",
          params: {
            model: "screen",
            op: "update",
            rowId: "r1",
            values: { rootTaskId: { $chain: "newTaskId" } },
          },
        },
      ],
      onReset: [
        {
          action: "app.mutate",
          params: { model: "screen", op: "update", rowId: "r1", values: { rootTaskId: "" } },
        },
      ],
    });
    const parsed = await parseAppDefinition(definition);
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test("rejects an onRootCreated app.mutate against an undeclared model", async () => {
    await expectParseIssue(
      sessionThreadDefinition("screen", {
        onRootCreated: [
          {
            action: "app.mutate",
            params: {
              model: "ghost",
              op: "update",
              rowId: "r1",
              values: { rootTaskId: { $chain: "newTaskId" } },
            },
          },
        ],
      }),
      'unknown model "ghost"',
    );
  });

  test("rejects an onReset step with an unknown action type", async () => {
    await expectParseIssue(
      sessionThreadDefinition("screen", { onReset: [{ action: "app.explode", params: {} }] }),
      'unknown action type "app.explode"',
    );
  });

  test("rejects a SessionThread id that is not a plain token", async () => {
    const definition = sessionThreadDefinition();
    (definition.pages.main.elements.thread.props as Record<string, unknown>).id = "a/b";
    await expectParseIssue(definition, "SessionThread id must match ^[A-Za-z0-9_-]+$");
  });
});

describe("SessionThread turn text", () => {
  test("shows only input.message for a prompt rendered from the task.app.action template", () => {
    const input = { screenId: "s1", message: 'Add a card titled "Hello"\nwith two lines' };
    const { text } = resolveTemplateFromCode("task.app.action", {
      prompt: "# Edit a screen\n\nYou edit the screen doc.",
      app_id: "app-1",
      action_name: "editScreen",
      input_json: JSON.stringify(input),
      caller_json: JSON.stringify({ kind: "user", userId: "u1" }),
    });
    expect(text).toContain("[App action]");
    const task = { id: "t1", task: text } as AgentTask;
    expect(extractRequestText(task)).toBe(input.message);
  });
});
