import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "../api/types";
import type { LsEntry } from "./agent-fs/types";
import { isSessionTab, OVERVIEW_TAB, parseGroupPane, urlTabs } from "./sessions-v2";
import {
  cadenceWords,
  canHaveOverview,
  compactCron,
  formatNextRun,
  matchesScheduleSearch,
  nextRunSchedule,
  outputFiles,
  overviewQualifies,
  resolveGroupPane,
  SCHEDULE_SEARCH_FROM,
  schedulesInGroup,
  sortSchedules,
} from "./use-case-overview";

type Row = Pick<ScheduledTask, "key" | "name" | "enabled" | "nextRunAt">;

const row = (name: string, extra: Partial<Row> = {}): Row => ({
  key: "shared/po-qa/",
  name,
  enabled: true,
  ...extra,
});

describe("which groups get an Overview", () => {
  test("a user group can", () => {
    expect(canHaveOverview("shared/po-qa/")).toBe(true);
    expect(canHaveOverview("shared/acme/pricing/")).toBe(true);
    expect(canHaveOverview("personal/u1/notes/")).toBe(true);
  });

  test("sections, namespace roots, source and resource groups never do", () => {
    for (const view of ["inbox", "later", "done", "nogroup", null, "", "not-a-key"]) {
      expect(canHaveOverview(view)).toBe(false);
    }
    expect(canHaveOverview("shared/")).toBe(false);
    expect(canHaveOverview("personal/u1/")).toBe(false);
    expect(canHaveOverview("shared/slack/C123/")).toBe(false);
    expect(canHaveOverview("shared/schedule:abc/")).toBe(false);
    expect(canHaveOverview("shared/app:a1/action:send/")).toBe(false);
    expect(canHaveOverview("shared/po-qa/thread:t1/")).toBe(false);
  });

  test("a schedule or a file qualifies; unknown sources wait", () => {
    expect(overviewQualifies({ schedules: 1, files: undefined })).toBe(true);
    expect(overviewQualifies({ schedules: undefined, files: 2 })).toBe(true);
    expect(overviewQualifies({ schedules: 0, files: 0 })).toBe(false);
    expect(overviewQualifies({ schedules: 0, files: undefined })).toBe("pending");
    expect(overviewQualifies({ schedules: undefined, files: 0 })).toBe("pending");
  });

  test("the group pane: list on request, else the Overview when it qualifies", () => {
    expect(resolveGroupPane(null, true)).toBe("overview");
    expect(resolveGroupPane("overview", true)).toBe("overview");
    expect(resolveGroupPane("list", true)).toBe("list");
    expect(resolveGroupPane(null, false)).toBe("list");
    expect(resolveGroupPane("overview", false)).toBe("list");
    expect(resolveGroupPane(null, "pending")).toBe("pending");
    expect(resolveGroupPane("list", "pending")).toBe("list");
  });

  test("the Overview tab is no session tab and never lands in ?tabs= or the split", () => {
    expect(isSessionTab(OVERVIEW_TAB)).toBe(false);
    expect(parseGroupPane("overview")).toBe("overview");
    expect(parseGroupPane("list")).toBe("list");
    expect(parseGroupPane("grid")).toBeNull();
    const { tabs, split } = urlTabs(`view,${OVERVIEW_TAB},s1`, {
      focused: "view",
      view: "shared/po-qa/",
      split: OVERVIEW_TAB,
    });
    expect(tabs).toEqual(["view", "s1"]);
    expect(split).toBeNull();
  });
});

