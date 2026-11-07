import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/status-labels", () => require("../../lib/status-labels"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/shared/task-status-icon", () => require("./task-status-icon"));
mock.module("@/components/shared/status-badge", () => require("./status-badge"));
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
}));

const { AgentStatusBadge, ON_DEMAND_TOOLTIP } = await import("./agent-status-badge");

describe("AgentStatusBadge", () => {
  test("an offline on-demand pool agent reads ON DEMAND with the wake tooltip", () => {
    const html = renderToStaticMarkup(
      <AgentStatusBadge agent={{ status: "offline", onDemand: true }} />,
    );
    expect(html).toContain("ON DEMAND");
    expect(html).toContain("bg-status-info");
    expect(html).toContain(ON_DEMAND_TOOLTIP);
    expect(html).not.toContain("OFFLINE");
  });

  test("a plain offline agent stays OFFLINE", () => {
    const html = renderToStaticMarkup(<AgentStatusBadge agent={{ status: "offline" }} />);
    expect(html).toContain("OFFLINE");
    expect(html).not.toContain("ON DEMAND");
  });

  test("a live agent ignores a stale onDemand flag", () => {
    const html = renderToStaticMarkup(
      <AgentStatusBadge agent={{ status: "idle", onDemand: true }} />,
    );
    expect(html).toContain("IDLE");
    expect(html).not.toContain("ON DEMAND");
  });
});
