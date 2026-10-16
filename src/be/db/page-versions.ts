import { getDbClient } from "./runtime";

/**
 * The page's edit counter, `MAX(page_versions.version) + 1`, or 1 before the
 * first snapshot. Reads one indexed aggregate instead of every snapshot body:
 * loading all versions of a large, often-edited page blocked the event loop
 * for seconds per call.
 */
export async function getPageEditCounter(pageId: string): Promise<number> {
  const row = await getDbClient().get<{ latest: number | null }>(
    "SELECT MAX(version) AS latest FROM page_versions WHERE pageId = ?",
    [pageId],
  );
  return (row?.latest ?? 0) + 1;
}
