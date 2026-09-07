import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../api/types";

mock.module("@/api/hooks/use-agents", () => ({
  useUpdateAgentRuntime: () => ({ mutate: () => {}, isPending: false }),
}));
let resolvedConfigs: Array<{ key: string; value: string }> = [];
mock.module("@/api/hooks/use-config-api", () => ({
  useResolvedConfigs: () => ({ data: resolvedConfigs }),
}));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: (requiredVersion: string) => ({
    supported: true,
    currentVersion: "1.142.0",
    requiredVersion,
  }),
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
mock.module("@/components/ui/alert-callout", () => import("../ui/alert-callout"));
mock.module("@/components/ui/button", () => import("../ui/button"));
mock.module("@/components/ui/command", () => import("../ui/command"));
mock.module("@/components/ui/dialog", () => import("../ui/dialog"));
mock.module("@/components/ui/input", () => import("../ui/input"));
mock.module("@/components/ui/label", () => import("../ui/label"));
mock.module("@/components/ui/popover", () => import("../ui/popover"));
mock.module("@/components/ui/select", () => import("../ui/select"));
mock.module("@/components/ui/switch", () => import("../ui/switch"));
mock.module("@/components/ui/textarea", () => import("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => import("../ui/tooltip"));
mock.module("@/lib/acp-target-catalog", () => import("../../lib/acp-target-catalog"));
mock.module("@/lib/agent-runtime-models", () => import("../../lib/agent-runtime-models"));
mock.module("@/lib/cost-format", () => import("../../lib/cost-format"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { TooltipProvider } = await import("../ui/tooltip");
const { AgentRuntimeSettings, configuredAcpCommand, configuredAcpInvocation } = await import(
  "./agent-runtime-settings"
);
const { HarnessCell } = await import("./harness-cell");
const { HarnessIcon } = await import("./harness-icon");

describe("AgentRuntimeSettings", () => {
  const acpAgent = {
    id: "agent-acp",
    name: "ACP worker",
    isLead: false,
    status: "idle",
    harnessProvider: "acp",
    createdAt: "2026-09-06T00:00:00.000Z",
    lastUpdatedAt: "2026-09-06T00:00:00.000Z",
  } satisfies Agent;

  beforeEach(() => {
    resolvedConfigs = [];
  });

  test("defaults an existing unconfigured ACP agent to the custom target", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={acpAgent} />
      </TooltipProvider>,
    );

    expect(html).toContain("ACP preset");
    expect(html).toContain(">Model<");
    expect(html).toContain(">Command<");
    expect(html).toContain("Arguments");
    expect(html).toContain("Environment keys");
    expect(html).toContain("Model fallback environment key");
    expect(html).toContain("Not reported yet.");
    expect(html).not.toContain("Reasoning effort");
  });

  test("hydrates the OpenCode preset and hides custom target fields", () => {
    resolvedConfigs = [
      { key: "ACP_TARGET", value: "opencode" },
      { key: "MODEL_OVERRIDE", value: "opencode/big-pickle" },
    ];

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={acpAgent} />
      </TooltipProvider>,
    );

    expect(html).toContain("opencode/big-pickle");
    expect(html).not.toContain(">Command<");
    expect(html).not.toContain("Environment keys");
  });

  test("hydrates the legacy custom command alias", () => {
    expect(configuredAcpCommand([{ key: "ACP_COMMAND", value: "legacy-acp-agent" }])).toBe(
      "legacy-acp-agent",
    );
  });

  test("normalizes a legacy inline command so saving keeps its arguments", () => {
    expect(configuredAcpInvocation([{ key: "ACP_COMMAND", value: "opencode acp" }])).toEqual({
      command: "opencode",
      args: ["acp"],
    });
  });

  test("normalizes whitespace legacy arguments using the runtime parser semantics", () => {
    expect(
      configuredAcpInvocation([
        { key: "ACP_TARGET_COMMAND", value: "custom-agent" },
        { key: "ACP_TARGET_ARGS", value: "--acp --verbose" },
      ]),
    ).toEqual({ command: "custom-agent", args: ["--acp", "--verbose"] });
  });

  test("distinguishes an empty advertisement from no ACP report", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings
          agent={{
            ...acpAgent,
            credStatus: {
              ready: true,
              missing: [],
              reportedAt: Date.now(),
              acp: { target: "opencode", configOptions: [], reportedAt: Date.now() },
            },
          }}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("This target advertised no options.");
    expect(html).not.toContain("Not reported yet.");
  });

  test("renders advertised select and boolean options", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings
          agent={{
            ...acpAgent,
            credStatus: {
              ready: true,
              missing: [],
              reportedAt: Date.now(),
              acp: {
                target: "opencode",
                reportedAt: Date.now(),
                configOptions: [
                  {
                    type: "select",
                    id: "model",
                    name: "Model",
                    category: "model",
                    currentValue: "opencode/big-pickle",
                    options: [
                      { value: "opencode/big-pickle", name: "Big Pickle" },
                      {
                        group: "anthropic",
                        name: "Anthropic",
                        options: [{ value: "anthropic/sonnet", name: "Sonnet" }],
                      },
                    ],
                  },
                  {
                    type: "boolean",
                    id: "autoupdate",
                    name: "Auto-update",
                    currentValue: true,
                  },
                ],
              },
            },
          }}
        />
      </TooltipProvider>,
    );

    expect(html).toContain("opencode/big-pickle");
    expect(html).toContain("Available: Big Pickle, Sonnet");
    expect(html).toContain("Auto-update");
    expect(html).toContain("autoupdate");
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
