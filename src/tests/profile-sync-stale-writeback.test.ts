import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceIdentityBaselines,
  bootIdentityBaselines,
  CLAUDE_MD_LINEAGE_PATH,
  CLAUDE_MD_PATH,
  collectProfilePayloads,
  contentSha256,
  type FileReader,
  HEARTBEAT_MD_PATH,
  IDENTITY_BASELINES_PATH,
  IDENTITY_MD_PATH,
  type ProfileFileIO,
  SETUP_SCRIPT_PATH,
  SOUL_MD_PATH,
  syncProfileFilesToServer,
  TOOLS_MD_PATH,
  WORKSPACE_CLAUDE_MD_PATH,
} from "../commands/profile-sync";
import {
  type SwarmHooksConfig,
  syncIdentityFilesToServer,
  syncSetupScriptToServer,
} from "../providers/pi-mono-extension";

// A file the agent never touched still holds the copy written at boot. A sync
// that sends it anyway writes that stale copy over any DB-side edit made since
// (Lead's update-profile, a nightly profile edit). These tests hold the DB
// edit in a fake profile API and check that it survives the agent's sync.

const BOOT_IDENTITY = `# Identity\n\n${"boot ".repeat(120)}\n\n## Self-Evolution\n\nold section\n`;
const EDITED_IDENTITY = `# Identity\n\n${"boot ".repeat(120)}\n`;

/** In-memory stand-in for the worker's workspace and /tmp baselines. */
function memoryIO(files: Record<string, string>): ProfileFileIO & {
  files: Record<string, string>;
} {
  return {
    files,
    readFile: async (path) => files[path],
    writeFile: async (path, content) => {
      files[path] = content;
    },
    baselinesLockPath: join(tmpdir(), `identity-baselines-${crypto.randomUUID()}.lock`),
  };
}

/**
 * Holds each read of the baselines file until a second read arrives (or a
 * short timeout), after both have captured the file as it was: the
 * interleaving in which two unserialized updates drop one another's hashes.
 */
function pairBaselineReads(io: ReturnType<typeof memoryIO>): typeof io {
  let waiting: (() => void) | null = null;
  return {
    ...io,
    readFile: async (path) => {
      const content = io.files[path];
      if (path !== IDENTITY_BASELINES_PATH) return content;
      if (waiting) {
        const partner = waiting;
        waiting = null;
        partner();
        return content;
      }
      await new Promise<void>((resolve) => {
        waiting = resolve;
        setTimeout(() => {
          if (waiting === resolve) waiting = null;
          resolve();
        }, 300);
      });
      return content;
    },
  };
}

function baselinesOf(io: ReturnType<typeof memoryIO>): Record<string, string> {
  return JSON.parse(io.files[IDENTITY_BASELINES_PATH] ?? "{}");
}

/** The workspace right after runner boot: files and baselines from the DB. */
function bootedWorkspace(profile: Record<string, string>) {
  const baselines: Record<string, string> = {};
  for (const [field, content] of Object.entries(profile)) {
    baselines[field] = contentSha256(content);
  }
  return memoryIO({
    [IDENTITY_MD_PATH]: profile.identityMd ?? "",
    [IDENTITY_BASELINES_PATH]: JSON.stringify(baselines),
  });
}

