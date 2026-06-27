import { describe, expect, spyOn, test } from "bun:test";
import {
  buildIdentityPayload,
  CLAUDE_MD_PATH,
  collectProfilePayloads,
  contentSha256,
  extractSetupScriptContent,
  type FileReader,
  IDENTITY_BASELINES_PATH,
  IDENTITY_MD_PATH,
  type IdentityBaselines,
  postProfileUpdate,
  resolveClaudeMdPath,
  SETUP_SCRIPT_PATH,
  SOUL_MD_PATH,
  syncProfileFilesToServer,
  TOOLS_MD_PATH,
  WORKSPACE_CLAUDE_MD_PATH,
} from "../commands/profile-sync";

const MARKER_START = "# === Agent-managed setup (from DB) ===";
const MARKER_END = "# === End agent-managed setup ===";

// A SOUL/IDENTITY body long enough to clear the 500-char min-length guard.
const LONG = "x".repeat(600);

describe("extractSetupScriptContent (marker extraction)", () => {
  test("extracts ONLY the content between the agent-managed markers", () => {
    const raw = [
      "#!/bin/bash",
      "echo operator-prelude",
      MARKER_START,
      "export FOO=bar",
      'echo "agent line"',
      MARKER_END,
      "echo operator-postlude",
    ].join("\n");

    expect(extractSetupScriptContent(raw)).toBe('export FOO=bar\necho "agent line"');
  });

  test("strips a leading shebang when no markers are present", () => {
    const raw = '#!/bin/bash\necho "whole file is agent-managed"';
    expect(extractSetupScriptContent(raw)).toBe('echo "whole file is agent-managed"');
  });

  test("returns null for an empty / whitespace-only file", () => {
    expect(extractSetupScriptContent("")).toBeNull();
    expect(extractSetupScriptContent("   \n\t ")).toBeNull();
  });

  test("returns null when the marker section is empty", () => {
    const raw = `prelude\n${MARKER_START}\n   \n${MARKER_END}\npostlude`;
    expect(extractSetupScriptContent(raw)).toBeNull();
  });

  test("returns null when content exceeds the max length", () => {
    const raw = `${MARKER_START}\n${"a".repeat(65537)}\n${MARKER_END}`;
    expect(extractSetupScriptContent(raw)).toBeNull();
  });
});

