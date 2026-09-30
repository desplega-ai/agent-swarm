import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { SwarmConfig } from "../../api/types";
import type { ConfigCatalogEntry } from "../../lib/configuration-catalog";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/api/hooks/use-agents", () => require("../../api/hooks/use-agents"));
mock.module("@/api/hooks/use-config-api", () => require("../../api/hooks/use-config-api"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/dropdown-menu", () => require("../ui/dropdown-menu"));
mock.module("@/components/ui/input", () => require("../ui/input"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("@/components/ui/select", () => require("../ui/select"));
mock.module("@/components/ui/switch", () => require("../ui/switch"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/hooks/use-swarm-config", () => require("../../hooks/use-swarm-config"));
mock.module("@/hooks/use-url-search-state", () => require("../../hooks/use-url-search-state"));
mock.module("@/lib/agent-color", () => require("../../lib/agent-color"));
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/lib/configuration-values", () => require("../../lib/configuration-values"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { TooltipProvider } = await import("../ui/tooltip");
const { ConfigurationRow } = await import("./configuration-row");

const RBAC: ConfigCatalogEntry = {
  key: "RBAC_ENABLED",
  label: "Enable RBAC",
  description: "Enforce role-based access control.",
  kind: "boolean",
  defaultValue: "true",
} as ConfigCatalogEntry;

function renderRow(saved: string | null, entry: ConfigCatalogEntry = RBAC, inEnv = true) {
  const client = new QueryClient();
  const configs: SwarmConfig[] =
    saved === null
      ? []
      : [
          {
            id: "c1",
            scope: "global",
            scopeId: null,
            key: entry.key,
            value: saved,
            isSecret: false,
            envPath: null,
            description: null,
            createdAt: "2026-09-26T00:00:00Z",
            lastUpdatedAt: "2026-09-26T00:00:00Z",
            encrypted: false,
          },
        ];
  client.setQueryData(["configs", { scope: "global" }], { configs });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConfigurationRow entry={entry} inEnv={inEnv} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("ConfigurationRow remove-override action", () => {
  test("a saved value equal to the catalog default can still be removed", () => {
    // Deployment env RBAC_ENABLED=false + saved "true" (the default): the saved
    // row is the only thing holding RBAC on, so removing it must stay possible.
    expect(renderRow("true")).toContain("Remove the saved value for RBAC_ENABLED");
  });

  test("a saved value that differs from the default can be removed", () => {
    expect(renderRow("false")).toContain("Remove the saved value for RBAC_ENABLED");
  });

  test("no saved value, nothing to remove", () => {
    expect(renderRow(null)).not.toContain("Remove the saved value");
  });
});

describe("ConfigurationRow model tier resolution", () => {
  const TIER: ConfigCatalogEntry = {
    key: "MODEL_TIER_CLAUDE_SMART",
    label: "claude smart tier model",
    description: "Model a claude worker runs for modelTier=smart tasks.",
    kind: "string",
    defaultValue: "opus",
    resolvesTo: { model: "claude-opus-5-5", alias: "latest:anthropic/opus", source: "tier-config" },
  };

  test("shows the concrete model, its alias and the winning layer", () => {
    const html = renderRow("latest:anthropic/opus", TIER, false);
    expect(html).toContain("claude-opus-5-5");
    expect(html).toContain("latest:anthropic/opus");
    expect(html).toContain("(configured)");
  });

  test("labels the built-in default and an alias that resolves to nothing", () => {
    const html = renderRow(
      null,
      { ...TIER, resolvesTo: { model: null, alias: null, source: "tier-default" } },
      false,
    );
    expect(html).toContain("nothing in the catalog");
    expect(html).toContain("(built-in default)");
  });

  test("says so when a configured value matched nothing and the default applies", () => {
    const html = renderRow(
      "latest:openai/nope",
      {
        ...TIER,
        resolvesTo: { model: "opus", alias: null, source: "tier-default", fellBack: true },
      },
      false,
    );
    expect(html).toContain("configured value matched nothing, built-in default");
  });

  test("rows without a resolution render no Resolves to line", () => {
    expect(renderRow(null)).not.toContain("Resolves to");
  });
});
