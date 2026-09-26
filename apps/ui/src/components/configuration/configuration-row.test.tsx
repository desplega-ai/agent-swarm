import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { SwarmConfig } from "../../api/types";
import type { ConfigCatalogEntry } from "../../lib/configuration-catalog";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/api/hooks/use-agents", () => import("../../api/hooks/use-agents"));
mock.module("@/api/hooks/use-config-api", () => import("../../api/hooks/use-config-api"));
mock.module("@/components/ui/badge", () => import("../ui/badge"));
mock.module("@/components/ui/button", () => import("../ui/button"));
mock.module("@/components/ui/dropdown-menu", () => import("../ui/dropdown-menu"));
mock.module("@/components/ui/input", () => import("../ui/input"));
mock.module("@/components/ui/label", () => import("../ui/label"));
mock.module("@/components/ui/select", () => import("../ui/select"));
mock.module("@/components/ui/switch", () => import("../ui/switch"));
mock.module("@/components/ui/textarea", () => import("../ui/textarea"));
mock.module("@/components/ui/tooltip", () => import("../ui/tooltip"));
mock.module("@/hooks/use-swarm-config", () => import("../../hooks/use-swarm-config"));
mock.module("@/hooks/use-url-search-state", () => import("../../hooks/use-url-search-state"));
mock.module("@/lib/agent-color", () => import("../../lib/agent-color"));
mock.module("@/lib/config", () => import("../../lib/config"));
mock.module("@/lib/configuration-values", () => import("../../lib/configuration-values"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { TooltipProvider } = await import("../ui/tooltip");
const { ConfigurationRow } = await import("./configuration-row");

const RBAC: ConfigCatalogEntry = {
  key: "RBAC_ENABLED",
  label: "Enable RBAC",
  description: "Enforce role-based access control.",
  kind: "boolean",
  defaultValue: "true",
} as ConfigCatalogEntry;

function renderRow(saved: string | null) {
  const client = new QueryClient();
  const configs: SwarmConfig[] =
    saved === null
      ? []
      : [
          {
            id: "c1",
            scope: "global",
            scopeId: null,
            key: RBAC.key,
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
        <ConfigurationRow entry={RBAC} inEnv />
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
