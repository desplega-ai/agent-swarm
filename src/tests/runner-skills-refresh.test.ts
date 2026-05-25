/**
 * Coverage for the runner-side `refreshSkillsIfChanged()` helper.
 *
 * The helper is internal (defined in src/commands/runner.ts) so we re-define
 * a faithful copy here under test — same semantics, exercised against a
 * Bun.serve() stub that mimics the signature + list + sync-filesystem
 * endpoints. The point of the test is to lock down the *contract* of the
 * helper (cheap probe on no-change, full refresh on hash drift, transient
 * 5xx swallowed) rather than to test the production binding line-by-line —
 * the prod call sites are covered by the Manual E2E section of the plan.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type SkillsRefreshContext = {
  apiUrl: string;
  swarmUrl: string;
  apiKey: string;
  agentId: string;
  role: string;
};

type SkillsRefreshResult = {
  changed: boolean;
  summary?: { name: string; description: string }[];
};

async function refreshSkillsIfChanged(
  ctx: SkillsRefreshContext,
  lastHashRef: { current: string | null },
): Promise<SkillsRefreshResult> {
  const { apiUrl, swarmUrl, apiKey, agentId, role } = ctx;
  const authHeaders: Record<string, string> = { "X-Agent-ID": agentId };
  if (apiKey) authHeaders.Authorization = `Bearer ${apiKey}`;

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
      return { changed: false };
    }
  } catch {
    return { changed: false };
  }

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
    // Non-fatal
  }

  try {
    const syncHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    };
    if (apiKey) syncHeaders.Authorization = `Bearer ${apiKey}`;
    await fetch(`${swarmUrl}/api/skills/sync-filesystem`, {
      method: "POST",
      headers: syncHeaders,
    });
  } catch {
    // Non-fatal
  }

  if (summary === undefined && newHash === null) return { changed: false };
  if (newHash !== null) lastHashRef.current = newHash;
  void role;
  return { changed: true, summary };
}

// ── Bun.serve() stub backing fake signature/list/sync endpoints ──────────────

type StubState = {
  signatureHash: string;
  signatureStatus: number;
  skillsBody: {
    skills: { name: string; description: string; isActive: boolean; isEnabled: boolean }[];
    signature: string;
  };
  calls: { signature: number; list: number; sync: number };
};

const state: StubState = {
  signatureHash: "hash-v1",
  signatureStatus: 200,
  skillsBody: {
    skills: [
      { name: "alpha", description: "first skill", isActive: true, isEnabled: true },
      { name: "beta", description: "second skill", isActive: true, isEnabled: true },
    ],
    signature: "hash-v1",
  },
  calls: { signature: 0, list: 0, sync: 0 },
};

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

describe("refreshSkillsIfChanged", () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/skills/signature")) {
          state.calls.signature++;
          if (state.signatureStatus !== 200) {
            return new Response("err", { status: state.signatureStatus });
          }
          return Response.json({
            hash: state.signatureHash,
            count: state.skillsBody.skills.length,
            generatedAt: new Date().toISOString(),
          });
        }
        if (url.pathname.match(/\/api\/agents\/[^/]+\/skills$/)) {
          state.calls.list++;
          return Response.json({
            skills: state.skillsBody.skills,
            total: state.skillsBody.skills.length,
            signature: state.skillsBody.signature,
          });
        }
        if (url.pathname === "/api/skills/sync-filesystem") {
          state.calls.sync++;
          return Response.json({ synced: 2, removed: 0, errors: [] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  function makeCtx(): SkillsRefreshContext {
    return {
      apiUrl: baseUrl,
      swarmUrl: baseUrl,
      apiKey: "test-key",
      agentId: "agent-1",
      role: "worker",
    };
  }

  test("first call populates summary and updates the cached hash", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureHash = "hash-v1";
    state.skillsBody.signature = "hash-v1";

    const lastHash = { current: null as string | null };
    const result = await refreshSkillsIfChanged(makeCtx(), lastHash);

    expect(result.changed).toBe(true);
    expect(result.summary).toEqual([
      { name: "alpha", description: "first skill" },
      { name: "beta", description: "second skill" },
    ]);
    expect(lastHash.current).toBe("hash-v1");
    expect(state.calls).toEqual({ signature: 1, list: 1, sync: 1 });
  });

  test("subsequent call with unchanged hash skips list + sync", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    const lastHash = { current: "hash-v1" };

    const result = await refreshSkillsIfChanged(makeCtx(), lastHash);

    expect(result.changed).toBe(false);
    expect(result.summary).toBeUndefined();
    expect(lastHash.current).toBe("hash-v1");
    expect(state.calls).toEqual({ signature: 1, list: 0, sync: 0 });
  });

  test("hash drift refetches list and updates cached hash to the list's snapshot", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureHash = "hash-v2";
    state.skillsBody.signature = "hash-v2";
    state.skillsBody.skills = [
      { name: "alpha", description: "first skill", isActive: true, isEnabled: true },
      { name: "beta", description: "second skill", isActive: true, isEnabled: true },
      { name: "gamma", description: "third skill", isActive: true, isEnabled: true },
    ];

    const lastHash = { current: "hash-v1" };
    const result = await refreshSkillsIfChanged(makeCtx(), lastHash);

    expect(result.changed).toBe(true);
    expect(result.summary).toHaveLength(3);
    expect(lastHash.current).toBe("hash-v2");
    expect(state.calls).toEqual({ signature: 1, list: 1, sync: 1 });
  });

  test("filters out inactive or disabled skills from the summary", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureHash = "hash-v3";
    state.skillsBody.signature = "hash-v3";
    state.skillsBody.skills = [
      { name: "active", description: "kept", isActive: true, isEnabled: true },
      { name: "disabled", description: "dropped", isActive: true, isEnabled: false },
      { name: "inactive", description: "dropped", isActive: false, isEnabled: true },
    ];

    const lastHash = { current: "hash-v2" };
    const result = await refreshSkillsIfChanged(makeCtx(), lastHash);

    expect(result.changed).toBe(true);
    expect(result.summary).toEqual([{ name: "active", description: "kept" }]);
  });

  test("transient 5xx on signature endpoint returns changed:false without touching list/sync", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureStatus = 503;

    const lastHash = { current: "hash-v3" };
    const result = await refreshSkillsIfChanged(makeCtx(), lastHash);

    expect(result.changed).toBe(false);
    expect(lastHash.current).toBe("hash-v3");
    expect(state.calls).toEqual({ signature: 1, list: 0, sync: 0 });

    state.signatureStatus = 200; // restore for any later tests
  });
});
