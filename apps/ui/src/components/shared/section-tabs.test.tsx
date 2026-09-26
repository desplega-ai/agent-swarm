import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

mock.module("@/lib/utils", () => import("../../lib/utils"));

const { SectionTabs } = await import("./section-tabs");

const TABS = [
  { title: "Usage", path: "/usage", end: true },
  { title: "Budgets", path: "/usage/budgets" },
  { title: "Metrics", path: "/usage/metrics" },
];

function render(path: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <SectionTabs label="Usage" tabs={TABS} activePath={path} />
    </MemoryRouter>,
  );
}

describe("SectionTabs", () => {
  test("renders every section as a link, no select", () => {
    const html = render("/usage");
    expect(html).toContain('aria-label="Usage"');
    for (const tab of TABS) expect(html).toContain(`href="${tab.path}"`);
    expect(html).not.toContain("combobox");
  });

  test("marks only the active section, and the index route is exact", () => {
    const html = render("/usage/budgets");
    const current = html.match(/<a[^>]*aria-current="page"[^>]*>/g) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/usage/budgets"');
  });
});
