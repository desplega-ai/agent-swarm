import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SteeringMessage } from "../../api/types";

mock.module("@/components/ui/badge", () => import("../ui/badge"));
mock.module("@/components/ui/tooltip", () => import("../ui/tooltip"));
mock.module("@/lib/utils", () => import("../../lib/utils"));
const { TooltipProvider } = await import("../ui/tooltip");
const { SteeringLine, steeringSenderLabel } = await import("./steering-message-chips");
const { QueuedSteeringBox } = await import("./queued-steering-box");

const base: SteeringMessage = {
  id: "steer-1",
  taskId: "task-1",
  body: "Please check the UI",
  mode: "queue",
  status: "pending",
  source: "ui",
  createdByKind: "user",
  createdByUserId: "user-1",
  createdAt: "2026-09-23T10:00:00.000Z",
};

describe("steering sender display", () => {
  test.each([
    "Taras (user)",
    "Lead (agent)",
    "system",
  ])("shows %s in shared activity rows and collapsed queue previews", (senderLabel) => {
    const message = { ...base, senderLabel };
    const row = renderToStaticMarkup(
      <TooltipProvider>
        <SteeringLine message={message} />
      </TooltipProvider>,
    );
    expect(row).toContain(`>${senderLabel}</span>`);
    const queue = renderToStaticMarkup(<QueuedSteeringBox messages={[message]} />);
    expect(queue).toContain(`${senderLabel}: Please check the UI`);
  });

  test("older API responses retain sender kind and ID", () => {
    expect(steeringSenderLabel(base)).toBe("user-1 (user)");
    expect(
      steeringSenderLabel({ ...base, createdByKind: "agent", createdByAgentId: "agent-1" }),
    ).toBe("agent-1 (agent)");
    expect(steeringSenderLabel({ ...base, createdByKind: "system" })).toBe("system");
  });
});
