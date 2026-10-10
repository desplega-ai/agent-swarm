import { describe, expect, mock, test } from "bun:test";

mock.module("@/lib/utils", () => require("./utils"));

const { describeTaskEvent, TASK_EVENT_TEXT, TASK_STATUS_TONE } = await import("./task-events");
const { TASK_STATUS_TEXT, taskStatusVariant } = await import(
  "../components/shared/task-status-icon"
);

const change = (oldValue: string | undefined, newValue: string) =>
  ({ eventType: "task_status_change", oldValue, newValue }) as const;

describe("describeTaskEvent", () => {
  test("the lifecycle of a finished task reads in words", () => {
    expect(describeTaskEvent({ eventType: "task_created", newValue: "pending" })).toEqual({
      label: "Created",
      tone: "neutral",
    });
    expect(describeTaskEvent(change("pending", "in_progress"), "Lead")).toEqual({
      label: "Started by Lead",
      tone: "active",
    });
    expect(describeTaskEvent(change("in_progress", "completed"), "Lead")).toEqual({
      label: "Completed",
      tone: "success",
    });
  });

  test("an offer names its target", () => {
    expect(
      describeTaskEvent({ eventType: "task_offered", newValue: "offered" }, "worker-b"),
    ).toEqual({ label: "Offered to worker-b", tone: "active" });
    expect(describeTaskEvent({ eventType: "task_offered" }).label).toBe("Offered to an agent");
  });

  test("progress keeps its text", () => {
    expect(
      describeTaskEvent({ eventType: "task_progress", newValue: " Reading the diff " }),
    ).toEqual({ label: "Progress: Reading the diff", tone: "muted" });
    expect(describeTaskEvent({ eventType: "task_progress" }).label).toBe("Progress update");
  });

  test("cancelled is neutral, like the badge", () => {
    expect(describeTaskEvent(change("in_progress", "cancelled"))).toEqual({
      label: "Cancelled",
      tone: "neutral",
    });
  });

  test("other status changes", () => {
    expect(describeTaskEvent(change("in_progress", "failed")).tone).toBe("error");
    expect(describeTaskEvent(change("in_progress", "paused")).label).toBe("Paused");
    expect(describeTaskEvent(change("paused", "in_progress"), "Lead").label).toBe("Resumed");
    expect(describeTaskEvent(change("unassigned", "pending"), "worker-a").label).toBe(
      "Assigned to worker-a",
    );
    expect(describeTaskEvent(change("in_progress", "pending")).label).toBe("Back in the queue");
    expect(describeTaskEvent(change("draft", "pending")).label).toBe("Attachments uploaded");
    expect(describeTaskEvent(change("unassigned", "backlog")).label).toBe("Moved to the backlog");
    expect(describeTaskEvent(change("backlog", "unassigned")).label).toBe("Moved to the pool");
    expect(describeTaskEvent(change("offered", "reviewing"), "worker-b").label).toBe(
      "worker-b is reviewing the offer",
    );
  });

  test("a raw status value never shows", () => {
    const statuses = Object.keys(TASK_STATUS_TONE);
    for (const from of [undefined, ...statuses]) {
      for (const to of statuses) {
        const { label } = describeTaskEvent(change(from, to), "Lead");
        expect(label).not.toMatch(/_/);
        expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
      }
    }
  });

  test("an unknown event is named, with its value as a second line", () => {
    expect(
      describeTaskEvent({
        eventType: "task_steering" as never,
        newValue: "delivered",
      }),
    ).toEqual({ label: "Steering", detail: "delivered", tone: "muted" });
    expect(
      describeTaskEvent({ eventType: "task_superseded" as never, newValue: "superseded" }).detail,
    ).toBe("Superseded");
  });

  test("status tones match the status badge", () => {
    for (const [status, tone] of Object.entries(TASK_STATUS_TONE)) {
      const variant = taskStatusVariant(status);
      expect(variant).not.toBeNull();
      expect(TASK_EVENT_TEXT[tone]).toBe(TASK_STATUS_TEXT[variant!]);
    }
  });
});
