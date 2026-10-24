import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, ModelProfile, ModelProfileCheckResult } from "../../api/types";

// A DOM for the interaction tests at the end; removed after this file so other
// files keep their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists
// (a static import would load it first and leave later files without events).
const { createRoot } = await import("react-dom/client");
// Radix picks a no-op layout effect when it first loads with no document.
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Every `updateRuntime.mutate` payload, oldest first. */
const saves: Array<Record<string, unknown>> = [];
/** Every `setHarnessProvider.mutate` payload (the Devin path), oldest first. */
const harnessSwitches: Array<Record<string, unknown>> = [];
// Mocks of shared modules keep every export of the real module: in one `bun test`
// process the first file to register a specifier fixes its export names, and a
// later file importing another name fails to link.
// The real hook modules import the API client, which reads `@/lib/config`.
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/api/hooks/use-agents", () => ({
  ...require("../../api/hooks/use-agents"),
  useAgentRuntime: () => ({ data: runtimeMetadata, isError: runtimeError }),
  useUpdateAgentRuntime: () => ({
    mutate: (input: Record<string, unknown>) => {
      saves.push(input);
    },
    isPending: false,
  }),
  useSetAgentHarnessProvider: () => ({
    mutate: (input: Record<string, unknown>) => {
      harnessSwitches.push(input);
    },
    isPending: false,
  }),
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
  ...require("../../api/hooks/use-config-api"),
  useResolvedConfigs: () => ({ data: resolvedConfigs }),
}));
/** What `useModelProfiles` lists; empty hides the picker. */
let modelProfiles: ModelProfile[] = [];
/** `useModelProfileCheck` results by profile name. */
let modelProfileChecks: Record<string, ModelProfileCheckResult> = {};
mock.module("@/api/hooks/use-model-profiles", () => ({
  ...require("../../api/hooks/use-model-profiles"),
  useModelProfiles: ({ harness }: { harness?: string } = {}) => ({
    data: modelProfiles.filter((profile) => !harness || profile.harness === harness),
  }),
  useModelProfileCheck: (_agentId: string, profile: string | null | undefined) => ({
    data: profile ? modelProfileChecks[profile] : undefined,
    isLoading: false,
    isError: false,
  }),
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
mock.module("@/api/types", () => require("../../api/types"));
mock.module("@/components/shared/harness-icon", () => require("./harness-icon"));
mock.module("@/components/shared/model-combobox", () => require("./model-combobox"));
mock.module("@/components/shared/model-effort-label", () => require("./model-effort-label"));
mock.module("@/components/shared/provider-icon", () => require("./provider-icon"));
mock.module("@/components/shared/reasoning-effort-icon", () => require("./reasoning-effort-icon"));
mock.module("@/components/ui/alert-callout", () => require("../ui/alert-callout"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/command", () => require("../ui/command"));
mock.module("@/components/ui/dialog", () => require("../ui/dialog"));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("@/components/ui/popover", () => require("../ui/popover"));
mock.module("@/components/ui/select", () => require("../ui/select"));
mock.module("@/components/ui/switch", () => require("../ui/switch"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/lib/acp-target-catalog", () => require("../../lib/acp-target-catalog"));
mock.module("@/lib/agent-runtime-models", () => require("../../lib/agent-runtime-models"));
mock.module("@/lib/cost-format", () => require("../../lib/cost-format"));
mock.module("@/lib/model-vendor", () => require("../../lib/model-vendor"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

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
    saves.length = 0;
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

  test("shows a cloud harness read-only instead of as an editable Claude runtime", () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "managed-model" }];
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "claude-managed" }} />
      </TooltipProvider>,
    );

    expect(html).toContain("Runtime editor unavailable");
    expect(html).toContain("managed-model");
    expect(html).not.toContain("Save");
  });

  test("edits a Devin agent's harness without model or effort controls", () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "devin-model" }];
    envPresence = { DEVIN_API_KEY: true, DEVIN_ORG_ID: false };
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "devin" }} />
      </TooltipProvider>,
    );

    expect(html).not.toContain("Runtime editor unavailable");
    expect(html).toContain("Devin");
    expect(html).toContain("Save");
    expect(html).toContain("devin-model");
    expect(html).toContain("Not set in swarm config: DEVIN_ORG_ID.");
    expect(html).not.toContain("Reasoning effort");
    expect(html).not.toContain("Allow unsupported/custom model");
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

  test("flags Claude agents on the SDK transport and stays quiet for CLI or other harnesses", () => {
    const sdk = renderToStaticMarkup(
      <TooltipProvider>
        <HarnessCell harnessProvider="claude" credStatus={null} claudeTransport="sdk" />
      </TooltipProvider>,
    );
    expect(sdk).toContain('data-testid="harness-transport-chip"');

    const cli = renderToStaticMarkup(
      <TooltipProvider>
        <HarnessCell harnessProvider="claude" credStatus={null} claudeTransport="cli" />
      </TooltipProvider>,
    );
    expect(cli).not.toContain('data-testid="harness-transport-chip"');

    const codex = renderToStaticMarkup(
      <TooltipProvider>
        <HarnessCell harnessProvider="codex" credStatus={null} claudeTransport="sdk" />
      </TooltipProvider>,
    );
    expect(codex).not.toContain('data-testid="harness-transport-chip"');
  });
});

