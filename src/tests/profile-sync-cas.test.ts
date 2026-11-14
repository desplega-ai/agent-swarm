import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createAgent, getAgentById, initDb, updateAgentProfile } from "../be/db";
import {
  bootIdentityBaselines,
  contentSha256,
  IDENTITY_BASELINES_PATH,
  type ProfileFileIO,
  SETUP_SCRIPT_PATH,
  SOUL_MD_PATH,
  syncProfileFilesToServer,
  TOOLS_MD_PATH,
  WORKSPACE_CLAUDE_MD_PATH,
  writeIdentityBaselines,
  writeProfileFileFromDb,
} from "../commands/profile-sync";
import { withFileLock } from "../utils/file-lock";
import { installProfileWriteGuard } from "./fixtures/profile-write-guard";
import { expectChildOk, runChild } from "./test-proc";

// Protect the parent too: old writeIdentityBaselines implementations ignore injected IO.
const restoreWriteGuard = installProfileWriteGuard(
  join(tmpdir(), `profile-cas-parent-${crypto.randomUUID()}`),
);
afterAll(restoreWriteGuard);

const id = "cccc0000-0000-4000-8000-000000000452";
const dbPath = join(tmpdir(), `profile-cas-${crypto.randomUUID()}.sqlite`);
beforeAll(async () => {
  initDb(dbPath);
  await createAgent({ id, name: "CAS worker", isLead: false, status: "idle" });
});
afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
});

// Exercise the real server CAS rather than reproduce it in a fake API.
const profileApi = (async (_url: unknown, init?: RequestInit) => {
  const { changeSource, expectedHashes, ...fields } = JSON.parse(String(init?.body));
  return Response.json(await updateAgentProfile(id, fields, { changeSource }, { expectedHashes }));
}) as typeof fetch;

function workspace(profile: Parameters<typeof bootIdentityBaselines>[0], setup?: string) {
  const files: Record<string, string> = {
    [TOOLS_MD_PATH]: profile.toolsMd ?? "",
    [IDENTITY_BASELINES_PATH]: JSON.stringify(bootIdentityBaselines(profile, setup)),
  };
  const io: ProfileFileIO = {
    readFile: async (path) => files[path],
    writeFile: async (path, content) => {
      files[path] = content;
    },
    baselinesLockPath: join(tmpdir(), `profile-cas-${crypto.randomUUID()}.lock`),
  };
  return {
    files,
    io,
    sync: (fetchImpl = profileApi) =>
      syncProfileFilesToServer({
        agentId: id,
        apiUrl: "http://profile.test",
        apiKey: "test-key",
        fields: ["identity", "setup"],
        io,
        fetchImpl,
      }),
  };
}

test("a DB edit survives a stale local edit and the next session can edit the recovered copy", async () => {
  await updateAgentProfile(id, { toolsMd: "tools v0" });
  const box = workspace({ toolsMd: "tools v0" });
  box.files[TOOLS_MD_PATH] = "session 1 edit";
  await updateAgentProfile(id, { toolsMd: "DB edit between sessions" });
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("DB edit between sessions");
  expect(box.files[TOOLS_MD_PATH]).toBe("DB edit between sessions");
  expect(
    Object.entries(box.files).some(
      ([path, content]) => path.includes(".bak") && content === "session 1 edit",
    ),
  ).toBe(true);
  box.files[TOOLS_MD_PATH] = "session 2 edit";
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("session 2 edit");
  box.files[TOOLS_MD_PATH] = "session 3 edit";
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("session 3 edit");
});