describe("schedules of a group", () => {
  test("the group's own key and a leaf right under it, not a subgroup", () => {
    const rows = [
      row("own"),
      row("leaf", { key: "shared/po-qa/schedule:s1/" }),
      row("sub", { key: "shared/po-qa/sub/" }),
      row("other", { key: "shared/other/" }),
    ];
    expect(schedulesInGroup(rows, "shared/po-qa/").map((r) => r.name)).toEqual(["own", "leaf"]);
  });

  test("the next run is the soonest enabled schedule", () => {
    const rows = [
      row("later", { nextRunAt: "2026-11-06T09:00:00Z" }),
      row("paused soon", { enabled: false, nextRunAt: "2026-11-04T10:00:00Z" }),
      row("soon", { nextRunAt: "2026-11-05T07:30:00Z" }),
      row("no next run"),
    ];
    expect(nextRunSchedule(rows)?.name).toBe("soon");
  });

  test("with every schedule paused, the bar shows the first one", () => {
    const rows = [row("a", { enabled: false }), row("b", { enabled: false })];
    expect(nextRunSchedule(rows)?.name).toBe("a");
    expect(nextRunSchedule([])).toBeUndefined();
  });

  test("the widget lists enabled by next run, then paused by name", () => {
    const rows = [
      row("zeta paused", { enabled: false }),
      row("friday", { nextRunAt: "2026-11-06T16:00:00Z" }),
      row("alpha paused", { enabled: false }),
      row("thursday", { nextRunAt: "2026-11-05T09:00:00Z" }),
    ];
    expect(sortSchedules(rows).map((r) => r.name)).toEqual([
      "thursday",
      "friday",
      "alpha paused",
      "zeta paused",
    ]);
  });

  test("search shows from 8 schedules and matches name, agent, and cadence", () => {
    expect(SCHEDULE_SEARCH_FROM).toBe(8);
    const schedule = { name: "Pricing page diff: Notion", cronExpression: "30 7 * * *" };
    expect(matchesScheduleSearch(schedule, "Researcher", "pricing")).toBe(true);
    expect(matchesScheduleSearch(schedule, "Researcher", "researcher notion")).toBe(true);
    expect(matchesScheduleSearch(schedule, "Researcher", "daily")).toBe(true);
    expect(matchesScheduleSearch(schedule, "Researcher", "writer")).toBe(false);
    expect(matchesScheduleSearch(schedule, "Researcher", "  ")).toBe(true);
  });
});

describe("cadence and time words", () => {
  test("common cron shapes read short", () => {
    expect(compactCron("0 9 * * 1,4")).toBe("Mon, Thu 09:00");
    expect(compactCron("30 7 * * *")).toBe("Daily 07:30");
    expect(compactCron("0 9 * * 1-5")).toBe("Weekdays 09:00");
    expect(compactCron("15 * * * *")).toBe("Hourly at :15");
    expect(compactCron("0 16 * * 0,5")).toBe("Fri, Sun 16:00");
    expect(compactCron("*/5 * * * *")).toBeNull();
    expect(compactCron("0 9 1 * *")).toBeNull();
  });

  test("a cron in another zone names its zone", () => {
    const schedule = { cronExpression: "0 9 * * 1,4", timezone: "UTC" };
    expect(cadenceWords(schedule, "UTC")).toBe("Mon, Thu 09:00");
    expect(cadenceWords(schedule, "Europe/Madrid")).toBe("Mon, Thu 09:00 UTC");
    expect(cadenceWords({ intervalMs: 3_600_000 }, "UTC")).toBe("Every 1h");
    expect(cadenceWords({ scheduleType: "one_time" }, "UTC")).toBe("Once");
  });

  test("the next run reads as a day and a wait", () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
    expect(formatNextRun(at(4, 17, 30), now)).toEqual({ when: "Today 17:30", in: "in 2h 30m" });
    expect(formatNextRun(at(5, 9), now)).toEqual({ when: "Tomorrow 09:00", in: "in 18h 0m" });
    expect(formatNextRun(at(7, 9), now).when).toBe("Sat 09:00");
    expect(formatNextRun(at(7, 9), now).in).toBe("in 2d 18h");
    expect(formatNextRun(at(20, 9), now).when).toBe("Nov 20 09:00");
    expect(formatNextRun(at(4, 14), now).in).toBe("now");
  });
});

describe("outputs", () => {
  test("files only, newest first", () => {
    const entries: LsEntry[] = [
      { name: "old.md", type: "file", size: 1, modifiedAt: "2026-10-30T10:00:00Z" },
      { name: "sub", type: "directory", size: 0, modifiedAt: "2026-11-05T10:00:00Z" },
      { name: "new.md", type: "file", size: 1, modifiedAt: "2026-11-04T10:00:00Z" },
      { name: "undated.md", type: "file", size: 1 },
    ];
    expect(outputFiles(entries).map((e) => e.name)).toEqual(["new.md", "old.md", "undated.md"]);
  });
});