// --- Reasoning effort: the picker offers what the harness and model accept ---

const cliRuntime = {
  claude: {
    transport: null,
    effectiveTransport: "cli" as const,
    inheritedTransport: "cli" as const,
    bridgeEffective: false,
  },
};
const ALL_KEYS = {
  ANTHROPIC_API_KEY: true,
  OPENAI_API_KEY: true,
  OPENROUTER_API_KEY: true,
  DEEPSEEK_API_KEY: true,
};

async function mountSettings(harness: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <AgentRuntimeSettings
          agent={
            {
              id: "agent-1",
              name: "Worker",
              isLead: false,
              status: "idle",
              harnessProvider: harness,
              createdAt: "",
              lastUpdatedAt: "",
            } as Agent
          }
        />
      </TooltipProvider>,
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** The segments of the Reasoning effort control, by label. */
function effortSegments(container: HTMLElement): Record<string, HTMLButtonElement> {
  const label = [...container.querySelectorAll("label")].find(
    (l) => l.textContent === "Reasoning effort",
  );
  const buttons = [...(label?.parentElement?.querySelectorAll("button") ?? [])];
  return Object.fromEntries(buttons.map((b) => [b.textContent?.trim() ?? "", b]));
}

const enabled = (container: HTMLElement) =>
  Object.entries(effortSegments(container))
    .filter(([, button]) => !button.disabled)
    .map(([name]) => name);

const active = (container: HTMLElement) =>
  Object.entries(effortSegments(container))
    .filter(([, button]) => button.className.includes("bg-primary"))
    .map(([name]) => name);

async function click(element: Element | undefined | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Pick an option of a Radix select by the trigger's current text. */
async function pickSelect(container: HTMLElement, triggerText: string, optionText: string) {
  const trigger = [...container.querySelectorAll('button[role="combobox"]')].find((b) =>
    b.textContent?.includes(triggerText),
  );
  await click(trigger);
  await click(
    [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes(optionText),
    ),
  );
}

/** Pick a model in the model combobox (the trigger shows `current`). */
async function pickModel(container: HTMLElement, current: string, next: string) {
  const trigger = [...container.querySelectorAll("button[aria-expanded]")].find((b) =>
    b.textContent?.includes(current),
  );
  await click(trigger);
  await click(
    [...document.querySelectorAll("[cmdk-item]")].find((item) => item.textContent?.includes(next)),
  );
}

async function save(container: HTMLElement) {
  await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Save"));
}

describe("AgentRuntimeSettings Devin harness", () => {
  beforeEach(() => {
    resolvedConfigs = [];
    runtimeMetadata = cliRuntime;
    runtimeError = false;
    envPresence = ALL_KEYS;
    saves.length = 0;
    harnessSwitches.length = 0;
    document.body.innerHTML = "";
  });

  test("switching a worker to Devin saves through the harness-provider path only", async () => {
    const view = await mountSettings("claude");
    await pickSelect(view.container, "Claude", "Devin");
    expect(view.container.textContent).toContain("Devin runs in Cognition");
    expect(view.container.textContent).not.toContain("Reasoning effort");
    expect(view.container.textContent).not.toContain("requires a missing provider key");
    expect(view.container.textContent).not.toContain("per 1M tokens");
    await save(view.container);
    expect(harnessSwitches).toEqual([{ id: "agent-1", harnessProvider: "devin" }]);
    expect(saves).toEqual([]);
    await view.unmount();
  });

  test("switching a Devin agent back to a local harness uses the runtime editor", async () => {
    const view = await mountSettings("devin");
    await pickSelect(view.container, "Devin", "Codex");
    await save(view.container);
    expect(harnessSwitches).toEqual([]);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.harnessProvider).toBe("codex");
    await view.unmount();
  });
});

describe("AgentRuntimeSettings reasoning effort", () => {
  beforeEach(() => {
    resolvedConfigs = [];
    runtimeMetadata = cliRuntime;
    runtimeError = false;
    envPresence = ALL_KEYS;
    saves.length = 0;
    document.body.innerHTML = "";
  });

  test("offers exactly the levels of the model, and Auto", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "claude-haiku-4-5" }];
    const view = await mountSettings("claude");
    // Haiku 4.5 has a thinking budget: off, but no x-high.
    expect(enabled(view.container)).toEqual(["Auto", "Off", "Low", "Medium", "High"]);
    await view.unmount();
  });

  test("a Claude shortname resolves to its model's levels", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "opus" }];
    const view = await mountSettings("claude");
    expect(enabled(view.container)).toEqual(["Auto", "Low", "Medium", "High", "X-High"]);
    await view.unmount();
  });

  test("Codex on a GPT-5.6 model takes max", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "gpt-5.6-sol" }];
    const view = await mountSettings("codex");
    expect(enabled(view.container)).toEqual([
      "Auto",
      "Off",
      "Low",
      "Medium",
      "High",
      "X-High",
      "Max",
    ]);
    await view.unmount();
  });

  test("a dsh agent edits its model and the efforts dsh honours on OpenRouter", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "openrouter/deepseek/deepseek-v4.1-flash" }];
    const view = await mountSettings("dsh");
    expect(view.container.textContent).toContain("DeepSeek (dsh)");
    expect(view.container.textContent).not.toContain("Runtime editor unavailable");
    // OpenRouter sends no reasoning field for an undeclared `off`, so it is not offered.
    expect(enabled(view.container)).toEqual(["Auto", "Low", "High", "Max"]);
    await click(effortSegments(view.container).High);
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({
      harnessProvider: "dsh",
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      reasoningEffort: "high",
    });
    await view.unmount();
  });

  test("a dsh agent on the direct DeepSeek API can turn thinking off", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "deepseek-v4-pro" }];
    const view = await mountSettings("dsh");
    expect(enabled(view.container)).toEqual(["Auto", "Off", "High", "Max"]);
    await view.unmount();
  });

  test("a custom or unlisted model offers only Auto and says why", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "my-custom-model" }];
    const view = await mountSettings("claude");
    expect(enabled(view.container)).toEqual(["Auto"]);
    expect(view.container.textContent).toContain("No reasoning effort applies to this model");
    await view.unmount();
  });

  test("saves a model the catalog lists without the custom flag, and one it lacks with it", async () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "claude-opus-5-5" }];
    const listed = await mountSettings("claude");
    await save(listed.container);
    expect(saves.at(-1)).toMatchObject({ model: "claude-opus-5-5", allowCustomModel: false });
    await listed.unmount();

    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "my-custom-model" }];
    const custom = await mountSettings("claude");
    await save(custom.container);
    expect(saves.at(-1)).toMatchObject({ model: "my-custom-model", allowCustomModel: true });
    await custom.unmount();
  });

  test("a stored effort the model cannot take is neither shown nor saved", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-haiku-4-5" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "xhigh" },
    ];
    const view = await mountSettings("claude");
    expect(active(view.container)).toEqual(["Auto"]);
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({ harnessProvider: "claude", reasoningEffort: null });
    await view.unmount();
  });

  test("switching the harness resets an effort the new harness cannot take", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-opus-5-5" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "xhigh" },
    ];
    const view = await mountSettings("claude");
    expect(active(view.container)).toEqual(["X-High"]);
    // Pi lands on its default OpenRouter model, which has no x-high.
    await pickSelect(view.container, "Claude", "Pi-Mono");
    expect(active(view.container)).toEqual(["Auto"]);
    expect(enabled(view.container)).not.toContain("X-High");
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({ harnessProvider: "pi", reasoningEffort: null });
    await view.unmount();
  });

  test("switching the harness keeps an effort the new pair still takes", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-opus-5-5" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high" },
    ];
    const view = await mountSettings("claude");
    await pickSelect(view.container, "Claude", "Codex");
    expect(active(view.container)).toEqual(["High"]);
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({ harnessProvider: "codex", reasoningEffort: "high" });
    await view.unmount();
  });

  test("switching to a harness without effort control clears it", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-opus-5-5" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high" },
    ];
    const view = await mountSettings("claude");
    await pickSelect(view.container, "Claude", "ACP");
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({ harnessProvider: "acp", reasoningEffort: null });
    await view.unmount();
  });

  test("switching the model resets an effort the new model cannot take", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-opus-5-5" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "xhigh" },
    ];
    const view = await mountSettings("claude");
    expect(active(view.container)).toEqual(["X-High"]);
    await pickModel(view.container, "Claude Opus 5.5", "Claude Haiku 4.5");
    expect(active(view.container)).toEqual(["Auto"]);
    expect(enabled(view.container)).toEqual(["Auto", "Off", "Low", "Medium", "High"]);
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({ model: "claude-haiku-4-5", reasoningEffort: null });
    await view.unmount();
  });

  test("switching the model keeps an effort the new model takes", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-haiku-4-5" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high" },
    ];
    const view = await mountSettings("claude");
    await pickModel(view.container, "Claude Haiku 4.5", "Claude Opus 5.5");
    expect(active(view.container)).toEqual(["High"]);
    await view.unmount();
  });
});

