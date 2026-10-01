import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "../../api/types";

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

  test("shows a dsh agent read-only instead of as an editable Claude runtime", () => {
    resolvedConfigs = [{ key: "MODEL_OVERRIDE", value: "openrouter/deepseek/deepseek-v4.1-flash" }];
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentRuntimeSettings agent={{ ...acpAgent, harnessProvider: "dsh" }} />
      </TooltipProvider>,
    );

    expect(html).toContain("Runtime editor unavailable");
    expect(html).toContain("DeepSeek (dsh)");
    expect(html).toContain("openrouter/deepseek/deepseek-v4.1-flash");
    expect(html).not.toContain("Save");
    expect(html).not.toContain("Claude");
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
