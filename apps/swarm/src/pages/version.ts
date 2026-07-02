import { createPageVersion, getPage, getPageVersions } from "../be/db";
import type { PageSnapshot, PageVersion } from "../types";

/**
 * Create a version snapshot of a page's current state.
 *
 * Call this BEFORE applying an update to preserve the pre-update state.
 * Mirrors `snapshotWorkflow` (src/workflows/version.ts:13-44).
 *
 * 1. Load current page state
 * 2. Get max version number for this page (page_versions ORDER BY version DESC)
 * 3. Insert page_versions row with version+1 and the pre-update snapshot
 *
 * Throws on missing parent. Callers in HTTP handlers wrap this in a try/catch
 * with an empty catch — snapshot failure should not block the update (matches
 * the workflow pattern at src/http/workflows.ts:483-486).
 */
export function snapshotPage(pageId: string, changedByAgentId?: string): PageVersion {
  const page = getPage(pageId);
  if (!page) {
    throw new Error(`Page ${pageId} not found — cannot create snapshot`);
  }

  const existingVersions = getPageVersions(pageId);
  const maxVersion = existingVersions.length > 0 ? existingVersions[0]!.version : 0;
  const nextVersion = maxVersion + 1;

  const snapshot: PageSnapshot = {
    title: page.title,
    description: page.description,
    contentType: page.contentType,
    authMode: page.authMode,
    passwordHash: page.passwordHash,
    body: page.body,
    needsCredentials: page.needsCredentials,
  };

  return createPageVersion({
    pageId,
    version: nextVersion,
    snapshot,
    changedByAgentId,
  });
}
