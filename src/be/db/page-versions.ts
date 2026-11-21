import { getStorage } from "../storage";

/**
 * The page's edit counter, `MAX(page_versions.version) + 1`, or 1 before the
 * first snapshot. Reads one indexed aggregate instead of every snapshot body:
 * loading all versions of a large, often-edited page blocked the event loop
 * for seconds per call.
 */
export async function getPageEditCounter(pageId: string): Promise<number> {
  const latest = await getStorage().repos.pages.latestPageVersion(pageId);
  return (latest ?? 0) + 1;
}