test("a non-Claude session sends its boot claudeMd token and recovers a conflict before editing again", async () => {
  const boot = "workspace boot rules";
  const local = "stale workspace edit";
  const current = "rules updated by Lead";
  await updateAgentProfile(id, { claudeMd: boot });
  const box = workspace({ claudeMd: boot });
  box.files[WORKSPACE_CLAUDE_MD_PATH] = local;
  await updateAgentProfile(id, { claudeMd: current });
  const requests: Array<Record<string, unknown>> = [];
  const sync = () =>
    syncProfileFilesToServer({
      agentId: id,
      apiUrl: "http://profile.test",
      apiKey: "test-key",
      fields: ["claude"],
      claudeMdPath: WORKSPACE_CLAUDE_MD_PATH,
      io: box.io,
      fetchImpl: (async (input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return profileApi(input, init);
      }) as typeof fetch,
    });
  await sync();
  expect(requests[0]?.expectedHashes).toEqual({ claudeMd: contentSha256(boot) });
  expect((await getAgentById(id))?.claudeMd).toBe(current);
  expect(box.files[WORKSPACE_CLAUDE_MD_PATH]).toBe(current);
  expect(
    Object.entries(box.files).some(([path, content]) => path.includes(".bak") && content === local),
  ).toBe(true);
  box.files[WORKSPACE_CLAUDE_MD_PATH] = "next session edit";
  await sync();
  expect(requests[1]?.expectedHashes).toEqual({ claudeMd: contentSha256(current) });
  expect((await getAgentById(id))?.claudeMd).toBe("next session edit");
  box.files[WORKSPACE_CLAUDE_MD_PATH] = "following session edit";
  await sync();
  expect((await getAgentById(id))?.claudeMd).toBe("following session edit");
});

test("a failed default upload on an empty DB is not an accepted base", async () => {
  await updateAgentProfile(id, { toolsMd: "" });
  const box = workspace({ toolsMd: "generated default" });
  // The runner materialized a generated default, but the initial PUT failed.
  box.files[IDENTITY_BASELINES_PATH] = JSON.stringify(
    bootIdentityBaselines({ toolsMd: "generated default" }, undefined, id, { toolsMd: "" }),
  );
  box.files[TOOLS_MD_PATH] = "first edit after failed default upload";
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("first edit after failed default upload");
  const accepted = box.files[IDENTITY_BASELINES_PATH];
  box.files[TOOLS_MD_PATH] = "retry after network error";
  await box.sync((async () => new Response("unavailable", { status: 503 })) as typeof fetch);
  expect(box.files[IDENTITY_BASELINES_PATH]).toBe(accepted);
  await updateAgentProfile(id, { toolsMd: "DB edit after failed PUT" });
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("DB edit after failed PUT");
  expect(box.files[TOOLS_MD_PATH]).toBe("DB edit after failed PUT");
});

test("composed setup uses the DB token and only replaces the managed section on conflict", async () => {
  const dbSetup = "export AGENT=0\n";
  const compose = (body: string) =>
    `#!/bin/bash\nexport OPERATOR=1\n# === Agent-managed setup (from DB) ===\n${body}\n# === End agent-managed setup ===\noperator_tail\n`;
  await updateAgentProfile(id, { setupScript: dbSetup });
  const box = workspace({ setupScript: dbSetup }, compose(dbSetup));
  box.files[SETUP_SCRIPT_PATH] = compose("export AGENT=1");
  await box.sync();
  expect((await getAgentById(id))?.setupScript).toBe("export AGENT=1");
  box.files[SETUP_SCRIPT_PATH] = compose("export AGENT=2");
  await updateAgentProfile(id, { setupScript: "export AGENT=DB\n" });
  await box.sync();
  expect((await getAgentById(id))?.setupScript).toBe("export AGENT=DB\n");
  expect(box.files[SETUP_SCRIPT_PATH]).toBe(compose("export AGENT=DB\n"));
  expect(
    Object.entries(box.files).some(
      ([path, content]) => path.includes(".bak") && content === compose("export AGENT=2"),
    ),
  ).toBe(true);
  box.files[SETUP_SCRIPT_PATH] = compose("export AGENT=3");
  await box.sync();
  expect((await getAgentById(id))?.setupScript).toBe("export AGENT=3");
});

