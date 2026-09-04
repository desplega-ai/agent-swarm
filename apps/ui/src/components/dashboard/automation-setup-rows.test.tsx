import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { StatusAutomation } from "@/api/types";
import { AutomationSetupRows } from "./automation-setup-rows";

describe("AutomationSetupRows", () => {
  test("shows every automation name and per-gap action without a disclosure", () => {
    const automations: StatusAutomation[] = [
      {
        id: "gsc-topic-miner",
        name: "gsc-topic-miner",
        kind: "workflow",
        state: "needs_setup",
        missing: { params: ["GSC_PROPERTY"], integrations: ["gsc", "agentfs"] },
        fixes: [
          {
            type: "param",
            key: "GSC_PROPERTY",
            url: "/workflows/gsc-topic-miner?param=GSC_PROPERTY",
          },
          { type: "integration", key: "gsc", url: "/settings/integrations/gsc" },
          { type: "integration", key: "agentfs", url: "/settings/integrations/agentfs" },
        ],
        fixUrl: "/settings/integrations/gsc",
      },
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AutomationSetupRows automations={automations} />
      </MemoryRouter>,
    );

    expect(html).toContain("Google Search Console Topic Miner");
    expect(html).toContain('href="/workflows/gsc-topic-miner?param=GSC_PROPERTY"');
    expect(html).toContain("Set a Google Search Console property");
    expect(html).toContain('href="/settings/integrations/gsc"');
    expect(html).toContain("Connect Google Search Console");
    expect(html).toContain('href="/settings/integrations/agentfs"');
    expect(html).toContain("Connect AgentFS");
    expect(html).not.toContain("<details");
  });
});