// --- Model profile picker: a profile sets the model and effort ---

function modelProfileRow(
  name: string,
  model: string,
  effort: ModelProfile["effort"],
): ModelProfile {
  return {
    id: `profile-${name}`,
    name,
    harness: "claude",
    model,
    effort,
    allowCustomModel: false,
    description: null,
    seededFrom: null,
    credentials: null,
    createdAt: "",
    lastUpdatedAt: "",
  };
}

const saveButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Save");

describe("AgentRuntimeSettings model profile", () => {
  beforeEach(() => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "claude-haiku-4-5" }];
    runtimeMetadata = cliRuntime;
    runtimeError = false;
    envPresence = ALL_KEYS;
    saves.length = 0;
    document.body.innerHTML = "";
    modelProfiles = [
      modelProfileRow("claude-smart", "claude-opus-5-5", "high"),
      modelProfileRow("claude-broken", "claude-opus-5-5", null),
    ];
    modelProfileChecks = {
      "claude-smart": {
        agentId: "agent-1",
        ok: true,
        profiles: [
          {
            name: "claude-smart",
            ok: true,
            checks: [
              { check: "harness", state: "pass" },
              { check: "model", state: "pass" },
              {
                check: "harness-credentials",
                state: "unverified",
                detail: "the agent has not reported credentials yet",
              },
            ],
          },
        ],
      },
      "claude-broken": {
        agentId: "agent-1",
        ok: false,
        profiles: [
          {
            name: "claude-broken",
            ok: false,
            checks: [
              { check: "harness", state: "pass" },
              {
                check: "harness-credentials",
                state: "fail",
                detail: "ANTHROPIC_API_KEY is missing",
              },
            ],
          },
        ],
      },
    };
  });
  afterAll(() => {
    modelProfiles = [];
    modelProfileChecks = {};
  });

  test("picking a profile disables the model controls and shows its model and effort", async () => {
    const view = await mountSettings("claude");
    await pickSelect(view.container, "None (set model below)", "claude-smart");
    const modelTrigger = [...view.container.querySelectorAll("button[aria-expanded]")].find((b) =>
      b.textContent?.includes("Claude Opus 5.5"),
    ) as HTMLButtonElement | undefined;
    expect(modelTrigger?.disabled).toBe(true);
    expect(enabled(view.container)).toEqual([]);
    expect(active(view.container)).toEqual(["High"]);
    expect(view.container.querySelector('button[role="switch"]')?.hasAttribute("disabled")).toBe(
      true,
    );
    // Warnings and unverified rows are notes, not blockers.
    expect(view.container.textContent).toContain(
      "Credentials: the agent has not reported credentials yet",
    );
    expect(saveButton(view.container)?.disabled).toBe(false);
    await view.unmount();
  });

  test("save sends the profile with no model, custom flag or effort", async () => {
    const view = await mountSettings("claude");
    await pickSelect(view.container, "None (set model below)", "claude-smart");
    await save(view.container);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      id: "agent-1",
      harnessProvider: "claude",
      profile: "claude-smart",
    });
    expect(saves[0]).not.toHaveProperty("model");
    expect(saves[0]).not.toHaveProperty("allowCustomModel");
    expect(saves[0]).not.toHaveProperty("reasoningEffort");
    await view.unmount();
  });

  test("a failing check shows why and disables Save", async () => {
    const view = await mountSettings("claude");
    await pickSelect(view.container, "None (set model below)", "claude-broken");
    expect(view.container.textContent).toContain("This agent cannot run the profile");
    expect(view.container.textContent).toContain("Credentials: ANTHROPIC_API_KEY is missing");
    expect(saveButton(view.container)?.disabled).toBe(true);
    await save(view.container);
    expect(saves).toEqual([]);
    await view.unmount();
  });

  test("None on an agent with a saved profile sends the model, which clears it", async () => {
    resolvedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-haiku-4-5" },
      { key: "MODEL_PROFILE", value: "claude-smart" },
    ];
    const view = await mountSettings("claude");
    await pickSelect(view.container, "claude-smart", "None (set model below)");
    await save(view.container);
    expect(saves.at(-1)).toMatchObject({ harnessProvider: "claude", model: "claude-haiku-4-5" });
    expect(saves.at(-1)).not.toHaveProperty("profile");
    await view.unmount();
  });

  test("a harness switch drops a profile that runs on the old harness", async () => {
    const view = await mountSettings("claude");
    await pickSelect(view.container, "None (set model below)", "claude-smart");
    await pickSelect(view.container, "Claude", "Codex");
    await save(view.container);
    expect(saves.at(-1)?.harnessProvider).toBe("codex");
    expect(saves.at(-1)).not.toHaveProperty("profile");
    expect(saves.at(-1)).toHaveProperty("model");
    await view.unmount();
  });
});
