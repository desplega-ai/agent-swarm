/**
 * Worker-side per-task skill refresh.
 *
 * Polls the cheap signature endpoint; on a hash mismatch, refetches the
 * full skill list and re-runs filesystem sync (claude/pi/codex dirs). The
 * worker stores the signature returned in the list response so the cached
 * hash always corresponds exactly to the snapshot it acted on — avoids a
 * stale-hash race between the signature and list endpoints.
 *
 * Transient errors are swallowed (returned as `changed: false`) so a flaky
 * API can't churn the system prompt.
 */

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

  // Step 2: full fetch + sync (only reached when hash differs or first call)
  let summary: { name: string; description: string }[] | undefined;
  let newHash: string | null = null;
  try {
    const skillsResp = await fetch(`${apiUrl}/api/agents/${agentId}/skills`, {
      headers: authHeaders,
    });
    if (skillsResp.ok) {
      const skillsData = (await skillsResp.json()) as {
        skills: { name: string; description: string; isActive: boolean; isEnabled: boolean }[];
        signature?: string;
      };
      summary = skillsData.skills
        .filter((s) => s.isActive && s.isEnabled)
        .map((s) => ({ name: s.name, description: s.description }));
      if (typeof skillsData.signature === "string") {
        newHash = skillsData.signature;
      }
    }
  } catch {
    // Non-fatal — skills are optional
  }

  // Step 3: filesystem sync (claude/pi/codex dirs)
  let syncOk = false;
  try {
    const syncHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    };
    if (apiKey) syncHeaders.Authorization = `Bearer ${apiKey}`;
    const syncRes = await fetch(`${apiUrl}/api/skills/sync-filesystem`, {
      method: "POST",
      headers: syncHeaders,
    });
    if (syncRes.ok) {
      const syncResult = (await syncRes.json()) as {
        synced: number;
        removed: number;
        errors: string[];
      };
      console.log(
        `[${role}] Skills synced: ${syncResult.synced} written, ${syncResult.removed} removed`,
      );
      if (syncResult.errors.length > 0) {
        console.warn(`[${role}] Skill sync errors: ${syncResult.errors.join(", ")}`);
      }
      syncOk = true;
    } else {
      console.warn(`[${role}] Skill sync failed: HTTP ${syncRes.status}`);
    }
  } catch (err) {
    console.warn(`[${role}] Skill sync failed: ${(err as Error).message}`);
  }

  if (summary === undefined && newHash === null) {
    return { changed: false };
  }

  // Only cache the new hash once the FS sync has actually succeeded —
  // otherwise a transient sync failure would leave the cached hash matching
  // the current signature, causing later polls to short-circuit and the
  // disk state to stay stale until an unrelated skill mutation. The next
  // poll re-enters this code path (lastHashRef unchanged) and retries.
  if (syncOk && newHash !== null) {
    lastHashRef.current = newHash;
  }
  return { changed: true, summary };
}
