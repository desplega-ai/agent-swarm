import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTask } from "../../../api/types";

// The root-level test run cannot resolve ui's `@/` alias. Plain lib utils map
// to their real modules; the expanded outcome and the timestamp are stubbed.
mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/lib/markdown-preview", () => require("../../../lib/markdown-preview"));
mock.module("@/lib/prompt-display", () => require("../../../lib/prompt-display"));
mock.module("@/lib/task-reason", () => require("../../../lib/task-reason"));
mock.module("@/components/ui/badge", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span data-slot="badge">{children}</span>,
}));
mock.module("@/components/shared/animated-reveal", () => ({ AnimatedReveal: () => null }));
mock.module("@/components/sessions/task-outcome", () => ({ TaskOutcome: () => null }));
mock.module("./swarm-reply", () => ({ MessageTime: () => null }));

const { InternalLine } = await import("./internal-line");

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: "t1",
    task: "Answer the thread",
    status: "completed",
    createdAt: "2026-10-29T12:00:00.000Z",
    ...overrides,
  } as AgentTask;
}

function badgeOf(html: string): string | undefined {
  return html.match(/<span data-slot="badge">([^<]*)<\/span>/)?.[1];
}

describe("InternalLine", () => {
  test("a skipped follow-up's collapsed row is labeled Skipped next to its reason", () => {
    const html = renderToStaticMarkup(
      <InternalLine
        task={task({
          taskType: "follow-up",
          status: "skipped",
          failureReason: "Already answered.",
        })}
      />,
    );
    expect(badgeOf(html)).toBe("Skipped");
    expect(html).toContain("Already answered.");
  });

  test("a skipped deferral wake-up is labeled Skipped, not Deferred", () => {
    const html = renderToStaticMarkup(
      <InternalLine
        task={task({ taskType: "deferred", status: "skipped", failureReason: "Nothing to do." })}
      />,
    );
    expect(badgeOf(html)).toBe("Skipped");
  });

  test("failed and completed follow-ups keep their type label", () => {
    const failed = renderToStaticMarkup(
      <InternalLine
        task={task({ taskType: "follow-up", status: "failed", failureReason: "Boom." })}
      />,
    );
    expect(badgeOf(failed)).toBe("Follow-up");
    expect(failed).toContain("Boom.");
    const done = renderToStaticMarkup(
      <InternalLine task={task({ taskType: "follow-up", output: "Done." })} />,
    );
    expect(badgeOf(done)).toBe("Follow-up");
  });
});
