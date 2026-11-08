import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { AgentTask } from "../../api/types";

// A real DOM, the real Radix sheet (modal: it sets `pointer-events: none` on
// the body) and the app's real Toaster, which also mounts on the body.
GlobalRegistrator.register({ url: "https://swarm.test/tasks/task-1" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = new URL("../../", import.meta.url).pathname;
for (const alias of [
  "@/components/context-panel/context-panel-state",
  "@/components/link-preview/link-preview-scope",
  "@/components/shared/task-ui-spec-view",
  "@/components/ui/alert-callout",
  "@/components/ui/button",
  "@/components/ui/card",
  "@/components/ui/separator",
  "@/components/ui/sheet",
  "@/components/ui/skeleton",
  "@/components/ui/sonner",
  "@/components/ui/spinner",
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
const task = {
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
} as AgentTask;
mock.module("@/api/hooks/use-tasks", () => ({ useTask: () => ({ data: task, error: null }) }));
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
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
mock.module("@/components/sessions/task-outcome", () => ({
  TaskOutcome: ({ task: t }: { task: AgentTask }) => {
    const { TaskUiSpecView } = require("../shared/task-ui-spec-view");
    return <TaskUiSpecView task={t} />;
  },
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { ContextPanelProvider, useContextPanel } = await import(
  "../context-panel/context-panel-state"
);
const { Toaster } = await import("../ui/sonner");
const { LinkPreviewScopeContext } = await import("./link-preview-scope");
const { LinkPreviewSheet } = await import("./link-preview-panel");

function Probe() {
  const panel = useContextPanel();
  return <output data-testid="preview">{JSON.stringify(panel.preview)}</output>;
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(async () => {
  document.body.style.pointerEvents = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tasks/task-1"]}>
          <ContextPanelProvider>
            <Probe />
            <Toaster position="bottom-right" />
            <LinkPreviewScopeContext.Provider value={{ registerDock: () => () => {} }}>
              <LinkPreviewSheet target={{ kind: "task", taskId: "task-1" }} onClose={() => {}} />
            </LinkPreviewScopeContext.Provider>
          </ContextPanelProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** What a pointer would see at `el`: the nearest inline `pointer-events` up the tree. */
function effectivePointerEvents(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.style.pointerEvents) return node.style.pointerEvents;
  }
  return "auto";
}

describe("a card's Open toast in the mobile preview sheet", () => {
  test("stays clickable while the modal sheet disables the rest of the page", async () => {
    const rerun = [...document.querySelectorAll("button")].find((b) => b.textContent === "Re-run");
    if (!rerun) throw new Error("the card's Re-run button did not render");
    await act(async () => {
      rerun.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The premise: the modal sheet turns pointer events off outside itself.
    expect(document.body.style.pointerEvents).toBe("none");
    const open = [...document.querySelectorAll<HTMLElement>("[data-sonner-toast] button")].find(
      (b) => b.textContent === "Open",
    );
    if (!open) throw new Error("the Open toast action did not render");
    expect(open.closest("[data-radix-dialog-content], [role=dialog]")).toBeNull();
    expect(effectivePointerEvents(open)).toBe("auto");

    // And the click reaches the handler: the spawned task opens in the preview.
    await act(async () => open.click());
    expect(document.querySelector('[data-testid="preview"]')?.textContent).toBe(
      JSON.stringify({ kind: "task", taskId: "child-1" }),
    );
  });
});
