import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../apps/ui/src/api/types";
import { threadRequestText } from "../../apps/ui/src/lib/json-render/session-thread-model";
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
              sessionKey: "main",
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
  test("accepts a SessionThread with a sessionKey and an app.action + app.mutate onDispatch chain", async () => {
    const parsed = await parseAppDefinition(sessionThreadDefinition());
    expect(parsed.success).toBe(true);
  });

  test("accepts a minimal SessionThread (id and sessionKey) that still claims /ui/<id>", async () => {
    // `id` and `sessionKey` are the only required props, and `draftEcho`
    // binding `/ui/thread/value` proves the bare component still registers
    // its UI state slot.
    const definition = sessionThreadDefinition();
    definition.pages.main.elements.thread.props = { id: "thread", sessionKey: "main" } as never;
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

  test("rejects a SessionThread with no sessionKey", async () => {
    const definition = sessionThreadDefinition();
    definition.pages.main.elements.thread.props = { id: "thread" } as never;
    await expectParseIssue(definition, "is required");
  });

  test("rejects a literal sessionKey that is not a plain token", async () => {
    await expectParseIssue(
      sessionThreadDefinition("screen", { sessionKey: "a:b" }),
      "SessionThread sessionKey must match ^[A-Za-z0-9_-]{1,128}$",
    );
  });

  test("accepts a bound sessionKey (checked by the server at send time)", async () => {
    const parsed = await parseAppDefinition(
      sessionThreadDefinition("screen", {
        sessionKey: { $state: "/queries/screenById/data/0/id" },
        scope: "user",
      }),
    );
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test('rejects scope "shared" until shared sessions land', async () => {
    await expectParseIssue(
      sessionThreadDefinition("screen", { scope: "shared" }),
      'scope "shared" is not supported yet',
    );
  });

  test("rejects a SessionThread id that is not a plain token", async () => {
    const definition = sessionThreadDefinition();
    (definition.pages.main.elements.thread.props as Record<string, unknown>).id = "a/b";
    await expectParseIssue(definition, "SessionThread id must match ^[A-Za-z0-9_-]+$");
  });
});

/** A create form whose chain starts the new project's session, then opens it. */
function startSessionDefinition(session: unknown) {
  return {
    models: { project: { columns: { name: { kind: "string" } } } },
    actions: { build: { kind: "task", prompt: "Build the page" } },
    pages: {
      home: {
        root: "form",
        elements: {
          form: {
            type: "Form",
            props: {
              id: "newProject",
              fields: [{ name: "name", label: "Name", kind: "string" }],
              onSubmit: [
                {
                  action: "app.mutate",
                  params: { model: "project", op: "create", values: { name: { $form: "name" } } },
                },
                {
                  action: "app.action",
                  params: { name: "build", input: { message: { $form: "name" } }, session },
                },
                {
                  action: "app.navigate",
                  params: {
                    page: "studio",
                    params: { projectId: { $state: "/mutations/project/rowId" } },
                  },
                },
              ],
            },
          },
        },
      },
      studio: {
        params: { projectId: { kind: "string" } },
        root: "thread",
        elements: {
          thread: {
            type: "SessionThread",
            props: { id: "chat", sessionKey: { $state: "/route/params/projectId" } },
          },
        },
      },
    },
    defaultPage: "home",
  };
}

describe("app.action session", () => {
  test("accepts a session key bound to the row a create step just made", async () => {
    const parsed = await parseAppDefinition(
      startSessionDefinition({ key: { $state: "/mutations/project/rowId" } }),
    );
    if (!parsed.success) console.error(parsed.issues);
    expect(parsed.success).toBe(true);
  });

  test("accepts a literal plain-token key with scope user", async () => {
    const parsed = await parseAppDefinition(startSessionDefinition({ key: "main", scope: "user" }));
    expect(parsed.success).toBe(true);
  });

  test("rejects a literal key that is not a plain token", async () => {
    await expectParseIssue(
      startSessionDefinition({ key: "a:b" }),
      "session key must match ^[A-Za-z0-9_-]{1,128}$",
    );
  });

  test('rejects scope "shared" until shared sessions land', async () => {
    await expectParseIssue(
      startSessionDefinition({ key: "main", scope: "shared" }),
      'scope "shared" is not supported yet',
    );
  });

  test("rejects a /mutations ref to an undeclared model", async () => {
    await expectParseIssue(
      startSessionDefinition({ key: { $state: "/mutations/ghost/rowId" } }),
      'state reference targets unknown model "ghost"',
    );
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
    // `app.action` creates its tasks with source "api" (src/apps/action-runner.ts).
    const task = { id: "t1", task: text, source: "api" } as AgentTask;
    expect(threadRequestText(task)).toBe(input.message);
  });
});
