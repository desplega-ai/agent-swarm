import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type TaskUiSpec, UI_SPEC_COMPONENTS } from "../../../../../src/utils/task-ui-spec";

// The root-level test run cannot resolve ui's `@/` alias. Plain lib modules
// map to their real files; the UI primitives are thin stubs that keep markup.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/json-render/card-grid-model", () =>
  require("../../lib/json-render/card-grid-model"),
);
mock.module("@/lib/json-render/chart-model", () => require("../../lib/json-render/chart-model"));
mock.module("@/lib/recharts-tooltip-style", () => require("../../lib/recharts-tooltip-style"));
const stub =
  (tag: string) =>
  ({ children }: { children?: ReactNode }) => {
    const Tag = tag as "div";
    return <Tag>{children}</Tag>;
  };
// The Button stub keeps the last click handler, so a test can click it without a DOM.
let lastButtonClick: (() => void) | undefined;
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => {
    if (onClick) lastButtonClick = onClick;
    return <span data-button={disabled ? "disabled" : "enabled"}>{children}</span>;
  },
}));
const runTaskUiAction = mock(
  async (): Promise<{ status: string; taskId?: string; uiSpec?: TaskUiSpec }> => ({
    status: "started",
    taskId: "child",
  }),
);
mock.module("@/api/client", () => ({ api: { runTaskUiAction } }));
const invalidateQueries = mock(async (_filters: { queryKey: unknown[] }) => {});
mock.module("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
mock.module("lucide-react", () => ({ Loader2: () => <i /> }));
const navigate = mock(() => {});
mock.module("react-router-dom", () => ({ useNavigate: () => navigate }));
// A card inside a link preview scope with a context panel opens the spawned
// task in the split screen; otherwise Open navigates.
let inPreviewScope = false;
const openPreview = mock((_target: unknown) => {});
mock.module("@/components/link-preview/link-preview-scope", () => ({
  useLinkPreviewScope: () => (inPreviewScope ? { registerDock: () => () => {} } : null),
}));
mock.module("@/components/context-panel/context-panel-state", () => ({
  useOptionalContextPanel: () => ({ openPreview }),
}));
const toastSuccess = mock(
  (_message: string, _options?: { action: { label: string; onClick: () => void } }) => {},
);
mock.module("sonner", () => ({ toast: { success: toastSuccess, error: () => {} } }));
mock.module("@/components/ui/card", () => ({
  Card: stub("section"),
  CardHeader: stub("header"),
  CardTitle: stub("h3"),
  CardDescription: stub("p"),
  CardContent: stub("div"),
}));
mock.module("@/components/ui/separator", () => ({ Separator: () => <hr /> }));
mock.module("@/components/ui/table", () => ({
  Table: stub("table"),
  TableHeader: stub("thead"),
  TableBody: stub("tbody"),
  TableCaption: stub("caption"),
  TableRow: stub("tr"),
  TableHead: stub("th"),
  TableCell: stub("td"),
}));

const { TaskUiSpecView, renderUiSpecElement, uiSpecPieSlices } = await import(
  "./task-ui-spec-view"
);
const { distinctSeriesColor } = await import("../../lib/json-render/chart-model");

const FALLBACK = "FALLBACK TEXT";

/** Minimal valid props for each catalog component. */
const SAMPLE_PROPS: Record<(typeof UI_SPEC_COMPONENTS)[number], Record<string, unknown>> = {
  Card: { title: "Card title" },
  Section: {},
  Text: { content: "Some text" },
  Fields: {},
  Field: { label: "Deploys", value: "1,284" },
  Table: { headers: ["Service", "Deploys"], rows: [["api", 812]] },
  Chart: {
    title: "Trend",
    chart: { type: "bar", categories: ["a"], series: [{ name: "s", values: [1] }] },
  },
  Divider: {},
  Image: { url: "https://example.com/x.png", alt: "x" },
  Actions: {},
  Button: { id: "rerun", label: "Re-run" },
  LinkButton: { label: "Open", url: "https://example.com" },
};

function specWith(type: string, props: Record<string, unknown>): TaskUiSpec {
  const elements: Record<string, unknown> =
    type === "Card"
      ? { c: { type, props, children: [] } }
      : {
          c: { type: "Card", props: {}, children: ["x"] },
          x: { type, props, children: [] },
        };
  return {
    spec: { root: "c", elements },
    actions: { rerun: { kind: "follow_up", prompt: "Run it again" } },
    fallbackText: FALLBACK,
  };
}

const render = (uiSpec: TaskUiSpec | null) =>
  renderToStaticMarkup(<TaskUiSpecView task={{ id: "task-1", uiSpec }} />);

describe("TaskUiSpecView", () => {
  test.each([...UI_SPEC_COMPONENTS])("the switch renders %s without the fallback", (type) => {
    const html = render(specWith(type, SAMPLE_PROPS[type]));
    expect(html).toContain('data-slot="task-ui-spec"');
    expect(html).not.toContain(FALLBACK);
  });

  test("an unknown type shows the fallback text", () => {
    const html = render(specWith("Marquee", {}));
    expect(html).toContain(FALLBACK);
    expect(html).not.toContain('data-slot="task-ui-spec"');
  });

  test("a root that is not a Card shows the fallback text", () => {
    const html = render({
      spec: { root: "t", elements: { t: { type: "Text", props: { content: "x" }, children: [] } } },
      fallbackText: FALLBACK,
    });
    expect(html).toContain(FALLBACK);
  });

  test("an unsafe LinkButton URL renders no link", () => {
    const html = render(specWith("LinkButton", { label: "Bad", url: "javascript:alert(1)" }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Bad");
  });

  test("a Button renders only when its action is declared", () => {
    expect(render(specWith("Button", { id: "rerun", label: "Re-run" }))).toContain(
      'data-button="enabled"',
    );
    expect(render(specWith("Button", { id: "other", label: "Nope" }))).not.toContain("Nope");
  });

  test("a Button click posts the task ui-action route for its action", () => {
    lastButtonClick = undefined;
    render(specWith("Button", { id: "rerun", label: "Re-run" }));
    expect(lastButtonClick).toBeDefined();
    lastButtonClick?.();
    expect(runTaskUiAction).toHaveBeenCalledWith("task-1", "rerun");
  });

  test("a script Button stays enabled, hands over the new card and invalidates task queries", async () => {
    const fresh = specWith("Text", { content: "Fresh" });
    runTaskUiAction.mockImplementationOnce(async () => ({ status: "refreshed", uiSpec: fresh }));
    invalidateQueries.mockClear();
    const onRefreshed = mock((_uiSpec: TaskUiSpec) => {});
    lastButtonClick = undefined;
    const html = renderToStaticMarkup(
      <>
        {renderUiSpecElement(
          "Button",
          { type: "Button", props: { id: "refresh", label: "Refresh" }, children: [] },
          {
            taskId: "task-1",
            elements: {},
            actions: { refresh: { kind: "script", script: "deploy-stats" } },
            onRefreshed,
          },
        )}
      </>,
    );
    expect(html).toContain('data-button="enabled"');
    lastButtonClick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runTaskUiAction).toHaveBeenCalledWith("task-1", "refresh");
    expect(onRefreshed).toHaveBeenCalledWith(fresh);
    expect(invalidateQueries.mock.calls.map(([filters]) => filters.queryKey)).toEqual([
      ["task", "task-1"],
      ["session"],
      ["sessions"],
    ]);
  });

  test("outside a preview scope, Open navigates to the spawned task", async () => {
    toastSuccess.mockClear();
    navigate.mockClear();
    openPreview.mockClear();
    inPreviewScope = false;
    render(specWith("Button", { id: "rerun", label: "Re-run" }));
    lastButtonClick?.();
    await Promise.resolve();
    const [message, options] = toastSuccess.mock.calls[0]!;
    expect(message).toBe("Follow-up started.");
    expect(options?.action.label).toBe("Open");
    expect(navigate).not.toHaveBeenCalled();
    options?.action.onClick();
    expect(navigate).toHaveBeenCalledWith("/tasks/child");
    expect(openPreview).not.toHaveBeenCalled();
  });

  test("inside a preview scope, Open shows the spawned task in the split screen", async () => {
    toastSuccess.mockClear();
    navigate.mockClear();
    openPreview.mockClear();
    inPreviewScope = true;
    try {
      render(specWith("Button", { id: "rerun", label: "Re-run" }));
      lastButtonClick?.();
      await Promise.resolve();
      toastSuccess.mock.calls[0]![1]?.action.onClick();
      expect(openPreview).toHaveBeenCalledWith({ kind: "task", taskId: "child" });
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      inPreviewScope = false;
    }
  });

  test("an already-run action offers no new task navigation", async () => {
    toastSuccess.mockClear();
    runTaskUiAction.mockResolvedValueOnce({ status: "already_done", taskId: "child" });
    render(specWith("Button", { id: "rerun", label: "Re-run" }));
    lastButtonClick?.();
    await Promise.resolve();
    expect(toastSuccess.mock.calls[0]).toEqual(["This button already ran.", undefined]);
  });

  test("the plan example renders its field, table rows and link", () => {
    const html = render({
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
      fallbackText: FALLBACK,
    });
    for (const s of [
      "Weekly deploys",
      "1,284",
      "api",
      "812",
      "472",
      'href="https://example.com/deploys"',
    ]) {
      expect(html).toContain(s);
    }
  });

  test("no uiSpec renders nothing", () => {
    expect(render(null)).toBe("");
  });
});

// Regression: the dark theme sets chart-3 to the brand color, so the 3rd series
// or slice of a card chart matched the 1st (seen on a 3-plan pie and area chart).
describe("TaskUiSpecView chart colors", () => {
  test("a 3-segment pie gives each slice its own color", () => {
    const slices = uiSpecPieSlices({
      type: "pie",
      segments: [
        { label: "Enterprise", value: 52 },
        { label: "Team", value: 31 },
        { label: "Self-serve", value: 17 },
      ],
    });
    expect(slices.map((s) => s.label)).toEqual(["Enterprise", "Team", "Self-serve"]);
    expect(new Set(slices.map((s) => s.color)).size).toBe(3);
    expect(slices.map((s) => s.color)).not.toContain("var(--color-chart-3)");
  });

  test("the first 3 series of a bar, line or area chart get distinct colors", () => {
    const colors = [0, 1, 2].map(distinctSeriesColor);
    expect(new Set(colors).size).toBe(3);
    expect(colors).not.toContain("var(--color-chart-3)");
  });
});
