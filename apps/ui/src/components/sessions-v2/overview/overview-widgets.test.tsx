import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ScheduledTask } from "@/api/types";
import type { DrivePath } from "@/lib/comb/paths";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

// One file for every Overview widget test: `mock.module` is process-wide, so
// the mocks below stay the same for all of them. The test runner cannot
// resolve ui's `@/` alias, so each aliased module maps to its real file or a stub.

interface Mutation {
  id: string;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}
let runs: Mutation[] = [];
let toasts: string[] = [];
let started: { key?: string; task?: string }[] = [];
let startOptions: { key?: string; buildTask?: (typed: string) => string }[] = [];
let recentSessions: { root: { id: string } }[] = [];
let client: QueryClient;

mock.module("sonner", () => ({
  toast: {
    success: (m: string) => toasts.push(m),
    error: (m: string) => toasts.push(m),
  },
}));
mock.module("@/api/hooks/use-schedules", () => ({
  useRunScheduleNow: () => ({
    isPending: false,
    variables: undefined,
    mutate: (id: string, callbacks: Omit<Mutation, "id">) => runs.push({ id, ...callbacks }),
  }),
  useUpdateSchedule: () => ({ isPending: false, variables: undefined, mutate: () => {} }),
  useCreateSchedule: () => ({ mutate: () => {} }),
}));
mock.module("@/api/hooks/use-agents", () => ({
  useAgents: () => ({ data: [{ id: "a1", name: "Researcher" }] }),
}));
mock.module("@/api/hooks/use-sessions", () => ({
  sessionsQueryOptions: (_userId: string | null, options: Record<string, unknown>) => ({
    queryKey: ["test-sessions", options],
    queryFn: async () => ({ sessions: recentSessions, total: recentSessions.length }),
  }),
}));
mock.module("@/api/hooks/use-agent-fs", () => ({
  useAgentFsStat: () => ({
    data: {
      path: "/shared/po-qa/report.md",
      size: 120,
      author: "u-researcher",
      createdAt: "2026-11-04T08:00:00Z",
      modifiedAt: "2026-11-04T08:00:00Z",
      isDeleted: false,
      contentType: "text/markdown",
    },
    isError: false,
  }),
}));
mock.module("@/api/client", () => ({
  api: { fetchTaskFiles: async () => ({ attachments: [] }) },
}));
mock.module("@/components/comb/use-author-label", () => ({
  useAuthorLabel: () => (id: string | undefined) => (id ? "Researcher" : ""),
}));
mock.module("@/components/schedules/schedule-dialog", () => ({
  ScheduleDialog: () => null,
  scheduleCreateInput: () => ({}),
}));
mock.module("@/components/sessions/use-start-session", () => ({
  useStartSession: (options: { key?: string; buildTask?: (typed: string) => string }) => {
    startOptions.push(options);
    const [draft, setDraft] = require("react").useState("");
    return {
      composerProps: {
        value: draft,
        onChange: setDraft,
        isPending: false,
        onSubmit: () =>
          started.push({ key: options.key, task: options.buildTask?.(draft.trim()) ?? draft }),
      },
    };
  },
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));
mock.module("../sidebar/session-row", () => ({ shortAgo: () => "2h" }));
// The markdown viewer itself reads Comb contexts: render the Comb markdown directly.
mock.module("../../comb/viewers/markdown-viewer", () => {
  const { CombMarkdown } = require("../../comb/viewers/comb-markdown");
  return {
    default: ({ file }: { file: DrivePath }) => (
      <article data-testid="markdown">
        <CombMarkdown text={"# Competitor scan\n\n- Linear raised its price"} doc={file} />
      </article>
    ),
  };
});
mock.module("@/components/comb/viewers/file-viewer", () =>
  require("../../comb/viewers/file-viewer"),
);
mock.module("@/components/comb/viewers/viewer-skeleton", () =>
  require("../../comb/viewers/viewer-skeleton"),
);
mock.module("@/components/ui/skeleton", () => require("../../ui/skeleton"));
mock.module("@/components/ui/button", () => require("../../ui/button"));
mock.module("@/components/ui/input", () => require("../../ui/input"));
mock.module("@/components/ui/switch", () => require("../../ui/switch"));
mock.module("@/components/ui/textarea", () => require("../../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../../ui/tooltip"));
mock.module("@/lib/comb/file-kinds", () => require("../../../lib/comb/file-kinds"));
mock.module("@/lib/comb/html-view", () => require("../../../lib/comb/html-view"));
mock.module("@/lib/comb/paths", () => require("../../../lib/comb/paths"));
mock.module("@/lib/enter-submit", () => require("../../../lib/enter-submit"));
mock.module("@/lib/format-bytes", () => require("../../../lib/format-bytes"));
mock.module("@/lib/use-case-overview", () => require("../../../lib/use-case-overview"));
mock.module("@/lib/utils", () => require("../../../lib/utils"));

const { TooltipProvider } = await import("../../ui/tooltip");
const { SchedulesWidget } = await import("./schedules-widget");
const { AskLeadWidget, askLeadTask } = await import("./ask-lead-widget");
const { FilePreview } = await import("./file-preview");
const { PAUSED_RUN_REASON } = await import("./run-now");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TooltipProvider>{node}</TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("no element to click");
  await act(async () => (element as HTMLElement).click());
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );

function schedule(i: number, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `s${i}`,
    key: "shared/po-qa/",
    name: `Pricing page diff ${i}`,
    cronExpression: "30 7 * * *",
    timezone: "UTC",
    taskTemplate: `Diff page ${i}.`,
    targetAgentId: "a1",
    enabled: true,
    nextRunAt: "2026-11-05T07:30:00Z",
    tags: [],
    priority: 50,
    createdAt: "2026-11-01T00:00:00Z",
    lastUpdatedAt: "2026-11-01T00:00:00Z",
    ...extra,
  };
}

