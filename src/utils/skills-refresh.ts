/**
 * Worker-side per-task skill refresh.
 *
 * Polls the cheap signature endpoint; on a hash mismatch, refetches the
 * full skill list and writes SKILL.md files to the worker's local HOME via
 * writeSkillsToFilesystem() from skill-fs-writer.ts. This ensures newly
 * created/approved skills land on the worker disk mid-session — no container
 * restart required.
 *
 * Previously Step 3 POSTed to /api/skills/sync-filesystem, which wrote to
 * the API server's HOME instead of the worker disk. Now Step 3 builds
 * SkillFsEntry[] from the already-fetched skill data and writes locally.
 * For complex skills the worker fetches bundled files via N+1 HTTP calls
 * (acceptable for v1 — simple skills need zero extra fetches).
 *
 * The /api/skills/sync-filesystem endpoint is retained for single-box local
 * dev (where API and worker share a HOME). Workers no longer call it.
 *
 * Transient errors are swallowed (returned as `changed: false`) so a flaky
 * API can't churn the system prompt.
 */

import { homedir } from "node:os";
import { type SkillFsEntry, writeSkillsToFilesystem } from "./skill-fs-writer";

export type SkillsRefreshContext = {
  apiUrl: string;
  swarmUrl: string;
  apiKey: string;
  agentId: string;
  role: string;
};

export type SkillsRefreshResult = {
  changed: boolean;
  summary?: { name: string; description: string }[];
};

export async function refreshSkillsIfChanged(
  ctx: SkillsRefreshContext,
  lastHashRef: { current: string | null },
  homeOverride?: string,
): Promise<SkillsRefreshResult> {
  const { apiUrl, apiKey, agentId, role } = ctx;
  const authHeaders: Record<string, string> = { "X-Agent-ID": agentId };
  if (apiKey) authHeaders.Authorization = `Bearer ${apiKey}`;

  // Step 1: cheap signature probe
  try {
    const sigResp = await fetch(`${apiUrl}/api/agents/${agentId}/skills/signature`, {
      headers: authHeaders,
    });
    if (sigResp.ok) {
      const sig = (await sigResp.json()) as { hash: string };
      if (lastHashRef.current !== null && sig.hash === lastHashRef.current) {
        return { changed: false };
      }
    } else if (sigResp.status >= 500) {
      // Transient — don't churn the prompt on a flaky API
      return { changed: false };
    }
    // 4xx falls through (e.g. fresh worker hitting a legacy server without
    // the signature endpoint yet) — let the list call drive the result.
  } catch {
    return { changed: false };
  }

  // Step 2: full fetch (only reached when hash differs or first call)
  // Keep the full skill rows including content, id, isComplex — data is
  // already on the wire, was previously discarded.
  type SkillRow = {
    id: string;
    name: string;
    description: string;
    content: string | null;
    isComplex: boolean;
    isEnabled: boolean;
    isActive: boolean;
  };
  let skillRows: SkillRow[] = [];
  let newHash: string | null = null;
  let listFetchOk = false;
  try {
    const skillsResp = await fetch(`${apiUrl}/api/agents/${agentId}/skills`, {
      headers: authHeaders,
    });
    if (skillsResp.ok) {
      const skillsData = (await skillsResp.json()) as {
        skills: SkillRow[];
        signature?: string;
      };
      skillRows = skillsData.skills;
      if (typeof skillsData.signature === "string") {
        newHash = skillsData.signature;
      }
      listFetchOk = true;
    }
  } catch {
    // Transient network / parse error — bail out without touching the local FS
  }

  // Guard: a failed list fetch must not proceed to writeSkillsToFilesystem.
  // An empty entries array would wipe every swarm-managed skill directory from
  // the worker disk, which is worse than leaving the cache stale.
  if (!listFetchOk) {
    return { changed: false };
  }

  const summary = skillRows
    .filter((s) => s.isActive && s.isEnabled)
    .map((s) => ({ name: s.name, description: s.description }));

  // Step 3: build SkillFsEntry[] and write to THIS worker's local HOME.
  //
  // For complex+enabled skills, fetch bundled files via N+1 HTTP calls
  // (GET /api/skills/:id/files for manifest, then per non-binary file).
  // Simple skills (the common case) need zero extra fetches.
  let syncOk = false;
  try {
    const entries: SkillFsEntry[] = [];

    for (const skill of skillRows) {
      if (!skill.isActive || !skill.isEnabled) continue;

      const files: { path: string; content: string; isBinary: boolean }[] = [];

      if (skill.isComplex) {
        // Fetch manifest to know which files exist + which are binary
        try {
          const manifestResp = await fetch(`${apiUrl}/api/skills/${skill.id}/files`, {
            headers: authHeaders,
          });
          if (manifestResp.ok) {
            const manifestData = (await manifestResp.json()) as {
              files: { path: string; isBinary: boolean }[];
            };

            // Fetch content for each non-binary file (N+1 — acceptable for v1)
            for (const manifestEntry of manifestData.files) {
              if (manifestEntry.isBinary) {
                files.push({ path: manifestEntry.path, content: "", isBinary: true });
                continue;
              }
              try {
                const encodedPath = manifestEntry.path.split("/").map(encodeURIComponent).join("/");
                const fileResp = await fetch(
                  `${apiUrl}/api/skills/${skill.id}/files/${encodedPath}`,
                  { headers: authHeaders },
                );
                if (fileResp.ok) {
                  const fileData = (await fileResp.json()) as {
                    file: { path: string; content: string; isBinary: boolean };
                  };
                  files.push({
                    path: fileData.file.path,
                    content: fileData.file.content,
                    isBinary: fileData.file.isBinary,
                  });
                }
              } catch {
                // Non-fatal — skip this file
              }
            }
          }
        } catch {
          // Non-fatal — treat as no files (will skip complex skill per writer logic)
        }
      }

      entries.push({
        id: skill.id,
        name: skill.name,
        content: skill.content ?? null,
        isComplex: skill.isComplex,
        isEnabled: skill.isEnabled,
        isActive: skill.isActive,
        files,
      });
    }

    const writeResult = writeSkillsToFilesystem(entries, "all", homeOverride ?? homedir());
    console.log(
      `[${role}] Skills synced: ${writeResult.synced} written, ${writeResult.removed} removed`,
    );
    if (writeResult.errors.length > 0) {
      console.warn(`[${role}] Skill sync errors: ${writeResult.errors.join(", ")}`);
    }
    syncOk = true;
  } catch (err) {
    console.warn(`[${role}] Skill sync failed: ${(err as Error).message}`);
  }

  if (skillRows.length === 0 && newHash === null) {
    return { changed: false };
  }

  // Only cache the new hash once the local FS write has actually succeeded —
  // otherwise a transient write failure would leave the cached hash matching
  // the current signature, causing later polls to short-circuit and the
  // disk state to stay stale forever. The next poll re-enters this code path
  // (lastHashRef unchanged) and retries.
  if (syncOk && newHash !== null) {
    lastHashRef.current = newHash;
  }
  return { changed: true, summary };
}
