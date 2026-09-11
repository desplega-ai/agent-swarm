import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClaudeMdSessionPaths,
  DEFAULT_CLAUDE_MD_SESSION_PATHS,
  materializeClaudeMd,
  planClaudeMdSync,
  readClaudeMdSyncState,
  restoreClaudeMd,
} from "../commands/claude-md-session";
import { contentSha256 } from "../commands/profile-sync";

const V1 = "# CLAUDE.md\n\nversion one";
const V2 = "# CLAUDE.md\n\nversion two — the Lead added a rule";
const h = contentSha256;

describe("planClaudeMdSync", () => {
  test("skips content a hook wrote: it is not an edit", () => {
    expect(planClaudeMdSync({ content: V1, record: { written: h(V1), base: h(V1) } })).toBeNull();
  });

  test("sends an edit with the base of the content it was made on", () => {
    expect(
      planClaudeMdSync({ content: "edited", record: { written: h(V2), base: h(V2) } }),
    ).toEqual({
      claudeMd: "edited",
      changeSource: "session_sync",
      expectedHashes: { claudeMd: h(V2) },
    });
  });

  test("an edit made on a restored stale copy carries the stale base", () => {
    // The file was a restored v1 (written by a hook, based on v1): an edit on
    // it must not be applied over a DB at v2 — the token says v1.
    expect(
      planClaudeMdSync({ content: "edited", record: { written: h(V1), base: h(V1) } }),
    ).toEqual({
      claudeMd: "edited",
      changeSource: "session_sync",
      expectedHashes: { claudeMd: h(V1) },
    });
  });

  test("without any record keeps the previous unconditional sync", () => {
    expect(planClaudeMdSync({ content: "edited", record: null })).toEqual({
      claudeMd: "edited",
      changeSource: "session_sync",
    });
    expect(planClaudeMdSync({ content: "  ", record: null })).toBeNull();
  });
});

describe("concurrent sessions sharing ~/.claude/CLAUDE.md", () => {
  let root: string;
  let paths: ClaudeMdSessionPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-md-session-"));
    paths = {
      file: join(root, "home/.claude/CLAUDE.md"),
      backup: join(root, "home/.claude/CLAUDE.md.bak"),
      record: join(root, "lineage.json"),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A Stop: decide the sync from what is on disk, then restore the `.bak`. */
  const stop = async () => {
    const state = await readClaudeMdSyncState(paths);
    const body = state ? planClaudeMdSync(state) : null;
    await restoreClaudeMd(paths);
    return body;
  };
  const edit = (content: string) => Bun.write(paths.file, content);

  test("a sibling's .bak restore is not pushed as an edit", async () => {
    await materializeClaudeMd(V1, paths); // A starts on v1
    await materializeClaudeMd(V2, paths); // the DB moved to v2; B starts, .bak = v1

    expect(await stop()).toBeNull(); // A: disk v2 is B's materialization
    expect(await Bun.file(paths.file).text()).toBe(V1); // A restored the .bak
    expect(await stop()).toBeNull(); // B: disk v1 was written by a hook
  });

  test("a second Stop in the same session does not push the restored .bak", async () => {
    await edit(V1); // what was on disk before the session (no record)
    await materializeClaudeMd(V2, paths);
    await edit("edited in session");

    expect(await stop()).toEqual({
      claudeMd: "edited in session",
      changeSource: "session_sync",
      expectedHashes: { claudeMd: h(V2) },
    });
    expect(await stop()).toBeNull(); // disk is the restored pre-session copy
  });

  test("an unsynced edit backed up by a sibling's SessionStart still reaches the DB", async () => {
    await materializeClaudeMd(V2, paths); // A starts on v2
    await edit("A's edit"); // A's agent edits, not synced yet
    await materializeClaudeMd(V2, paths); // B starts: .bak = A's edit, disk = v2

    expect(await stop()).toBeNull(); // A: disk v2 is B's materialization
    expect(await Bun.file(paths.file).text()).toBe("A's edit"); // A restored its own edit
    // B finds A's edit on disk: an edit, sent against the v2 it was made on.
    expect(await stop()).toEqual({
      claudeMd: "A's edit",
      changeSource: "session_sync",
      expectedHashes: { claudeMd: h(V2) },
    });
  });

  test("a deliberate revert to an earlier version is sent, based on the current value", async () => {
    await materializeClaudeMd(V2, paths);
    await edit(V1); // the agent restores v1 on purpose

    expect(await stop()).toEqual({
      claudeMd: V1,
      changeSource: "session_sync",
      expectedHashes: { claudeMd: h(V2) },
    });
  });

  test("restoring without a .bak removes the file and the record", async () => {
    await materializeClaudeMd(V1, paths); // nothing on disk before: no .bak
    await restoreClaudeMd(paths);

    expect(await Bun.file(paths.file).exists()).toBe(false);
    expect(await Bun.file(paths.record).exists()).toBe(false);
  });

  test("a stale sidecar describing another backup is ignored", async () => {
    await materializeClaudeMd(V2, paths);
    await edit("A's edit");
    await materializeClaudeMd(V2, paths); // .bak = A's edit, sidecar says "edit on v2"
    await Bun.write(paths.backup, V1); // the .bak changed under a sidecar that no longer matches
    await restoreClaudeMd(paths);

    expect(await stop()).toBeNull(); // unknown lineage → treated as hook-written
  });

  test("an unreadable record never turns into a push", async () => {
    await materializeClaudeMd(V2, paths);
    await edit("edited");
    await Bun.write(paths.record, '{"written": "abc'); // torn or corrupt

    expect(await stop()).toBeNull();
  });

  test("record and sidecar writes are atomic: no temp files are left behind", async () => {
    await edit(V1);
    await materializeClaudeMd(V2, paths); // writes .bak, sidecar and record
    await restoreClaudeMd(paths);

    const leftovers = [...(await readdir(root)), ...(await readdir(join(root, "home/.claude")))];
    expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a symlink planted at the record path is replaced, not written through", async () => {
    const victim = join(root, "victim.txt");
    await Bun.write(victim, "do not touch");
    await symlink(victim, paths.record);

    await materializeClaudeMd(V1, paths);

    expect(await Bun.file(victim).text()).toBe("do not touch");
    expect((await lstat(paths.record)).isSymbolicLink()).toBe(false);
  });

  test("a .bak without lineage (from before this module) is treated as hook-written", async () => {
    await Bun.write(paths.backup, V1); // legacy backup, no sidecar
    await Bun.write(paths.file, V2);
    await restoreClaudeMd(paths);

    expect(await stop()).toBeNull();
  });
});

describe("default paths", () => {
  test("the lineage record lives next to the file it describes, not in /tmp", () => {
    const { file, backup, record } = DEFAULT_CLAUDE_MD_SESSION_PATHS;
    expect(record).toBe(`${file}.lineage.json`);
    expect(backup).toBe(`${file}.bak`);
    expect(record.startsWith("/tmp/")).toBe(false);
  });
});
