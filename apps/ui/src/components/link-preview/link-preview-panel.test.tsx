import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { AgentTask } from "../../api/types";

// A real DOM: the test clicks the card's button inside the preview panel.
GlobalRegistrator.register({ url: "https://swarm.test/tasks/task-1" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The root test run cannot resolve the UI's `@/` alias. The modules the task
// preview really runs (panel, card, scope and panel state) map to their files.
const SRC = new URL("../../", import.meta.url).pathname;
for (const alias of [
  "@/components/context-panel/context-panel-state",
  "@/components/link-preview/link-preview-scope",
  "@/components/shared/task-ui-spec-view",
  "@/components/ui/alert-callout",
  "@/components/ui/button",
  "@/components/ui/card",
  "@/components/ui/separator",
  "@/components/ui/skeleton",
  "@/components/ui/table",
  "@/lib/format-bytes",
  "@/lib/json-render/card-grid-model",
  "@/lib/json-render/chart-model",
  "@/lib/link-preview",
  "@/lib/recharts-tooltip-style",
  "@/lib/relative-time",
  "@/lib/status-labels",
  "@/lib/task-reason",
  "@/lib/task-title",
  "@/lib/utils",
]) {
  const path = Bun.resolveSync(`./${alias.slice(2)}`, SRC);
  mock.module(alias, () => require(path));
}

const runTaskUiAction = mock(async () => ({ status: "started" as const, taskId: "child-1" }));
mock.module("@/api/client", () => ({ api: { runTaskUiAction } }));
let task: AgentTask | undefined;
mock.module("@/api/hooks/use-tasks", () => ({
  useTask: () => ({ data: task, error: null }),
}));
mock.module("@/api/hooks/use-agent-fs", () => ({ useAgentFsStat: () => ({}) }));
mock.module("@/api/hooks/use-pages", () => ({ usePage: () => ({ data: undefined }) }));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true }),
}));
mock.module("@/hooks/use-local-toggle", () => ({
  useLocalToggle: (_key: string, initial: boolean) => useState(initial),
}));
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => null }));
mock.module("@/lib/agent-fs/client", () => ({ AgentFsError: class AgentFsError extends Error {} }));
mock.module("@/components/comb/file-icon", () => ({ FileKindIcon: () => null }));
mock.module("@/components/comb/viewers/file-viewer", () => ({ FileViewer: () => null }));
mock.module("@/components/comb/viewers/viewer-skeleton", () => ({ ViewerSkeleton: () => null }));
mock.module("@/components/ui/sheet", () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetDescription: () => null,
  SheetTitle: () => null,
}));
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
// The outcome's markdown stack is out of scope. As the real one, it puts the
// real card under a completed answer.
mock.module("@/components/sessions/task-outcome", () => ({
  TaskOutcome: ({ task: t }: { task: AgentTask }) => {
    const { TaskUiSpecView } = require("../shared/task-ui-spec-view");
    return (
      <>
        <p data-testid="outcome">{t.output}</p>
        {t.status === "completed" && t.output ? <TaskUiSpecView task={t} /> : null}
      </>
    );
  },
}));
const toastSuccess = mock(
  (_message: string, _options?: { action: { label: string; onClick: () => void } }) => {},
);
mock.module("sonner", () => ({ toast: { success: toastSuccess, error: () => {} } }));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router-dom");
const { ContextPanelProvider, useContextPanel } = await import(
  "../context-panel/context-panel-state"
);
const { LinkPreviewScopeContext } = await import("./link-preview-scope");
const { LinkPreviewContent } = await import("./link-preview-panel");

const TARGET = { kind: "task", taskId: "task-1" } as const;

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    task: "Weekly report",
    title: "Weekly report",
    status: "completed",
    output: "Here is the report.",
    uiSpec: {
      spec: {
        root: "c",
        elements: {
          c: { type: "Card", props: { title: "Report card" }, children: ["a"] },
          a: { type: "Actions", props: {}, children: ["b"] },
          b: { type: "Button", props: { id: "rerun", label: "Re-run" }, children: [] },
        },
      },
      actions: { rerun: { kind: "follow_up", prompt: "Run it again" } },
      fallbackText: "fallback",
    },
    ...overrides,
  } as AgentTask;
}

function Probe() {
  const { pathname } = useLocation();
  const panel = useContextPanel();
  return (
    <div>
      <output data-testid="location">{pathname}</output>
      <output data-testid="preview">{JSON.stringify(panel.preview)}</output>
    </div>
  );
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

async function render({ scoped }: { scoped: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const panel = <LinkPreviewContent target={TARGET} onClose={() => {}} />;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tasks/task-1"]}>
          <ContextPanelProvider>
            <Probe />
            {scoped ? (
              <LinkPreviewScopeContext.Provider value={{ registerDock: () => () => {} }}>
                {panel}
              </LinkPreviewScopeContext.Provider>
            ) : (
              panel
            )}
          </ContextPanelProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  // The body loads lazily.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const text = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

async function clickCardButton() {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Re-run");
  if (!button) throw new Error("the card's Re-run button did not render");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  task = makeTask();
  toastSuccess.mockClear();
  runTaskUiAction.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the task preview", () => {
  test("shows the task title, status, outcome and card, with a link to the full page", async () => {
    await render({ scoped: true });

    expect(document.body.textContent).toContain("Weekly report");
    expect(document.body.textContent).toContain("Completed");
    expect(text("outcome")).toBe("Here is the report.");
    expect(document.querySelector('[data-slot="ui-spec-card"]')?.textContent).toContain(
      "Report card",
    );
    const open = document.querySelector<HTMLAnchorElement>('a[aria-label="Open in new tab"]');
    expect(open?.getAttribute("href")).toBe("/tasks/task-1");
  });

  test("a card with no answer still shows", async () => {
    task = makeTask({ output: undefined });
    await render({ scoped: true });
    expect(document.querySelector('[data-slot="ui-spec-card"]')).not.toBeNull();
  });

  test("a task with no result yet says so", async () => {
    task = makeTask({ status: "pending", output: undefined, uiSpec: undefined });
    await render({ scoped: true });
    expect(document.body.textContent).toContain("No result yet.");
    expect(document.querySelector('[data-slot="ui-spec-card"]')).toBeNull();
  });

  test("a card button's Open shows the spawned task in the preview", async () => {
    await render({ scoped: true });
    await clickCardButton();

    expect(runTaskUiAction).toHaveBeenCalledWith("task-1", "rerun");
    const action = toastSuccess.mock.calls[0]?.[1]?.action;
    expect(action?.label).toBe("Open");
    await act(async () => action?.onClick());

    expect(JSON.parse(text("preview"))).toEqual({ kind: "task", taskId: "child-1" });
    expect(text("location")).toBe("/tasks/task-1");
  });

  test("outside a preview scope, Open navigates to the spawned task", async () => {
    await render({ scoped: false });
    await clickCardButton();
    await act(async () => toastSuccess.mock.calls[0]?.[1]?.action.onClick());

    expect(text("location")).toBe("/tasks/child-1");
    expect(text("preview")).toBe("null");
  });
});