test("a field whose conflict cannot be archived stays pending while another field is accepted", async () => {
  const soul = "s".repeat(600);
  await updateAgentProfile(id, { soulMd: soul, toolsMd: "tools base" });
  const box = workspace({ soulMd: soul, toolsMd: "tools base" });
  box.files[SOUL_MD_PATH] = `${soul} local edit`;
  box.files[TOOLS_MD_PATH] = "independent tools edit";
  const oldSoulToken = JSON.parse(box.files[IDENTITY_BASELINES_PATH]!).expected.soulMd;
  const write = box.io.writeFile;
  box.io.writeFile = async (path, content) => {
    if (path.includes(".bak")) throw new Error("archive unavailable");
    await write(path, content);
  };
  await updateAgentProfile(id, { soulMd: `${soul} DB edit` });
  await box.sync();
  expect((await getAgentById(id))?.soulMd).toBe(`${soul} DB edit`);
  expect((await getAgentById(id))?.toolsMd).toBe("independent tools edit");
  expect(box.files[SOUL_MD_PATH]).toBe(`${soul} local edit`);
  expect(JSON.parse(box.files[IDENTITY_BASELINES_PATH]!).expected.soulMd).toBe(oldSoulToken);
  box.io.writeFile = write;
  await box.sync();
  expect(box.files[SOUL_MD_PATH]).toBe(`${soul} DB edit`);
  box.files[TOOLS_MD_PATH] = "next independent edit";
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("next independent edit");
});

test("real Stop and PostToolUse hooks share the identity and setup CAS across sessions", async () => {
  const { mkdtemp, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "hook-profile-cas-"));
  const setup = "export AGENT=0\n";
  const compose = (body: string) =>
    `#!/bin/bash\noperator_head\n# === Agent-managed setup (from DB) ===\n${body}\n# === End agent-managed setup ===\noperator_tail\n`;
  await updateAgentProfile(id, { toolsMd: "hook tools base", setupScript: setup });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/me") return Response.json(await getAgentById(id));
      if (req.method === "PUT" && new URL(req.url).pathname.endsWith("/profile"))
        return profileApi(req.url, { body: await req.text() });
      return Response.json({});
    },
  });
  const write = (name: string, content: string) => Bun.write(join(directory, name), content);
  const hook = async (event: Record<string, unknown>) => {
    const child = await runChild(
      [process.execPath, join(import.meta.dir, "fixtures/hook-profile-cas.ts"), directory],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          CLAUDE_PROJECT_DIR: directory,
          ANONYMIZED_TELEMETRY: "false",
          AGENT_SWARM_ADAPTER_SESSION_SUMMARY: "1",
        },
        stdin: JSON.stringify({ cwd: directory, ...event }),
      },
    );
    expectChildOk(child, "profile CAS hook");
  };
  try {
    await write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            url: `http://localhost:${server.port}/mcp`,
            headers: { Authorization: "Bearer test-key", "X-Agent-ID": id },
          },
        },
      }),
    );
    await write(
      "identity-baselines.json",
      JSON.stringify(
        bootIdentityBaselines({ toolsMd: "hook tools base", setupScript: setup }, compose(setup)),
      ),
    );
    await write("TOOLS.md", "hook session 1");
    await write("start-up.sh", compose("export AGENT=1"));
    await updateAgentProfile(id, { toolsMd: "DB hook edit", setupScript: "export AGENT=DB\n" });
    await hook({ hook_event_name: "Stop" });
    expect((await getAgentById(id))?.toolsMd).toBe("DB hook edit");
    expect((await getAgentById(id))?.setupScript).toBe("export AGENT=DB\n");
    expect(await Bun.file(join(directory, "TOOLS.md")).text()).toBe("DB hook edit");
    expect(await Bun.file(join(directory, "start-up.sh")).text()).toBe(
      compose("export AGENT=DB\n"),
    );
    expect((await readdir(directory)).filter((path) => path.endsWith(".bak")).length).toBe(2);
    await write("TOOLS.md", "hook session 2");
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/workspace/TOOLS.md" },
    });
    expect((await getAgentById(id))?.toolsMd).toBe("hook session 2");
    await write("start-up.sh", compose("export AGENT=2"));
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/workspace/start-up.sh" },
    });
    expect((await getAgentById(id))?.setupScript).toBe("export AGENT=2");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 105_000);

