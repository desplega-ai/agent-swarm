import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  collectProfilePayloads,
  contentSha256,
  type FileReader,
  HEARTBEAT_MD_PATH,
  IDENTITY_BASELINES_PATH,
  IDENTITY_MD_PATH,
  SETUP_SCRIPT_PATH,
  SOUL_MD_PATH,
  TOOLS_MD_PATH,
} from "../commands/profile-sync";
import {
  type ProfileFileIO,
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
  };
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