describe("buildIdentityPayload (min-length guard)", () => {
  test("includes SOUL/IDENTITY only when they clear the 500-char minimum", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = buildIdentityPayload({ soulMd: LONG, identityMd: LONG });
      expect(ok.soulMd).toBe(LONG);
      expect(ok.identityMd).toBe(LONG);

      const short = buildIdentityPayload({ soulMd: "too short", identityMd: "also short" });
      expect(short.soulMd).toBeUndefined();
      expect(short.identityMd).toBeUndefined();
      // The guard must be VISIBLE — it logs why it skipped.
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("TOOLS.md has no min-length guard (any non-empty content syncs)", () => {
    const payload = buildIdentityPayload({ toolsMd: "short tools" });
    expect(payload.toolsMd).toBe("short tools");
  });

  test("HEARTBEAT.md syncs even when empty (no trim/min-length guard)", () => {
    const payload = buildIdentityPayload({ heartbeatMd: "" });
    expect(payload.heartbeatMd).toBe("");
  });

  test("skips files that exceed the max length", () => {
    const huge = "z".repeat(65537);
    const payload = buildIdentityPayload({ soulMd: huge, toolsMd: huge });
    expect(payload.soulMd).toBeUndefined();
    expect(payload.toolsMd).toBeUndefined();
  });

  test("absent files (undefined) produce no keys", () => {
    expect(buildIdentityPayload({})).toEqual({});
  });
});

describe("collectProfilePayloads (field gate)", () => {
  const reader = (files: Record<string, string>): FileReader => {
    return async (path: string) => files[path];
  };

  test("only the selected field group is collected", async () => {
    const files = reader({
      [SOUL_MD_PATH]: LONG,
      [IDENTITY_MD_PATH]: LONG,
      [TOOLS_MD_PATH]: "tools",
      [CLAUDE_MD_PATH]: "claude md content",
      [SETUP_SCRIPT_PATH]: `${MARKER_START}\nexport X=1\n${MARKER_END}`,
    });

    const setupOnly = await collectProfilePayloads(["setup"], "session_sync", files);
    expect(setupOnly.map((p) => p.label)).toEqual(["setup"]);
    expect(setupOnly[0]?.body).toEqual({ setupScript: "export X=1", changeSource: "session_sync" });

    const claudeOnly = await collectProfilePayloads(["claude"], "session_sync", files);
    expect(claudeOnly.map((p) => p.label)).toEqual(["claude"]);

    const all = await collectProfilePayloads(
      ["identity", "claude", "setup"],
      "session_sync",
      files,
    );
    expect(all.map((p) => p.label).sort()).toEqual(["claude", "identity", "setup"]);
  });

  test("a missing file yields no payload for that group (no empty POST)", async () => {
    const files = reader({}); // nothing on disk
    const payloads = await collectProfilePayloads(
      ["identity", "claude", "setup"],
      "session_sync",
      files,
    );
    expect(payloads).toEqual([]);
  });

  test("propagates the changeSource into every body", async () => {
    const files = reader({ [TOOLS_MD_PATH]: "tools" });
    const payloads = await collectProfilePayloads(["identity"], "self_edit", files);
    expect(payloads[0]?.body.changeSource).toBe("self_edit");
  });

  test("non-Claude providers sync /workspace/CLAUDE.md, not the personal file", async () => {
    // A codex/pi/opencode session edits the runner-materialized workspace file;
    // the Claude personal file (~/.claude/CLAUDE.md) is absent for them.
    const files = reader({ [WORKSPACE_CLAUDE_MD_PATH]: "workspace claude md edit" });

    const payloads = await collectProfilePayloads(
      ["claude"],
      "session_sync",
      files,
      WORKSPACE_CLAUDE_MD_PATH,
    );
    expect(payloads.map((p) => p.label)).toEqual(["claude"]);
    expect(payloads[0]?.body).toEqual({
      claudeMd: "workspace claude md edit",
      changeSource: "session_sync",
    });
  });

  test("Claude's default path never reads the workspace materialization", async () => {
    // Guard against reverting a real Claude personal-file edit: with the default
    // (personal-file) path, content sitting only at /workspace/CLAUDE.md — the
    // stale boot materialization — must NOT be picked up as a claude payload.
    const files = reader({ [WORKSPACE_CLAUDE_MD_PATH]: "stale workspace materialization" });

    const payloads = await collectProfilePayloads(["claude"], "session_sync", files);
    expect(payloads).toEqual([]);
  });
});

describe("resolveClaudeMdPath (per-batch provider routing)", () => {
  test("an all-Claude batch uses the personal-file path (Stop-hook backstop)", () => {
    expect(resolveClaudeMdPath(["claude"])).toBe(CLAUDE_MD_PATH);
    expect(resolveClaudeMdPath(["claude", "claude"])).toBe(CLAUDE_MD_PATH);
  });

  test("any non-Claude local session routes to the workspace file", () => {
    expect(resolveClaudeMdPath(["codex"])).toBe(WORKSPACE_CLAUDE_MD_PATH);
    expect(resolveClaudeMdPath(["pi"])).toBe(WORKSPACE_CLAUDE_MD_PATH);
    expect(resolveClaudeMdPath(["opencode"])).toBe(WORKSPACE_CLAUDE_MD_PATH);
    // Mixed batch: a non-Claude edit means the workspace file is authoritative.
    expect(resolveClaudeMdPath(["claude", "codex"])).toBe(WORKSPACE_CLAUDE_MD_PATH);
  });
});

describe("postProfileUpdate (non-2xx is surfaced, not swallowed)", () => {
  const opts = {
    agentId: "agent-1",
    apiUrl: "https://api.example.test",
    apiKey: "secret-key",
  };
  const payload = {
    label: "setup",
    body: { setupScript: "export X=1", changeSource: "session_sync" },
  };

  test("a successful 2xx response logs no warning", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      await postProfileUpdate({ ...opts, fetchImpl }, payload);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a non-2xx response surfaces a warning but does NOT throw", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () =>
      new Response("boom", { status: 500, statusText: "Server Error" })) as typeof fetch;
    try {
      // Must resolve (non-fatal), not reject.
      await expect(postProfileUpdate({ ...opts, fetchImpl }, payload)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0]?.[0]);
      expect(msg).toContain("setup sync failed");
      expect(msg).toContain("500");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a thrown fetch error surfaces a warning but does NOT throw", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      await expect(postProfileUpdate({ ...opts, fetchImpl }, payload)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("setup sync errored");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("sends a PUT to the profile route with auth + agent headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await postProfileUpdate({ ...opts, fetchImpl }, payload);

    expect(capturedUrl).toBe("https://api.example.test/api/agents/agent-1/profile");
    expect(capturedInit?.method).toBe("PUT");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(headers["X-Agent-ID"]).toBe("agent-1");
    expect(JSON.parse(String(capturedInit?.body))).toEqual(payload.body);
  });
});