beforeEach(() => {
  runs = [];
  toasts = [];
  started = [];
  startOptions = [];
  recentSessions = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const NOW = Date.parse("2026-11-04T15:00:00Z");

describe("SchedulesWidget", () => {
  test("no search below 8 schedules, a search from 8 up that filters", async () => {
    await mount(
      <SchedulesWidget
        groupKey="shared/po-qa/"
        now={NOW}
        schedules={[1, 2, 3, 4, 5, 6, 7].map((i) => schedule(i))}
      />,
    );
    expect(container.querySelector('input[aria-label="Search schedules"]')).toBeNull();
    await act(async () => root.unmount());
    container.remove();

    const many = Array.from({ length: 50 }, (_, i) =>
      schedule(i, i === 7 ? { name: "Weekly digest", cronExpression: "0 16 * * 5" } : {}),
    );
    await mount(<SchedulesWidget groupKey="shared/po-qa/" now={NOW} schedules={many} />);
    const search = container.querySelector(
      'input[aria-label="Search schedules"]',
    ) as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(container.querySelectorAll('ul[aria-label="Schedules in this group"] > li').length).toBe(
      50,
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(search, "digest");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = container.querySelectorAll('ul[aria-label="Schedules in this group"] > li');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("Weekly digest");
    expect(container.textContent).toContain("1 of 50");
  });

  test("Run now calls the mutation and toasts the server's 400 message", async () => {
    await mount(<SchedulesWidget groupKey="shared/po-qa/" now={NOW} schedules={[schedule(1)]} />);
    await click(button("Run Pricing page diff 1 now"));
    expect(runs.map((run) => run.id)).toEqual(["s1"]);
    await act(async () => runs[0]?.onError?.(new Error("Schedule is disabled")));
    expect(toasts).toEqual(["Schedule is disabled"]);
  });

  test("a paused schedule's Run now is blocked and says why", async () => {
    await mount(
      <SchedulesWidget
        groupKey="shared/po-qa/"
        now={NOW}
        schedules={[schedule(1, { enabled: false })]}
      />,
    );
    const run = button("Run Pricing page diff 1 now");
    expect(run?.getAttribute("aria-disabled")).toBe("true");
    await click(run);
    expect(runs).toEqual([]);
    expect(PAUSED_RUN_REASON).toContain("Turn the schedule on");
    expect(container.textContent).toContain("0 enabled · 1 paused");
  });

  test("the Template disclosure shows the task read-only", async () => {
    await mount(<SchedulesWidget groupKey="shared/po-qa/" now={NOW} schedules={[schedule(1)]} />);
    expect(container.textContent).not.toContain("Diff page 1.");
    await click(button("Template"));
    expect(container.querySelector("pre")?.textContent).toBe("Diff page 1.");
    expect(container.textContent).toContain("read-only");
  });
});

describe("AskLeadWidget", () => {
  test("Send starts a session in the group, with the open file attached", async () => {
    await mount(
      <AskLeadWidget
        groupKey="shared/po-qa/"
        file="/shared/po-qa/report.md"
        now={NOW}
        onOpen={() => {}}
        writeBlock={null}
      />,
    );
    expect(startOptions.at(-1)?.key).toBe("shared/po-qa/");
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(box, "Add Plane to the scan");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Send to the Lead"));
    expect(started).toEqual([
      {
        key: "shared/po-qa/",
        task: askLeadTask("Add Plane to the scan", "/shared/po-qa/report.md"),
      },
    ]);
    expect(started[0]?.task).toContain("`/shared/po-qa/report.md`");
  });

  test("an empty draft sends nothing", async () => {
    await mount(
      <AskLeadWidget
        groupKey="shared/po-qa/"
        file={null}
        now={NOW}
        onOpen={() => {}}
        writeBlock={null}
      />,
    );
    await click(button("Send to the Lead"));
    expect(started).toEqual([]);
    expect(askLeadTask("Hi", null)).toBe("Hi");
  });
});

describe("FilePreview", () => {
  test("a markdown output renders as markdown with an Open in Files link", async () => {
    const file = { orgId: "o1", driveId: "d1", path: "/shared/po-qa/report.md" };
    await mount(<FilePreview groupKey="shared/po-qa/" file={file} now={NOW} onOpen={() => {}} />);
    for (let i = 0; i < 20 && !container.querySelector('[data-testid="markdown"]'); i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(container.querySelector("h1")?.textContent).toBe("Competitor scan");
    expect(container.querySelector("li")?.textContent).toBe("Linear raised its price");
    const open = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Open in Files"),
    );
    expect(open?.getAttribute("href")).toBe("/file/~/o1/d1/shared/po-qa/report.md");
    expect(container.textContent).toContain("Researcher wrote it");
  });

  test("the source lookups run once and never join the app-wide poll", async () => {
    recentSessions = [{ root: { id: "t1" } }, { root: { id: "t2" } }];
    const file = { orgId: "o1", driveId: "d1", path: "/shared/po-qa/report.md" };
    await mount(<FilePreview groupKey="shared/po-qa/" file={file} now={NOW} onOpen={() => {}} />);
    const lookups = () =>
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === "task");
    for (let i = 0; i < 20 && lookups().length < 2; i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    const queries = client.getQueryCache().getAll();
    expect(lookups().map((query) => query.queryKey[1])).toEqual(["t1", "t2"]);
    for (const query of queries) {
      expect(query.observers.map((observer) => observer.options.refetchInterval)).toEqual([false]);
    }
  });
});
