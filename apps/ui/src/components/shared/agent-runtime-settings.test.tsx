import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../api/types";

mock.module("@/api/hooks/use-agents", () => ({
  useUpdateAgentRuntime: () => ({ mutate: () => {}, isPending: false }),
}));
mock.module("@/api/hooks/use-config-api", () => ({
  useResolvedConfigs: () => ({ data: [] }),
}));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true, currentVersion: "1.140.0", requiredVersion: "1.77.2" }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({ data: {} }),
}));
mock.module("@/api/hooks/use-models-catalog", () => ({
  useModelsCatalog: () => ({ data: undefined }),
}));
mock.module("@/api/types", () => import("../../api/types"));
mock.module("@/components/shared/harness-icon", () => import("./harness-icon"));
mock.module("@/components/shared/provider-icon", () => import("./provider-icon"));
mock.module("@/components/shared/reasoning-effort-icon", () => import("./reasoning-effort-icon"));
mock.module("@/components/ui/button", () => import("../ui/button"));
mock.module("@/components/ui/command", () => import("../ui/command"));
mock.module("@/components/ui/dialog", () => import("../ui/dialog"));
mock.module("@/components/ui/input", () => import("../ui/input"));
mock.module("@/components/ui/label", () => import("../ui/label"));
mock.module("@/components/ui/popover", () => import("../ui/popover"));
mock.module("@/components/ui/select", () => import("../ui/select"));
mock.module("@/components/ui/switch", () => import("../ui/switch"));
mock.module("@/components/ui/tooltip", () => import("../ui/tooltip"));
mock.module("@/lib/agent-runtime-models", () => import("../../lib/agent-runtime-models"));
mock.module("@/lib/cost-format", () => import("../../lib/cost-format"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { TooltipProvider } = await import("../ui/tooltip");
const { AgentRuntimeSettings } = await import("./agent-runtime-settings");
const { HarnessCell } = await import("./harness-cell");
const { HarnessIcon } = await import("./harness-icon");

describe("AgentRuntimeSettings", () => {
  test("hides model controls for ACP", () => {
    const agent = {
      id: "agent-acp",
      name: "ACP worker",
      isLead: false,
      status: "idle",
      harnessProvider: "acp",
      createdAt: "2026-09-06T00:00:00.000Z",
      lastUpdatedAt: "2026-09-06T00:00:00.000Z",
    } satisfies Agent;

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={agent} />
      </TooltipProvider>,
    );

    expect(html).toContain("Harness");
    expect(html).not.toContain(">Model<");
    expect(html).not.toContain("Allow unsupported/custom model");
    expect(html).toContain("Save");
  });
});

describe("ACP harness presentation", () => {
  test("renders a non-blank icon", () => {
    const html = renderToStaticMarkup(<HarnessIcon harness="acp" />);

    expect(html).toContain("<svg");
    expect(html).toContain("<path");
  });

  test("renders the harness cell with its label and icon", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HarnessCell harnessProvider="acp" credStatus={null} />
      </TooltipProvider>,
    );

    expect(html).toContain("ACP");
    expect(html).toContain("<svg");
  });
});
