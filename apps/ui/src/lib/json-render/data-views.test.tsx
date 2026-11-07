import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import {
  groupTimeline,
  isIsoDate,
  presetRange,
  timelineDayLabel,
  validCustomRange,
} from "./data-views-model";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { StateProvider } = await import("@json-render/react");

mock.module("@/components/shared/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div data-testid="empty-state">{title}</div>,
}));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/input", () => require("../../components/ui/input"));
mock.module("@/components/ui/popover", () => require("../../components/ui/popover"));
mock.module("@/components/ui/skeleton", () => require("../../components/ui/skeleton"));
mock.module("@/lib/utils", () => require("../utils"));

const { DateRangeComponent, TimelineView } = await import("./data-views");
type DateRangeProps = Parameters<typeof DateRangeComponent>[0]["props"];
type TimelineProps = Parameters<typeof TimelineView>[0]["props"];

// A local-time "now" so day boundaries do not depend on the runner's zone.
const NOW = new Date(2026, 10, 6, 15, 30);

beforeEach(() => {
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("presetRange", () => {
  test("fixed presets end today and include it", () => {
    expect(presetRange("7d", NOW)).toEqual({ from: "2026-10-31", to: "2026-11-06" });
    expect(presetRange("30d", NOW)).toEqual({ from: "2026-10-08", to: "2026-11-06" });
    expect(presetRange("90d", NOW)).toEqual({ from: "2026-08-09", to: "2026-11-06" });
    expect(presetRange("mtd", NOW)).toEqual({ from: "2026-11-01", to: "2026-11-06" });
  });

  test("custom ranges need two real dates in order", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(validCustomRange("2026-11-01", "2026-11-06")).toBe(true);
    expect(validCustomRange("2026-11-06", "2026-11-06")).toBe(true);
    expect(validCustomRange("2026-11-07", "2026-11-06")).toBe(false);
    expect(validCustomRange("", "2026-11-06")).toBe(false);
  });
});

type Change = { path: string; value: unknown };

async function mountRange(props: DateRangeProps, initialState: Record<string, unknown> = {}) {
  const changes: Change[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StateProvider initialState={initialState} onStateChange={(batch) => changes.push(...batch)}>
        <DateRangeComponent props={props} />
      </StateProvider>,
    ),
  );
  return { host, changes };
}

const lastWrite = (changes: Change[], path: string) =>
  changes.filter((change) => change.path === path).at(-1)?.value;

describe("DateRange", () => {
  test("writes the default preset's range to /ui/<id>/from and /to on load", async () => {
    const { host, changes } = await mountRange({ id: "period", defaultPreset: "30d" });
    expect(lastWrite(changes, "/ui/period/from")).toBe(presetRange("30d").from);
    expect(lastWrite(changes, "/ui/period/to")).toBe(presetRange("30d").to);
    expect(host.querySelector('[data-preset="30d"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  test("a preset click rewrites both paths", async () => {
    const { host, changes } = await mountRange({ id: "period", presets: ["7d", "30d"] });
    expect(lastWrite(changes, "/ui/period/from")).toBe(presetRange("7d").from);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-preset="30d"]')?.click();
    });
    expect(lastWrite(changes, "/ui/period/from")).toBe(presetRange("30d").from);
    expect(lastWrite(changes, "/ui/period/to")).toBe(presetRange("30d").to);
    expect(lastWrite(changes, "/ui/period/preset")).toBe("30d");
    expect([...host.querySelectorAll("[data-preset]")].map((b) => b.textContent)).toEqual([
      "7 days",
      "30 days",
    ]);
  });

  test("a range already in state is kept on load", async () => {
    const { changes } = await mountRange(
      { id: "period" },
      { ui: { period: { from: "2026-01-01", to: "2026-01-31", preset: "custom" } } },
    );
    expect(changes).toEqual([]);
  });
});

describe("groupTimeline", () => {
  const rows = [
    { title: "old", at: "2026-11-04T09:00:00" },
    { title: "bad", at: "not a date" },
    { title: "today early", at: new Date(2026, 10, 6, 8, 0).getTime() },
    { title: "today late", at: "2026-11-06T14:00:00" },
    { title: "yesterday", at: "2026-11-05T23:59:00" },
  ];

  test("newest first, grouped by local day, unparseable rows dropped", () => {
    const days = groupTimeline(rows, "at", NOW);
    expect(days.map((day) => [day.label, day.entries.map((e) => e.row.title)])).toEqual([
      ["Today", ["today late", "today early"]],
      ["Yesterday", ["yesterday"]],
      ["Wed, Nov 4, 2026", ["old"]],
    ]);
    expect(days[0]?.entries.map((e) => e.index)).toEqual([3, 2]);
  });

  test("day labels", () => {
    expect(timelineDayLabel(NOW.getTime(), NOW)).toBe("Today");
    expect(timelineDayLabel(new Date(2026, 10, 5, 1).getTime(), NOW)).toBe("Yesterday");
  });
});

async function mountTimeline(props: Partial<TimelineProps>) {
  const selected: [unknown, number][] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <TimelineView
        props={{ timeField: "at", titleField: "title", ...props } as TimelineProps}
        onSelect={(row, index) => selected.push([row.title, index])}
        renderStatus={(value): ReactNode => <span data-testid="status">{value}</span>}
      />,
    ),
  );
  return { host, selected };
}

describe("Timeline", () => {
  const data = [
    { title: "deploy", at: "2026-11-02T10:00:00", status: "done", note: "v1.2" },
    { title: "rollback", at: "2026-11-03T10:00:00", status: "failed" },
  ];

  test("renders day groups newest first with status and description", async () => {
    const { host } = await mountTimeline({ data, statusField: "status", descriptionField: "note" });
    const days = host.querySelectorAll('[data-testid="json-render-timeline-day"]');
    expect(days.length).toBe(2);
    expect(days[0]?.textContent).toContain("rollback");
    expect(days[1]?.textContent).toContain("v1.2");
    expect([...host.querySelectorAll('[data-testid="status"]')].map((s) => s.textContent)).toEqual([
      "failed",
      "done",
    ]);
  });

  test("onSelect gets the row and its index in data", async () => {
    const { host, selected } = await mountTimeline({
      data,
      onSelect: [{ action: "app.refresh" }],
    } as Partial<TimelineProps>);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="json-render-timeline-event"] button')
        ?.click();
    });
    expect(selected).toEqual([["rollback", 1]]);
  });

  test("without onSelect events are not buttons", async () => {
    const { host } = await mountTimeline({ data });
    expect(host.querySelector('[data-testid="json-render-timeline-event"] button')).toBeNull();
  });

  test("no rows shows the empty message", async () => {
    const { host } = await mountTimeline({ data: [], emptyMessage: "Nothing happened" });
    expect(host.textContent).toContain("Nothing happened");
  });
});
