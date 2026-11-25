import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for `PageFrame`: a literal `pageId` must be a page id,
 * a binding or an empty id passes, and `device` is desktop | mobile.
 */

const PAGE_ID = "8b8077e8b7a94dfc89c88636889a46ac";

function definition(props: Record<string, unknown>) {
  return {
    models: {},
    pages: {
      studio: {
        title: "Studio",
        params: { pageId: { kind: "string" } },
        root: "preview",
        elements: { preview: { type: "PageFrame", props } },
      },
    },
    defaultPage: "studio",
  };
}

async function issuesFor(props: Record<string, unknown>) {
  const parsed = await parseAppDefinition(definition(props));
  return parsed.success ? [] : parsed.issues.map((issue) => issue.path);
}

describe("PageFrame validation", () => {
  test("a literal id, a bound id and an empty id validate", async () => {
    expect(await issuesFor({ pageId: PAGE_ID, device: "mobile", height: "720px" })).toEqual([]);
    expect(await issuesFor({ pageId: { $state: "/route/params/pageId" }, fill: true })).toEqual([]);
    expect(await issuesFor({ pageId: "" })).toEqual([]);
  });

  test("a slug or path as a literal id is rejected", async () => {
    for (const pageId of ["my-page", "../api/keys", `${PAGE_ID}0`]) {
      expect(await issuesFor({ pageId })).toEqual(["pages.studio.elements.preview.props.pageId"]);
    }
  });

  test("device is desktop or mobile", async () => {
    const issues = await issuesFor({ pageId: PAGE_ID, device: "tablet" });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((path) => path.includes("device"))).toBe(true);
  });
});