async function runRunnerCase(scenario?: "baseline-error" | "preservation-error" | "direct-write") {
  const baselineError = scenario === "baseline-error";
  const preservationError = scenario === "preservation-error";
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "runner-profile-cas-"));
  const outside =
    scenario === "direct-write"
      ? await mkdtemp(join(tmpdir(), "profile-guard-outside-"))
      : undefined;
  const protectedPaths = outside
    ? {
        workspace: join(outside, "workspace"),
        baselines: join(outside, "identity-baselines.json"),
      }
    : undefined;
  if (protectedPaths) {
    await Bun.write(join(protectedPaths.workspace, "SOUL.md"), "simulated workspace intact");
    await Bun.write(protectedPaths.baselines, "simulated baselines intact");
  }
  await updateAgentProfile(id, {
    toolsMd: baselineError || preservationError ? "previous DB version" : "",
    soulMd: "s".repeat(600),
    identityMd: "i".repeat(600),
    claudeMd: "notes",
    heartbeatMd: "heartbeat",
  });
  if (preservationError)
    await Bun.write(join(directory, "TOOLS.md"), "untouched previous local copy");
  let failedDefault = false;
  if (baselineError) {
    await Bun.write(
      join(directory, "identity-baselines.json"),
      JSON.stringify(bootIdentityBaselines({ toolsMd: "previous DB version" }, undefined)),
    );
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/me") return Response.json(await getAgentById(id));
      const body = await req.text();
      if (!JSON.parse(body).changeSource) {
        failedDefault = true;
        return new Response("default upload failed", { status: 503 });
      }
      return profileApi(req.url, { body });
    },
  });
  try {
    const child = await runChild(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/runner-profile-cas.ts"),
        directory,
        `http://localhost:${server.port}`,
        ...(scenario ? [scenario] : []),
        ...(protectedPaths ? [JSON.stringify(protectedPaths)] : []),
      ],
      {
        cwd: directory,

        env: {
          PATH: process.env.PATH,
          HOME: directory,
          AGENT_ID: id,
          API_KEY: "test-key",
          MCP_BASE_URL: "http://runner.invalid",
          HARNESS_PROVIDER: "pi",
          CRED_CHECK_DISABLE: "1",
          DATABASE_PATH: ":memory:",
          ANONYMIZED_TELEMETRY: "false",
          STEERING_ENABLED: "false",
        },
      },
    );
    if (scenario === "direct-write") {
      expect(child.exitCode).toBe(86);
      expect(child.stderr).toContain(
        `PROFILE WRITE GUARD: escritura fuera del sandbox: ${protectedPaths!.workspace}/SOUL.md`,
      );
      expect(await Bun.file(join(protectedPaths!.workspace, "SOUL.md")).text()).toBe(
        "simulated workspace intact",
      );
      expect(await Bun.file(protectedPaths!.baselines).text()).toBe("simulated baselines intact");
      console.log(`${child.stderr.trim()}\nInjected workspace and baselines intact`);
      return;
    }
    expectChildOk(child, "profile CAS runner");
    if (baselineError || preservationError) {
      expect((await getAgentById(id))?.toolsMd).toBe("previous DB version");
    } else {
      expect(failedDefault).toBe(true);
      expect((await getAgentById(id))?.toolsMd).toBe("tools edited in session 1");
    }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  }
}

test(
  "runner boot does not promote a generated default after its upload failed",
  () => runRunnerCase(),
  35_000,
);

test(
  "runner holds uploads when it cannot publish boot tokens over a previous baseline",
  () => runRunnerCase("baseline-error"),
  35_000,
);

test("HTTP 2xx without the stored field cannot acknowledge an edit", async () => {
  await updateAgentProfile(id, { toolsMd: "response base" });
  const box = workspace({ toolsMd: "response base" });
  const before = box.files[IDENTITY_BASELINES_PATH];
  box.files[TOOLS_MD_PATH] = "unconfirmed edit";
  for (const body of ["", "[]", '{"ok":true}']) {
    await box.sync((async () => new Response(body, { status: 200 })) as typeof fetch);
    expect(box.files[IDENTITY_BASELINES_PATH]).toBe(before);
    expect(box.files[TOOLS_MD_PATH]).toBe("unconfirmed edit");
  }
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("unconfirmed edit");
});

