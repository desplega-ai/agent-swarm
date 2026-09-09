import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../api/types";

mock.module("@/api/hooks/use-agents", () => ({
  useAgentRuntime: () => ({ data: runtimeMetadata, isError: runtimeError }),
  useUpdateAgentRuntime: () => ({ mutate: () => {}, isPending: false }),
}));
let resolvedConfigs: Array<{ key: string; value: string }> = [];
let runtimeMetadata:
  | {
      claude: {
        transport: "cli" | "sdk" | null;
        effectiveTransport: "cli" | "sdk";
        inheritedTransport: "cli" | "sdk";
        bridgeEffective: boolean;
      };
    }
  | null
  | undefined;
let runtimeError = false;
let envPresence: Record<string, boolean> = {};
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
  useEnvPresence: () => ({ data: envPresence }),
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
const { modelGroupsForAcpTarget } = await import("../../lib/agent-runtime-models");

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
    runtimeMetadata = undefined;
    runtimeError = false;
    envPresence = {};
  });

  test("shows the inherited Claude transport and future-session guidance", () => {
    runtimeMetadata = {
      claude: {
        transport: null,
        effectiveTransport: "sdk",
        inheritedTransport: "sdk",
        bridgeEffective: false,
      },
    };
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "claude" }} />
      </TooltipProvider>,
    );

    expect(html).toContain("Transport");
    expect(html).toContain("Inherit (SDK)");
    expect(html).toContain("future Claude sessions");
  });

  test("shows the configured Bridge conflict for an effective SDK selection", () => {
    runtimeMetadata = {
      claude: {
        transport: "sdk",
        effectiveTransport: "sdk",
        inheritedTransport: "cli",
        bridgeEffective: true,
      },
    };
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "claude" }} />
      </TooltipProvider>,
    );

    expect(html).toContain("SDK conflicts with the Claude Bridge configuration");
    expect(html).toContain('aria-invalid="true"');
  });

  test("blocks Claude saves when runtime metadata is unavailable", () => {
    runtimeError = true;
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "claude" }} />
      </TooltipProvider>,
    );

    expect(html).toContain("Transport settings are unavailable");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Save/s);
  });

  test("allows model saves when an older API lacks Claude transport support", () => {
    runtimeMetadata = null;
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "claude-haiku-4-5" }];
    envPresence = { CLAUDE_CODE_OAUTH_TOKEN: true };
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "claude" }} />
      </TooltipProvider>,
    );

    expect(html).toContain("Claude transport requires a newer API");
    expect(html).toMatch(/<button(?=[^>]*aria-label="Claude transport")(?=[^>]*disabled="")[^>]*>/);
    const saveEnd = html.indexOf("Save</button>");
    const saveStart = html.lastIndexOf("<button", saveEnd);
    expect(html.slice(saveStart, html.indexOf(">", saveStart))).not.toContain(' disabled=""');
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
    expect(html).not.toContain(">Transport<");
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

  test("offers models.dev suggestions for OpenCode but not unknown custom targets", () => {
    const opencodeGroups = modelGroupsForAcpTarget("opencode");

    expect(
      opencodeGroups
        .flatMap((group) => group.models)
        .some((model) => model.id === "opencode/big-pickle"),
    ).toBe(true);
    expect(modelGroupsForAcpTarget("custom")).toEqual([]);
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
