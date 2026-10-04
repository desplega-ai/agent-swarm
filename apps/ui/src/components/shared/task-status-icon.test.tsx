import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/utils", () => require("../../lib/utils"));

const { ProgressRing, TASK_STATUS_TEXT, TaskStatusIcon, taskStatusVariant } = await import(
  "./task-status-icon"
);

// Every lifecycle status the dashboard types: tasks, workflow runs and steps,
// script runs, approval requests. A status added to a union without a mapping
// here would silently fall back to the plain ring.
const LIFECYCLE_STATUSES = [
  "draft",
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "aborted_limit",
  "running",
  "waiting",
  "skipped",
  "approved",
  "rejected",
  "timeout",
];

describe("taskStatusVariant", () => {
  test("maps every lifecycle status", () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(taskStatusVariant(status)).not.toBeNull();
    }
  });

  test("the four reference states", () => {
    expect(taskStatusVariant("pending")).toBe("pending");
    expect(taskStatusVariant("in_progress")).toBe("active");
    expect(taskStatusVariant("completed")).toBe("done");
  });

  test("agent and service health are not lifecycle statuses", () => {
    for (const status of ["idle", "busy", "offline", "healthy", "unhealthy", "stopped"]) {
      expect(taskStatusVariant(status)).toBeNull();
    }
  });

  test("every variant has a label color", () => {
    for (const status of LIFECYCLE_STATUSES) {
      const variant = taskStatusVariant(status);
      expect(variant && TASK_STATUS_TEXT[variant]).toBeTruthy();
    }
  });
});

describe("TaskStatusIcon", () => {
  test("a completed task is a filled disc with a white check", () => {
    const html = renderToStaticMarkup(<TaskStatusIcon status="completed" />);
    expect(html).toContain('data-variant="done"');
    expect(html).toContain("text-status-success-solid");
    expect(html).toContain("stroke-white");
  });

  test("an in-progress task turns, and holds still under reduced motion", () => {
    const html = renderToStaticMarkup(<TaskStatusIcon status="in_progress" />);
    expect(html).toContain('data-variant="active"');
    expect(html).toContain("animate-[spin_3s_linear_infinite]");
    expect(html).toContain("motion-reduce:animate-none");
  });

  test("only the active icon animates", () => {
    for (const status of LIFECYCLE_STATUSES.filter((s) => taskStatusVariant(s) !== "active")) {
      expect(renderToStaticMarkup(<TaskStatusIcon status={status} />)).not.toContain("animate-");
    }
  });

  test("an unknown status falls back to the plain ring", () => {
    expect(renderToStaticMarkup(<TaskStatusIcon status="nope" />)).toContain(
      'data-variant="pending"',
    );
  });

  test("decorative without a label, named with one", () => {
    expect(renderToStaticMarkup(<TaskStatusIcon status="failed" />)).toContain(
      'aria-hidden="true"',
    );
    const named = renderToStaticMarkup(<TaskStatusIcon status="failed" label="Failed" />);
    expect(named).toContain('role="img"');
    expect(named).toContain("<title>Failed</title>");
  });
});

describe("ProgressRing", () => {
  test("1 of 4 draws a quarter arc", () => {
    const html = renderToStaticMarkup(<ProgressRing done={1} total={4} />);
    expect(html).toContain('data-slot="progress-ring"');
    expect(html).toContain('stroke-dasharray="25 75"');
    expect(html).toContain('aria-label="1 of 4 done"');
  });

  test("nothing done is the pending ring, everything done is the done disc", () => {
    expect(renderToStaticMarkup(<ProgressRing done={0} total={4} />)).toContain(
      'data-variant="pending"',
    );
    expect(renderToStaticMarkup(<ProgressRing done={4} total={4} />)).toContain(
      'data-variant="done"',
    );
    expect(renderToStaticMarkup(<ProgressRing done={0} total={0} />)).toContain(
      'data-variant="pending"',
    );
  });

  test("done above total clamps to the done disc", () => {
    expect(renderToStaticMarkup(<ProgressRing done={9} total={4} />)).toContain(
      'data-variant="done"',
    );
  });
});