describe("profile sync never writes an untouched file over a DB edit", () => {
  let db: Record<string, string> = {};
  let server: ReturnType<typeof Bun.serve>;
  let config: SwarmHooksConfig;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "PUT") return new Response("not found", { status: 404 });
        const body = (await req.json()) as Record<string, string>;
        for (const [field, value] of Object.entries(body)) {
          if (field !== "changeSource") db[field] = value;
        }
        return Response.json({ ok: true });
      },
    });
    config = {
      apiUrl: `http://localhost:${server.port}`,
      apiKey: "test-key",
      agentId: "agent-1",
      taskId: "task-1",
      isLead: false,
    };
  });

  afterAll(() => {
    server.stop(true);
  });

  test("opencode/pi session end keeps a DB edit made during the session when IDENTITY.md is untouched", async () => {
    db = { identityMd: BOOT_IDENTITY };
    const io = bootedWorkspace({ identityMd: BOOT_IDENTITY });

    // Mid-session DB edit; the agent never touches /workspace/IDENTITY.md.
    db.identityMd = EDITED_IDENTITY;

    await syncIdentityFilesToServer(config, "session_sync", undefined, io);

    expect(db.identityMd).toBe(EDITED_IDENTITY);
  });

  test("a synced local edit advances the baseline, so a later DB edit survives the next session end", async () => {
    db = { identityMd: BOOT_IDENTITY };
    const io = bootedWorkspace({ identityMd: BOOT_IDENTITY });
    const agentEdit = `${BOOT_IDENTITY}\n## Learned\n\nagent edit\n`;

    io.files[IDENTITY_MD_PATH] = agentEdit;
    await syncIdentityFilesToServer(config, "self_edit", undefined, io);
    expect(db.identityMd).toBe(agentEdit);

    db.identityMd = EDITED_IDENTITY;
    await syncIdentityFilesToServer(config, "session_sync", undefined, io);

    expect(db.identityMd).toBe(EDITED_IDENTITY);
  });

  test("a real local edit still syncs", async () => {
    db = { identityMd: BOOT_IDENTITY };
    const io = bootedWorkspace({ identityMd: BOOT_IDENTITY });
    io.files[IDENTITY_MD_PATH] = EDITED_IDENTITY;

    await syncIdentityFilesToServer(config, "session_sync", undefined, io);

    expect(db.identityMd).toBe(EDITED_IDENTITY);
  });

  test("an untouched start-up.sh does not overwrite a DB setupScript edit", async () => {
    db = { setupScript: "echo boot" };
    const io = memoryIO({
      [SETUP_SCRIPT_PATH]: "#!/bin/bash\necho boot\n",
      [IDENTITY_BASELINES_PATH]: JSON.stringify({ setupScript: contentSha256("echo boot") }),
    });
    db.setupScript = "echo edited";

    await syncSetupScriptToServer(config, "session_sync", io);

    expect(db.setupScript).toBe("echo edited");
  });

  const runnerSync = (
    io: ProfileFileIO,
    opts: Partial<Parameters<typeof syncProfileFilesToServer>[0]>,
  ) =>
    syncProfileFilesToServer({
      agentId: config.agentId,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      changeSource: "session_sync",
      io,
      ...opts,
    });

  test("an accepted workspace CLAUDE.md edit advances its baseline, so a later DB edit survives the next session end", async () => {
    const boot = "# CLAUDE.md\n\nboot rules\n";
    db = { claudeMd: boot };
    const io = memoryIO({
      [WORKSPACE_CLAUDE_MD_PATH]: boot,
      [IDENTITY_BASELINES_PATH]: JSON.stringify({ claudeMd: contentSha256(boot) }),
    });
    const sync = () =>
      runnerSync(io, { fields: ["claude"], claudeMdPath: WORKSPACE_CLAUDE_MD_PATH });

    // Session 1: a codex/opencode agent edits /workspace/CLAUDE.md.
    const agentEdit = `${boot}\n## Learned\n\nagent rule\n`;
    io.files[WORKSPACE_CLAUDE_MD_PATH] = agentEdit;
    await sync();
    expect(db.claudeMd).toBe(agentEdit);

    // Lead edits the DB; session 2 never touches the file.
    db.claudeMd = "# CLAUDE.md\n\nlead rules\n";
    await sync();

    expect(db.claudeMd).toBe("# CLAUDE.md\n\nlead rules\n");
  });

  test("an accepted personal CLAUDE.md sync keeps the hook's lineage and the boot baseline", async () => {
    const boot = "# CLAUDE.md\n\nboot rules\n";
    const lineage = JSON.stringify({ written: contentSha256(boot), base: contentSha256(boot) });
    const bootBaselines = JSON.stringify({ claudeMd: contentSha256(boot) });
    db = { claudeMd: boot };
    const io = memoryIO({
      [CLAUDE_MD_PATH]: `${boot}\nagent rule\n`,
      [CLAUDE_MD_LINEAGE_PATH]: lineage,
      [IDENTITY_BASELINES_PATH]: bootBaselines,
    });

    await runnerSync(io, {
      fields: ["claude"],
      claudeMdPath: CLAUDE_MD_PATH,
      claudeMdLock: { path: join(tmpdir(), `claude-md-${crypto.randomUUID()}.lock`) },
    });

    expect(db.claudeMd).toBe(`${boot}\nagent rule\n`);
    expect(db.expectedHashes).toEqual({ claudeMd: contentSha256(boot) });
    expect(io.files[CLAUDE_MD_LINEAGE_PATH]).toBe(lineage);
    expect(io.files[IDENTITY_BASELINES_PATH]).toBe(bootBaselines);
  });

  test("two concurrent baseline updates both persist their hashes", async () => {
    const io = memoryIO({
      [IDENTITY_BASELINES_PATH]: JSON.stringify({ soulMd: contentSha256("soul") }),
    });
    const paired = pairBaselineReads(io);

    await Promise.all([
      advanceIdentityBaselines({ identityMd: "identity, edited" }, paired),
      advanceIdentityBaselines({ setupScript: "echo edited" }, paired),
    ]);

    expect(baselinesOf(io)).toEqual({
      soulMd: contentSha256("soul"),
      identityMd: contentSha256("identity, edited"),
      setupScript: contentSha256("echo edited"),
    });
  });

  test("concurrent runner and pi syncs both advance their baselines, so neither file is re-sent over a later DB edit", async () => {
    db = { identityMd: BOOT_IDENTITY, setupScript: "echo boot" };
    const io = bootedWorkspace({ identityMd: BOOT_IDENTITY });
    io.files[IDENTITY_BASELINES_PATH] = JSON.stringify({
      identityMd: contentSha256(BOOT_IDENTITY),
      setupScript: contentSha256("echo boot"),
    });
    io.files[IDENTITY_MD_PATH] = EDITED_IDENTITY;
    io.files[SETUP_SCRIPT_PATH] = "#!/bin/bash\necho edited\n";
    const paired = pairBaselineReads(io);

    // The runner's session-end sync races the pi extension's on-edit sync.
    await Promise.all([
      runnerSync(paired, { fields: ["identity"] }),
      syncSetupScriptToServer(config, "self_edit", paired),
    ]);
    expect(db).toEqual({ identityMd: EDITED_IDENTITY, setupScript: "echo edited" });

    db = { identityMd: "lead identity", setupScript: "echo lead" };
    await runnerSync(io, { fields: ["identity", "setup"] });
    await syncIdentityFilesToServer(config, "session_sync", undefined, io);
    await syncSetupScriptToServer(config, "session_sync", io);

    expect(db).toEqual({ identityMd: "lead identity", setupScript: "echo lead" });
  });

  test("an empty HEARTBEAT.md that survives a restart is not sent over a later DB edit", async () => {
    // Boot after a restart: the DB value is empty, so the runner leaves the
    // surviving empty file in place and records the boot baselines.
    db = { heartbeatMd: "" };
    const io = memoryIO({ [HEARTBEAT_MD_PATH]: "" });
    io.files[IDENTITY_BASELINES_PATH] = JSON.stringify(
      bootIdentityBaselines({ heartbeatMd: db.heartbeatMd }, undefined),
    );

    db.heartbeatMd = "- check the queue";
    await runnerSync(io, { fields: ["identity"] });
    expect(db.heartbeatMd).toBe("- check the queue");

    // A real edit of the empty file still syncs.
    io.files[HEARTBEAT_MD_PATH] = "- agent checklist";
    await runnerSync(io, { fields: ["identity"] });
    expect(db.heartbeatMd).toBe("- agent checklist");
  });
});

