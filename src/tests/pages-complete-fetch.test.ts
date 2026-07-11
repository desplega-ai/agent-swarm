import { describe, expect, test } from "bun:test";
import {
  fetchAllPages,
  PAGES_BATCH_SIZE,
  type PagesBatchFilters,
} from "../../apps/ui/src/api/fetch-all-pages";
import type { PageListItem } from "../../apps/ui/src/api/types";

function page(index: number): PageListItem {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `page-${index}`,
    agentId: index === 620 ? "matching-agent" : "other-agent",
    slug: `page-${index}`,
    title: `Page ${index}`,
    contentType: "text/html",
    authMode: "public",
    body: "",
    viewCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    app_url: `/pages/page-${index}`,
    api_url: `/p/page-${index}`,
  };
}

describe("fetchAllPages", () => {
  test("loads candidates beyond the default page and endpoint batch cap", async () => {
    const source = Array.from({ length: 625 }, (_, index) => page(index));
    const calls: PagesBatchFilters[] = [];

    const result = await fetchAllPages(async (filters) => {
      calls.push(filters);
      const offset = filters.offset ?? 0;
      const limit = filters.limit ?? 50;
      return {
        pages: source.slice(offset, offset + limit),
        total: source.length,
      };
    });

    expect(calls).toEqual([
      { limit: PAGES_BATCH_SIZE, offset: 0 },
      { limit: PAGES_BATCH_SIZE, offset: PAGES_BATCH_SIZE },
    ]);
    expect(result.pages).toHaveLength(source.length);
    expect(result.pages.find((candidate) => candidate.agentId === "matching-agent")?.id).toBe(
      "page-620",
    );
    expect(result.pages.map((candidate) => candidate.id)).toEqual(
      source.map((candidate) => candidate.id),
    );
  });
});