describe("syncProfileFilesToServer (orchestration is non-fatal)", () => {
  test("resolves without throwing even when every POST fails", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    try {
      await expect(
        syncProfileFilesToServer({
          agentId: "agent-1",
          apiUrl: "https://api.example.test",
          apiKey: "secret-key",
          changeSource: "session_sync",
          // No files on a CI box → typically no payloads; still must never throw.
          fetchImpl,
        }),
      ).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ── Baseline comparison tests ─────────────────────────────────────────────
// These test the fix for Lead's update-profile edits getting clobbered by
// the worker's session-end sync. When a file's content hash matches the
// baseline recorded at session start, it means the agent didn't modify it,
// so session_sync skips it to preserve any DB-side edits made by Lead.

describe("buildIdentityPayload (baseline comparison)", () => {
  const baselines: IdentityBaselines = {
    soulMd: contentSha256(LONG),
    identityMd: contentSha256(LONG),
    toolsMd: contentSha256("original tools"),
    heartbeatMd: contentSha256("original heartbeat"),
  };

  test("skips files whose hash matches the baseline (unchanged during session)", () => {
    const payload = buildIdentityPayload(
      {
        soulMd: LONG,
        identityMd: LONG,
        toolsMd: "original tools",
        heartbeatMd: "original heartbeat",
      },
      baselines,
    );
    expect(payload).toEqual({});
  });

  test("includes files whose content differs from the baseline (modified during session)", () => {
    const modifiedSoul = `${LONG} — agent added this`;
    const payload = buildIdentityPayload(
      {
        soulMd: modifiedSoul,
        identityMd: LONG, // unchanged
        toolsMd: "modified tools",
        heartbeatMd: "original heartbeat", // unchanged
      },
      baselines,
    );
    expect(payload.soulMd).toBe(modifiedSoul);
    expect(payload.identityMd).toBeUndefined();
    expect(payload.toolsMd).toBe("modified tools");
    expect(payload.heartbeatMd).toBeUndefined();
  });

  test("without baselines (null), all files sync as before (backwards compat)", () => {
    const payload = buildIdentityPayload(
      { soulMd: LONG, identityMd: LONG, toolsMd: "tools" },
      null,
    );
    expect(payload.soulMd).toBe(LONG);
    expect(payload.identityMd).toBe(LONG);
    expect(payload.toolsMd).toBe("tools");
  });

  test("without baselines (undefined), all files sync as before (backwards compat)", () => {
    const payload = buildIdentityPayload({ soulMd: LONG, identityMd: LONG }, undefined);
    expect(payload.soulMd).toBe(LONG);
    expect(payload.identityMd).toBe(LONG);
  });

  test("a field missing from baselines is still synced (partial baseline)", () => {
    const partial: IdentityBaselines = { soulMd: contentSha256(LONG) };
    const payload = buildIdentityPayload({ soulMd: LONG, identityMd: LONG }, partial);
    expect(payload.soulMd).toBeUndefined(); // matches baseline → skipped
    expect(payload.identityMd).toBe(LONG); // no baseline → synced
  });
});

describe("collectProfilePayloads (baseline integration)", () => {
  const reader = (files: Record<string, string>): FileReader => {
    return async (path: string) => files[path];
  };

  test("session_sync skips unchanged identity files when baselines exist", async () => {
    const identityContent = LONG;
    const toolsContent = "original tools";
    const modifiedToolsContent = "modified tools";

    const baselines: IdentityBaselines = {
      soulMd: contentSha256(identityContent),
      identityMd: contentSha256(identityContent),
      toolsMd: contentSha256(toolsContent),
    };

    const files = reader({
      [SOUL_MD_PATH]: identityContent,
      [IDENTITY_MD_PATH]: identityContent,
      [TOOLS_MD_PATH]: modifiedToolsContent,
      [IDENTITY_BASELINES_PATH]: JSON.stringify(baselines),
    });

    const payloads = await collectProfilePayloads(["identity"], "session_sync", files);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.body.toolsMd).toBe(modifiedToolsContent);
    expect(payloads[0]?.body.soulMd).toBeUndefined();
    expect(payloads[0]?.body.identityMd).toBeUndefined();
  });

  test("self_edit bypasses baselines (agent explicitly changed the file)", async () => {
    const identityContent = LONG;

    const files = reader({
      [SOUL_MD_PATH]: identityContent,
      [IDENTITY_MD_PATH]: identityContent,
      [TOOLS_MD_PATH]: "tools",
      [IDENTITY_BASELINES_PATH]: JSON.stringify({
        soulMd: contentSha256(identityContent),
        identityMd: contentSha256(identityContent),
        toolsMd: contentSha256("tools"),
      }),
    });

    const payloads = await collectProfilePayloads(["identity"], "self_edit", files);
    expect(payloads).toHaveLength(1);
    // self_edit should include ALL files regardless of baselines
    expect(payloads[0]?.body.soulMd).toBe(identityContent);
    expect(payloads[0]?.body.identityMd).toBe(identityContent);
    expect(payloads[0]?.body.toolsMd).toBe("tools");
  });

  test("session_sync skips unchanged CLAUDE.md when baseline matches", async () => {
    const claudeContent = "original claude md";
    const baselines: IdentityBaselines = { claudeMd: contentSha256(claudeContent) };

    const files = reader({
      [CLAUDE_MD_PATH]: claudeContent,
      [IDENTITY_BASELINES_PATH]: JSON.stringify(baselines),
    });

    const payloads = await collectProfilePayloads(["claude"], "session_sync", files);
    expect(payloads).toEqual([]);
  });

  test("session_sync syncs modified CLAUDE.md even when baselines exist", async () => {
    const baselines: IdentityBaselines = { claudeMd: contentSha256("original") };

    const files = reader({
      [CLAUDE_MD_PATH]: "modified claude md",
      [IDENTITY_BASELINES_PATH]: JSON.stringify(baselines),
    });

    const payloads = await collectProfilePayloads(["claude"], "session_sync", files);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.body.claudeMd).toBe("modified claude md");
  });

  test("session_sync proceeds normally when baselines file is missing", async () => {
    const files = reader({
      [TOOLS_MD_PATH]: "tools content",
      // No IDENTITY_BASELINES_PATH → baselines will be null → no skipping
    });

    const payloads = await collectProfilePayloads(["identity"], "session_sync", files);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.body.toolsMd).toBe("tools content");
  });

  test("all identity files unchanged → no identity payload at all", async () => {
    const baselines: IdentityBaselines = {
      soulMd: contentSha256(LONG),
      identityMd: contentSha256(LONG),
      toolsMd: contentSha256("tools"),
      heartbeatMd: contentSha256("heartbeat"),
    };

    const files = reader({
      [SOUL_MD_PATH]: LONG,
      [IDENTITY_MD_PATH]: LONG,
      [TOOLS_MD_PATH]: "tools",
      "/workspace/HEARTBEAT.md": "heartbeat",
      [IDENTITY_BASELINES_PATH]: JSON.stringify(baselines),
    });

    const payloads = await collectProfilePayloads(
      ["identity", "claude", "setup"],
      "session_sync",
      files,
    );
    // No identity payload (all skipped), no claude or setup (files missing)
    expect(payloads).toEqual([]);
  });
});