test("preservation never treats a read error as a missing local copy", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "profile-unreadable-"));
  const path = join(directory, "TOOLS.md");
  await Bun.write(path, "local copy to preserve");
  const realFile = Bun.file;
  const unreadable = realFile(path);
  const text = spyOn(unreadable, "text").mockRejectedValue(new Error("EIO reading local profile"));
  const file = spyOn(Bun, "file").mockImplementation(((target: string) =>
    target === path ? unreadable : realFile(target)) as typeof Bun.file);
  try {
    await expect(writeProfileFileFromDb(path, "new DB copy")).rejects.toThrow(
      "EIO reading local profile",
    );
  } finally {
    file.mockRestore();
    text.mockRestore();
  }
  try {
    expect(await realFile(path).text()).toBe("local copy to preserve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a failed boot archive cannot turn an untouched old file into an accepted edit",
  () => runRunnerCase("preservation-error"),
  35_000,
);

test("an accepted managed setup extract keeps its own shebang when skipping the next sync", async () => {
  const compose = (body: string) =>
    `#!/bin/bash\noperator_head\n# === Agent-managed setup (from DB) ===\n${body}\n# === End agent-managed setup ===\noperator_tail\n`;
  const base = "#!/bin/bash\nexport AGENT=base\n";
  const edit = "#!/bin/bash\nexport AGENT=edited";
  await updateAgentProfile(id, { setupScript: base });
  const box = workspace({ setupScript: base }, compose(base));
  box.files[SETUP_SCRIPT_PATH] = compose(edit);
  await box.sync();
  expect((await getAgentById(id))?.setupScript).toBe(edit);
  let requests = 0;
  await box.sync((async (input, init) => {
    requests++;
    return profileApi(input, init);
  }) as typeof fetch);
  expect(requests).toBe(0);
});

/** A fetch whose response is held until `release()`, to settle it after a newer sync. */
function heldResponse() {
  let release!: () => void;
  let started!: () => void;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = (async (input, init) => {
    const response = await profileApi(input, init);
    started();
    await gate;
    return response;
  }) as typeof fetch;
  return { fetchImpl, sent, release };
}

test("a late conflict response does not roll back a newer settled identity edit", async () => {
  await updateAgentProfile(id, { toolsMd: "late boot" });
  const box = workspace({ toolsMd: "late boot" });
  await updateAgentProfile(id, { toolsMd: "late DB lead" });
  box.files[TOOLS_MD_PATH] = "late stale edit";
  const held = heldResponse();
  const old = box.sync(held.fetchImpl);
  await held.sent;
  await box.sync(); // another sync reconciles the same conflict first
  box.files[TOOLS_MD_PATH] = "late newer edit";
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("late newer edit");
  held.release();
  await old;
  expect(box.files[TOOLS_MD_PATH]).toBe("late newer edit");
  box.files[TOOLS_MD_PATH] = "late follow-up edit";
  await box.sync();
  expect((await getAgentById(id))?.toolsMd).toBe("late follow-up edit");
});

test("a late conflict response does not roll back a newer settled setup edit", async () => {
  const compose = (body: string) =>
    `#!/bin/bash\n# === Agent-managed setup (from DB) ===\n${body}\n# === End agent-managed setup ===\n`;
  await updateAgentProfile(id, { setupScript: "export LATE=boot" });
  const box = workspace({ setupScript: "export LATE=boot" }, compose("export LATE=boot"));
  await updateAgentProfile(id, { setupScript: "export LATE=DB" });
  box.files[SETUP_SCRIPT_PATH] = compose("export LATE=stale");
  const held = heldResponse();
  const old = box.sync(held.fetchImpl);
  await held.sent;
  await box.sync();
  box.files[SETUP_SCRIPT_PATH] = compose("export LATE=newer");
  await box.sync();
  expect((await getAgentById(id))?.setupScript).toBe("export LATE=newer");
  held.release();
  await old;
  expect(box.files[SETUP_SCRIPT_PATH]).toBe(compose("export LATE=newer"));
});

test("an unreadable field is held while an independent field edit is still accepted", async () => {
  const soul = "s".repeat(600);
  await updateAgentProfile(id, { soulMd: soul, toolsMd: "readable base" });
  const box = workspace({ soulMd: soul, toolsMd: "readable base" });
  box.files[TOOLS_MD_PATH] = "readable independent edit";
  const read = box.io.readFile;
  box.io.readFile = async (path) => {
    if (path === SOUL_MD_PATH) throw Object.assign(new Error("EIO soul"), { code: "EIO" });
    return read(path);
  };
  await box.sync();
  const stored = await getAgentById(id);
  expect(stored?.toolsMd).toBe("readable independent edit");
  expect(stored?.soulMd).toBe(soul);
});

test("boot baselines wait for the baselines lock and are not written once its wait runs out", async () => {
  const box = workspace({ toolsMd: "lock boot" });
  const lockPath = box.io.baselinesLockPath as string;
  let pending!: Promise<void>;
  await withFileLock(lockPath, async () => {
    pending = writeIdentityBaselines({ toolsMd: contentSha256("lock new boot") }, box.io);
    await Bun.sleep(70);
    expect(JSON.parse(box.files[IDENTITY_BASELINES_PATH] ?? "{}").toolsMd).toBe(
      contentSha256("lock boot"),
    );
  });
  await pending;
  const written = box.files[IDENTITY_BASELINES_PATH];
  expect(JSON.parse(written ?? "{}").toolsMd).toBe(contentSha256("lock new boot"));
  await withFileLock(lockPath, async () => {
    await expect(writeIdentityBaselines({ toolsMd: "not recorded" }, box.io)).rejects.toThrow(
      "Boot baselines not recorded",
    );
  });
  expect(box.files[IDENTITY_BASELINES_PATH]).toBe(written);
}, 10_000);

test("a late response is superseded even when the DB value has returned to its token", async () => {
  await updateAgentProfile(id, { toolsMd: "aba A" });
  const box = workspace({ toolsMd: "aba A" });
  await updateAgentProfile(id, { toolsMd: "aba B" });
  box.files[TOOLS_MD_PATH] = "aba stale edit";
  const held = heldResponse();
  const old = box.sync(held.fetchImpl); // sent on token A, answered with B
  await held.sent;
  await box.sync(); // recovers B
  await updateAgentProfile(id, { toolsMd: "aba A" }); // the DB returns to A
  box.files[TOOLS_MD_PATH] = "aba edit over B";
  await box.sync(); // conflict: recovers A, so the token is A again
  expect(box.files[TOOLS_MD_PATH]).toBe("aba A");
  held.release();
  await old;
  expect(box.files[TOOLS_MD_PATH]).toBe("aba A");
});

test("an unreadable setup script is held while an identity edit is still accepted", async () => {
  await updateAgentProfile(id, { toolsMd: "setup read base", setupScript: "export READ=1" });
  const box = workspace({ toolsMd: "setup read base", setupScript: "export READ=1" });
  box.files[TOOLS_MD_PATH] = "edit beside unreadable setup";
  const read = box.io.readFile;
  box.io.readFile = async (path) => {
    if (path === SETUP_SCRIPT_PATH) throw Object.assign(new Error("EIO setup"), { code: "EIO" });
    return read(path);
  };
  await box.sync();
  const stored = await getAgentById(id);
  expect(stored?.toolsMd).toBe("edit beside unreadable setup");
  expect(stored?.setupScript).toBe("export READ=1");
});

test(
  "runner fixture rejects a direct profile write outside its sandbox",
  () => runRunnerCase("direct-write"),
  35_000,
);

test("write guard rejects injected workspace, baselines and lock writes through every guarded API", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "profile-guard-probe-"));
  const sandbox = join(root, "sandbox");
  const paths = {
    workspace: join(root, "workspace"),
    baselines: join(root, "identity-baselines.json"),
  };
  const targets = [join(paths.workspace, "SOUL.md"), paths.baselines, `${paths.baselines}.lock`];
  for (const target of targets) await Bun.write(target, "intact");
  try {
    for (const operation of [
      "bun",
      "bun-file",
      "bun-url",
      "writeFile",
      "rename",
      "rename-source",
      "mkdir",
      "open",
      "writeFileSync",
      "renameSync",
      "mkdirSync",
      "openSync",
    ]) {
      for (const target of targets) {
        const child = await runChild(
          [
            process.execPath,
            join(import.meta.dir, "fixtures/profile-write-guard-probe.ts"),
            sandbox,
            JSON.stringify(paths),
            target,
            operation,
          ],
          { cwd: root, env: { PATH: process.env.PATH, HOME: root } },
        );
        expect(child.exitCode).toBe(86);
        expect(child.stderr).toContain(
          `PROFILE WRITE GUARD: escritura fuera del sandbox: ${target}`,
        );
        expect(await Bun.file(target).text()).toBe("intact");
      }
    }
    console.log(
      "PROFILE WRITE GUARD: 36 injected write attempts blocked; simulated workspace, baselines and lock intact; sandbox writes allowed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
