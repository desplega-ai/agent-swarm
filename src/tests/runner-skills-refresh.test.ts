/**
 * Coverage for the worker-side `refreshSkillsIfChanged()` helper. The helper
 * is exercised against a Bun.serve() stub that mimics the signature + list
 * endpoints. Cases lock down its contract: cheap probe on no-change, full
 * refresh on hash drift, inactive/disabled filtering, transient 5xx swallowed,
 * local FS write (not POST to /api/skills/sync-filesystem), and hash-caching
 * only on successful local write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshSkillsIfChanged, type SkillsRefreshContext } from "../utils/skills-refresh";

// ── Bun.serve() stub backing fake signature/list endpoints ───────────────────

type SkillStub = {
  id: string;
  name: string;
  description: string;
  content: string | null;
  isComplex: boolean;
  isActive: boolean;
  isEnabled: boolean;
};

type StubState = {
  signatureHash: string;
  signatureStatus: number;
  listStatus: number;
  skillsBody: {
    skills: SkillStub[];
    signature: string;
  };
  calls: { signature: number; list: number; sync: number };
  skillFilesStatus: number;
};

const FAKE_HOME = join(tmpdir(), `runner-refresh-test-${process.pid}`);

const state: StubState = {
  signatureHash: "hash-v1",
  signatureStatus: 200,
  listStatus: 200,
  skillFilesStatus: 200,
  skillsBody: {
    skills: [
      {
        id: "skill-alpha",
        name: "alpha",
        description: "first skill",
        content: "---\nname: alpha\n---\n\nAlpha body.",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
      {
        id: "skill-beta",
        name: "beta",
        description: "second skill",
        content: "---\nname: beta\n---\n\nBeta body.",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
    ],
    signature: "hash-v1",
  },
  calls: { signature: 0, list: 0, sync: 0 },
};

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

describe("refreshSkillsIfChanged", () => {
  beforeAll(() => {
    mkdirSync(FAKE_HOME, { recursive: true });

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
          if (state.listStatus !== 200) {
            return new Response("err", { status: state.listStatus });
          }
          return Response.json({
            skills: state.skillsBody.skills,
            total: state.skillsBody.skills.length,
            signature: state.skillsBody.signature,
          });
        }
        // Track that the old sync-filesystem endpoint is NOT called
        if (url.pathname === "/api/skills/sync-filesystem") {
          state.calls.sync++;
          return Response.json({ synced: 0, removed: 0, errors: [] });
        }
        // Complex skill: file manifest
        if (url.pathname.match(/\/api\/skills\/[^/]+\/files$/) && state.skillFilesStatus === 200) {
          return Response.json({ files: [], total: 0 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  function makeCtx(): SkillsRefreshContext {
    return {
      apiUrl: baseUrl,
      swarmUrl: "app.agent-swarm.dev",
      apiKey: "test-key",
      agentId: "agent-1",
      role: "worker",
    };
  }

  // Thin helper to pass homeOverride through to refreshSkillsIfChanged
  async function refreshWithHome(
    ctx: SkillsRefreshContext,
    lastHashRef: { current: string | null },
    home: string,
  ) {
    return refreshSkillsIfChanged(ctx, lastHashRef, home);
  }

  test("first call writes SKILL.md to local HOME and updates cached hash", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureHash = "hash-v1";
    state.skillsBody.signature = "hash-v1";

    const lastHash = { current: null as string | null };
    const result = await refreshWithHome(makeCtx(), lastHash, FAKE_HOME);

    expect(result.changed).toBe(true);
    expect(result.summary).toEqual([
      { name: "alpha", description: "first skill" },
      { name: "beta", description: "second skill" },
    ]);
    expect(lastHash.current).toBe("hash-v1");

    // SKILL.md files must be written on the local worker disk
    const alphaFile = join(FAKE_HOME, ".claude", "skills", "alpha", "SKILL.md");
    const betaFile = join(FAKE_HOME, ".claude", "skills", "beta", "SKILL.md");
    expect(existsSync(alphaFile)).toBe(true);
    expect(readFileSync(alphaFile, "utf-8")).toContain("Alpha body.");
    expect(existsSync(betaFile)).toBe(true);

    // Must NOT have called /api/skills/sync-filesystem
    expect(state.calls.sync).toBe(0);
    expect(state.calls).toEqual({ signature: 1, list: 1, sync: 0 });
  });

  test("subsequent call with unchanged hash skips list + write", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    const lastHash = { current: "hash-v1" };

    const result = await refreshWithHome(makeCtx(), lastHash, FAKE_HOME);

    expect(result.changed).toBe(false);
    expect(result.summary).toBeUndefined();
    expect(lastHash.current).toBe("hash-v1");
    expect(state.calls).toEqual({ signature: 1, list: 0, sync: 0 });
  });

  test("hash drift refetches list, writes new skill, updates cached hash", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureHash = "hash-v2";
    state.skillsBody.signature = "hash-v2";
    state.skillsBody.skills = [
      {
        id: "skill-alpha",
        name: "alpha",
        description: "first skill",
        content: "---\nname: alpha\n---\n\nAlpha updated.",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
      {
        id: "skill-beta",
        name: "beta",
        description: "second skill",
        content: "---\nname: beta\n---\n\nBeta body.",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
      {
        id: "skill-gamma",
        name: "gamma",
        description: "third skill",
        content: "---\nname: gamma\n---\n\nGamma body.",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
    ];

    const lastHash = { current: "hash-v1" };
    const result = await refreshWithHome(makeCtx(), lastHash, FAKE_HOME);

    expect(result.changed).toBe(true);
    expect(result.summary).toHaveLength(3);
    expect(lastHash.current).toBe("hash-v2");

    const gammaFile = join(FAKE_HOME, ".claude", "skills", "gamma", "SKILL.md");
    expect(existsSync(gammaFile)).toBe(true);
    expect(readFileSync(gammaFile, "utf-8")).toContain("Gamma body.");
    expect(state.calls.sync).toBe(0); // never POSTed
  });

  test("filters out inactive or disabled skills from summary and does not write them", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureHash = "hash-v3";
    state.skillsBody.signature = "hash-v3";
    state.skillsBody.skills = [
      {
        id: "skill-active",
        name: "active-skill",
        description: "kept",
        content: "# Active",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
      {
        id: "skill-disabled",
        name: "disabled-skill",
        description: "dropped",
        content: "# Disabled",
        isComplex: false,
        isActive: true,
        isEnabled: false,
      },
      {
        id: "skill-inactive",
        name: "inactive-skill",
        description: "dropped",
        content: "# Inactive",
        isComplex: false,
        isActive: false,
        isEnabled: true,
      },
    ];

    const lastHash = { current: "hash-v2" };
    const result = await refreshWithHome(makeCtx(), lastHash, FAKE_HOME);

    expect(result.changed).toBe(true);
    expect(result.summary).toEqual([{ name: "active-skill", description: "kept" }]);

    const disabledFile = join(FAKE_HOME, ".claude", "skills", "disabled-skill", "SKILL.md");
    const inactiveFile = join(FAKE_HOME, ".claude", "skills", "inactive-skill", "SKILL.md");
    expect(existsSync(disabledFile)).toBe(false);
    expect(existsSync(inactiveFile)).toBe(false);
  });

  test("transient 5xx on signature endpoint returns changed:false without touching list/write", async () => {
    state.calls = { signature: 0, list: 0, sync: 0 };
    state.signatureStatus = 503;

    const lastHash = { current: "hash-v3" };
    const result = await refreshWithHome(makeCtx(), lastHash, FAKE_HOME);

    expect(result.changed).toBe(false);
    expect(lastHash.current).toBe("hash-v3");
    expect(state.calls).toEqual({ signature: 1, list: 0, sync: 0 });

    state.signatureStatus = 200; // restore
  });

  test("local write failure leaves cached hash unchanged so the next poll retries", async () => {
    // Use a read-only HOME path to force a write failure
    const readOnlyHome = join(FAKE_HOME, "readonly-home");
    mkdirSync(readOnlyHome, { recursive: true });

    state.signatureHash = "hash-v4";
    state.skillsBody.signature = "hash-v4";
    state.skillsBody.skills = [
      {
        id: "skill-alpha",
        name: "alpha",
        description: "first",
        content: "# Alpha",
        isComplex: false,
        isActive: true,
        isEnabled: true,
      },
    ];
    state.calls = { signature: 0, list: 0, sync: 0 };

    // Make the claude skills dir a FILE (not a dir) so mkdir fails on write
    const blockerPath = join(readOnlyHome, ".claude");
    mkdirSync(join(readOnlyHome), { recursive: true });
    // Write a file at .claude to block mkdirSync from creating it as a dir
    writeFileSync(blockerPath, "blocker");

    const lastHash = { current: "hash-prev" };
    const first = await refreshWithHome(makeCtx(), lastHash, readOnlyHome);

    // Summary still returns (the list call succeeded), but cached hash must
    // NOT advance — FS write failed
    expect(first.changed).toBe(true);
    expect(first.summary).toEqual([{ name: "alpha", description: "first" }]);
    expect(lastHash.current).toBe("hash-prev");
    expect(state.calls.sync).toBe(0); // still never calls sync-filesystem

    // Clean up the blocker
    rmSync(readOnlyHome, { recursive: true, force: true });

    // Normal write in a clean home recovers — next poll retries because hash differs
    state.calls = { signature: 0, list: 0, sync: 0 };
    const cleanHome = join(FAKE_HOME, "clean-home");
    mkdirSync(cleanHome, { recursive: true });
    const second = await refreshWithHome(makeCtx(), lastHash, cleanHome);
    expect(second.changed).toBe(true);
    expect(lastHash.current).toBe("hash-v4");
    expect(state.calls.sync).toBe(0);
    rmSync(cleanHome, { recursive: true, force: true });
  });

  test("list fetch failure after signature drift leaves pre-existing skills on disk and does not advance hash", async () => {
    // Arrange: fresh isolated home with a pre-existing swarm-managed skill
    const isolatedHome = join(FAKE_HOME, "list-fail-home");
    const skillDir = join(isolatedHome, ".claude", "skills", "pre-existing");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, ".swarm-managed"), "");
    writeFileSync(join(skillDir, "SKILL.md"), "# Pre-existing skill");

    // Simulate signature drift so the list endpoint is called
    state.signatureHash = "hash-new";
    state.listStatus = 503; // List fetch fails
    state.calls = { signature: 0, list: 0, sync: 0 };

    const lastHash = { current: "hash-old" };
    const result = await refreshWithHome(makeCtx(), lastHash, isolatedHome);

    // Must bail out without touching disk
    expect(result.changed).toBe(false);
    // Cached hash must NOT advance — disk is still in "old" state
    expect(lastHash.current).toBe("hash-old");
    // List endpoint was called (signature differed) but the failure must bail early
    expect(state.calls.list).toBe(1);
    // Pre-existing managed skill file must survive
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe("# Pre-existing skill");

    // Restore
    state.listStatus = 200;
    rmSync(isolatedHome, { recursive: true, force: true });
  });
});
