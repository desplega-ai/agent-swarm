import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClaudeMdSessionPaths,
  materializeClaudeMd,
  planClaudeMdSync,
  readClaudeMdSyncState,
  restoreClaudeMd,
  sessionBaselinePath,
} from "../commands/claude-md-session";
import { contentSha256 } from "../commands/profile-sync";

const V1 = "# CLAUDE.md\n\nversion one";
const V2 = "# CLAUDE.md\n\nversion two — the Lead added a rule";

describe("planClaudeMdSync", () => {
  test("skips content a hook wrote: it is not an edit", () => {
    expect(
      planClaudeMdSync({
        content: V1,
        sessionBase: contentSha256(V2),
        lastHookWrite: contentSha256(V1),
      }),
    ).toBeNull();
  });

  test("skips a copy unchanged since this session materialized it", () => {
    expect(
      planClaudeMdSync({ content: V2, sessionBase: contentSha256(V2), lastHookWrite: null }),
    ).toBeNull();
  });

  test("sends an edit with its base as the compare-and-set token", () => {
    expect(
      planClaudeMdSync({
        content: "edited",
        sessionBase: contentSha256(V2),
        lastHookWrite: contentSha256(V2),
      }),
    ).toEqual({
      claudeMd: "edited",
      changeSource: "session_sync",
      expectedHashes: { claudeMd: contentSha256(V2) },
    });
  });

  test("without a session baseline keeps the previous unconditional sync", () => {
    expect(planClaudeMdSync({ content: "edited", sessionBase: null, lastHookWrite: null })).toEqual(
      {
        claudeMd: "edited",
        changeSource: "session_sync",
      },
    );
    expect(planClaudeMdSync({ content: "  ", sessionBase: null, lastHookWrite: null })).toBeNull();
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
      lastHookWrite: join(root, "last-hook-write"),
      sessionsDir: join(root, "sessions"),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stop = async (sessionId: string) => {
    const state = await readClaudeMdSyncState(sessionId, paths);
    const body = state ? planClaudeMdSync(state) : null;
    await restoreClaudeMd(paths);
    return body;
  };
  const edit = (content: string) => Bun.write(paths.file, content);

  test("a sibling's .bak restore is not pushed as an edit (the reviewed race)", async () => {
    await materializeClaudeMd(V1, "session-a", paths); // A starts on v1
    await materializeClaudeMd(V2, "session-b", paths); // the DB moved to v2; B starts, .bak = v1

    expect(await stop("session-a")).toBeNull(); // disk v2 is B's materialization
    expect(await Bun.file(paths.file).text()).toBe(V1); // A restored the .bak

    // Disk v1 differs from B's base (v2), but a hook wrote it: no sync.
    expect(await stop("session-b")).toBeNull();
  });

  test("a second Stop in the same session does not push the restored .bak", async () => {
    await edit(V1); // what was on disk before the session
    await materializeClaudeMd(V2, "session-b", paths);
    await edit("edited in session");

    expect(await stop("session-b")).toEqual({
      claudeMd: "edited in session",
      changeSource: "session_sync",
      expectedHashes: { claudeMd: contentSha256(V2) },
    });
    expect(await stop("session-b")).toBeNull(); // disk is the restored v1
  });

  test("a deliberate revert to an earlier version is sent, based on the current value", async () => {
    await materializeClaudeMd(V2, "session-b", paths);
    await edit(V1); // the agent restores v1 on purpose

    expect(await stop("session-b")).toEqual({
      claudeMd: V1,
      changeSource: "session_sync",
      expectedHashes: { claudeMd: contentSha256(V2) },
    });
  });

  test("the session baselines of overlapping sessions do not overwrite each other", async () => {
    await materializeClaudeMd(V1, "session-a", paths);
    await materializeClaudeMd(V2, "session-b", paths);

    expect((await readClaudeMdSyncState("session-a", paths))?.sessionBase).toBe(contentSha256(V1));
    expect((await readClaudeMdSyncState("session-b", paths))?.sessionBase).toBe(contentSha256(V2));
    expect((await readClaudeMdSyncState("session-c", paths))?.sessionBase).toBeNull();
  });

  test("materializing prunes session baselines older than a week", async () => {
    await materializeClaudeMd(V1, "old-session", paths);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(paths.sessionsDir, "old-session.json"), old, old);

    await materializeClaudeMd(V2, "new-session", paths);
    expect((await readdir(paths.sessionsDir)).sort()).toEqual(["new-session.json"]);
  });

  test("restoring without a .bak removes the file and the last-hook-write record", async () => {
    await materializeClaudeMd(V1, "session-a", paths); // nothing on disk before: no .bak
    await restoreClaudeMd(paths);

    expect(await Bun.file(paths.file).exists()).toBe(false);
    expect(await Bun.file(paths.lastHookWrite).exists()).toBe(false);
  });
});

describe("sessionBaselinePath", () => {
  test("sanitizes the session id into a single file name", () => {
    expect(sessionBaselinePath("../../etc/passwd", "/base")).toBe("/base/etcpasswd.json");
    expect(sessionBaselinePath("abc-123_DEF", "/base")).toBe("/base/abc-123_DEF.json");
    expect(sessionBaselinePath("../", "/base")).toBeNull();
  });
});
