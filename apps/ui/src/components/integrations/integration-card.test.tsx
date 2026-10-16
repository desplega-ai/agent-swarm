import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { IntegrationDef } from "../../lib/integrations-catalog";

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/shared/brand-logo", () => require("../shared/brand-logo"));
mock.module("@/components/shared/provider-icon", () => require("../shared/provider-icon"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/card", () => require("../ui/card"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));

const { IntegrationCard } = await import("./integration-card");
const { TooltipProvider } = await import("../ui/tooltip");
const { INTEGRATIONS } = await import("../../lib/integrations-catalog");

function render(def: IntegrationDef): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <IntegrationCard def={def} status="none" />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const BASE: IntegrationDef = {
  id: "example",
  name: "Example",
  description: "An example card.",
  category: "llm",
  iconKey: "route",
  docsUrl: "https://example.com",
  fields: [],
};

describe("IntegrationCard icon", () => {
  test("a provider glyph renders the NaN glyph, not the lucide icon or a logo mask", () => {
    const html = render({ ...BASE, providerIconKey: "nan" });
    // The struck-through bar only the NaN glyph draws.
    expect(html).toContain('y="-1.5" width="2" height="27" rx="1" transform="rotate(45 12 12)"');
    expect(html).not.toContain("lucide-route");
    expect(html).not.toContain("mask-image");
  });

  test("the glyph wins over a logo file", () => {
    const html = render({ ...BASE, providerIconKey: "helmcode", logoSrc: "/provider-logos/x.svg" });
    // The wheel spoke only the Helmcode glyph draws.
    expect(html).toContain('transform="rotate(135 12 12)"');
    expect(html).not.toContain("lucide-route");
    expect(html).not.toContain("mask-image");
  });

  test("without a glyph, a logo file still renders as a mask", () => {
    const html = render({ ...BASE, logoSrc: "/provider-logos/attio.svg" });
    expect(html).toContain("mask-image:url(/provider-logos/attio.svg)");
  });

  test("without a glyph or logo, the lucide icon renders", () => {
    const html = render(BASE);
    expect(html).toContain("lucide-route");
    expect(html).not.toContain("mask-image");
  });

  test("the NaN and Helmcode cards use their glyphs and ship no logo file", () => {
    for (const id of ["nan", "helmcode"] as const) {
      const def = INTEGRATIONS.find((candidate) => candidate.id === id);
      expect(def?.providerIconKey).toBe(id);
      expect(def?.logoSrc).toBeUndefined();
      expect(def?.restartRequired).toBe(false);
      const html = render(def as IntegrationDef);
      expect(html).not.toContain("mask-image");
      expect(html).not.toContain(`lucide-${def?.iconKey}`);
    }
  });
});