describe("collectProfilePayloads (claude hook + runner)", () => {
  const reader =
    (files: Record<string, string>): FileReader =>
    async (path) =>
      files[path];

  test("Lead's self_edit of HEARTBEAT.md does not resend a stale IDENTITY.md", async () => {
    const files = reader({
      [SOUL_MD_PATH]: BOOT_IDENTITY,
      [IDENTITY_MD_PATH]: BOOT_IDENTITY,
      [TOOLS_MD_PATH]: "tools",
      [HEARTBEAT_MD_PATH]: "heartbeat, edited",
      [IDENTITY_BASELINES_PATH]: JSON.stringify({
        soulMd: contentSha256(BOOT_IDENTITY),
        identityMd: contentSha256(BOOT_IDENTITY),
        toolsMd: contentSha256("tools"),
        heartbeatMd: contentSha256("heartbeat"),
      }),
    });

    const payloads = await collectProfilePayloads(["identity"], "self_edit", files);

    expect(payloads.map((payload) => payload.body)).toEqual([
      { heartbeatMd: "heartbeat, edited", changeSource: "self_edit" },
    ]);
  });

  test("session_sync skips an untouched start-up.sh", async () => {
    const files = reader({
      [SETUP_SCRIPT_PATH]: "#!/bin/bash\necho boot\n",
      [IDENTITY_BASELINES_PATH]: JSON.stringify({ setupScript: contentSha256("echo boot") }),
    });

    expect(await collectProfilePayloads(["setup"], "session_sync", files)).toEqual([]);
  });
});
