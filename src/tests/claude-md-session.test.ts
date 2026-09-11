import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ClaudeMdSessionPaths,
  DEFAULT_CLAUDE_MD_SESSION_PATHS,
  materializeClaudeMd,
  planClaudeMdSync,
  stopClaudeMd,
} from "../commands/claude-md-session";
import {
  CLAUDE_MD_PENDING_RECORD,
  contentSha256,
  type ProfilePayload,
} from "../commands/profile-sync";
import { setFlockForTests } from "../utils/file-lock";
import { holdFileLock } from "./fixtures/hold-file-lock";

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
      lock: join(root, "home/.claude/CLAUDE.md.lock"),
    };
  });

  afterEach(async () => {
    setFlockForTests(undefined);
    await rm(root, { recursive: true, force: true });
  });

  /** A Stop: the payload it would sync (null if none); restores the `.bak`. */
  const stop = async () => {
    let sent: ProfilePayload["body"] | null = null;
    await stopClaudeMd(async (body) => {
      sent = body;
    }, paths);
    return sent;
  };
  const edit = (content: string) => Bun.write(paths.file, content);

  const holdLock = () => holdFileLock(paths.lock);

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
    expect(await stop()).toBeNull();

    expect(await Bun.file(paths.file).exists()).toBe(false);
    expect(await Bun.file(paths.record).exists()).toBe(false);
  });

  test("a stale sidecar describing another backup is ignored", async () => {
    await materializeClaudeMd(V2, paths);
    await edit("A's edit");
    await materializeClaudeMd(V2, paths); // .bak = A's edit, sidecar says "edit on v2"
    await Bun.write(paths.backup, V1); // the .bak changed under a sidecar that no longer matches

    expect(await stop()).toBeNull(); // disk v2 is the second materialization
    expect(await stop()).toBeNull(); // restored v1: unknown lineage → hook-written
  });

  test("an unreadable or malformed record never turns into a push", async () => {
    const upper = h(V1).toUpperCase();
    for (const bad of [
      '{"written": "abc',
      "{}",
      "[]",
      "42",
      '{"written": 5, "base": null}',
      '{"written": "not-a-sha256", "base": null}',
      `{"written": null, "base": "not-a-sha256"}`,
      `{"written": "${upper}", "base": null}`,
    ]) {
      await materializeClaudeMd(V2, paths);
      await edit("edited");
      await Bun.write(paths.record, bad);

      expect(await stop()).toBeNull();
    }
  });

  test("record and sidecar writes are atomic: no temp files are left behind", async () => {
    await edit(V1);
    await materializeClaudeMd(V2, paths); // writes .bak, sidecar and record
    await stop(); // restores them

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

  test("a sidecar with a non-sha256 value is treated as unknown lineage", async () => {
    await materializeClaudeMd(V2, paths);
    await edit("A's edit");
    await materializeClaudeMd(V2, paths); // .bak = A's edit
    await Bun.write(
      `${paths.backup}.lineage`,
      JSON.stringify({ written: null, base: "not-a-sha256", of: h("A's edit") }),
    );

    expect(await stop()).toBeNull(); // disk v2 is the second materialization
    expect(await stop()).toBeNull(); // restored edit with an invalid base: never pushed
  });

  test("a .bak without lineage (from before this module) is treated as hook-written", async () => {
    await Bun.write(paths.backup, V1); // legacy backup, no sidecar
    await Bun.write(paths.file, V2);
    await Bun.write(paths.record, JSON.stringify({ written: h(V2), base: h(V2) }));

    expect(await stop()).toBeNull(); // disk v2 was written by a hook
    expect(await stop()).toBeNull(); // restored legacy v1 is never pushed
  });

  test("a Stop cannot land between SessionStart's file and record writes", async () => {
    // The reviewed race: B writes file v2 while its record still says v1; a Stop
    // in that window restores the old .bak, B then commits record v2, and the
    // next Stop sends v1 against v2 — a revert the compare-and-set accepts.
    await materializeClaudeMd(V1, paths); // A starts on v1
    let reachedPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionStartB = materializeClaudeMd(V2, paths, {
      testPauses: {
        afterFileWrite: async () => {
          reachedPause();
          await gate;
        },
      },
    });
    await paused; // B wrote v2, record still v1

    let stopADone = false;
    const stopA = stop().then((body) => {
      stopADone = true;
      return body;
    });
    await Bun.sleep(100);
    expect(stopADone).toBe(false); // A waits for B's transition to finish

    release();
    await sessionStartB;
    expect(await stopA).toBeNull(); // A sees B's consistent write, restores v1
    expect(await stop()).toBeNull(); // B: v1 was restored by a hook — no revert
  });

  test("a Stop that cannot get the lock pushes and restores nothing", async () => {
    await materializeClaudeMd(V2, paths);
    await edit("edited");
    const release = await holdLock();
    let synced = false;

    const outcome = await stopClaudeMd(
      async () => {
        synced = true;
      },
      paths,
      { lockWaitMs: 100 },
    );
    await release();

    expect(outcome).toBe("busy");
    expect(synced).toBe(false);
    expect(await Bun.file(paths.file).text()).toBe("edited");
  });

  test("a SessionStart that cannot get the lock leaves the file as it is", async () => {
    await materializeClaudeMd(V1, paths);
    const release = await holdLock();

    const outcome = await materializeClaudeMd(V2, paths, { lockWaitMs: 100 });
    await release();

    expect(outcome).toBe("busy"); // never falls back to an unlocked write
    expect(await Bun.file(paths.file).text()).toBe(V1);
    expect(await stop()).toBeNull(); // and nothing it did not write gets pushed
  });

  test("without flock: SessionStart still materializes, but no Stop ever pushes", async () => {
    setFlockForTests(null);
    expect(await materializeClaudeMd(V2, paths)).toBe("unsupported");
    expect(await Bun.file(paths.file).text()).toBe(V2);

    await edit("edited");
    let synced = false;
    const outcome = await stopClaudeMd(async () => {
      synced = true;
    }, paths);

    expect(outcome).toBe("unsupported");
    expect(synced).toBe(false); // the DB is never written without the lock
    expect(await Bun.file(paths.file).exists()).toBe(false); // restored as before (no .bak)
  });

  test("a live SessionStart paused mid-transition is never robbed by a Stop", async () => {
    // The stale-lock variant of the race: however long the holder pauses between
    // its file and record writes, a Stop cannot take the lock from it.
    await materializeClaudeMd(V1, paths);
    let reachedPause!: () => void;
    const paused = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessionStartB = materializeClaudeMd(V2, paths, {
      testPauses: {
        afterFileWrite: async () => {
          reachedPause();
          await gate;
        },
      },
    });
    await paused;

    const outcome = await stopClaudeMd(async () => {}, paths, { lockWaitMs: 300 });
    expect(outcome).toBe("busy");
    expect(await Bun.file(paths.file).text()).toBe(V2); // untouched mid-transition

    release();
    expect(await sessionStartB).toBe("materialized");
    expect(await stop()).toBeNull(); // v2 with its own record: hook-written
  });
});

describe("a lineage write that fails leaves nothing pushable", () => {
  let root: string;
  let paths: ClaudeMdSessionPaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-md-write-failure-"));
    paths = {
      file: join(root, "home/.claude/CLAUDE.md"),
      backup: join(root, "home/.claude/CLAUDE.md.bak"),
      record: join(root, "lineage.json"),
      lock: join(root, "home/.claude/CLAUDE.md.lock"),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stop = async (options: Parameters<typeof stopClaudeMd>[2] = {}) => {
    let sent: ProfilePayload["body"] | null = null;
    await stopClaudeMd(
      async (body) => {
        sent = body;
      },
      paths,
      options,
    );
    return sent;
  };
  const failing = async () => {
    throw new Error("injected write failure");
  };
  /**
   * A record whose temp file name exceeds NAME_MAX: every atomic write of it
   * fails for real (ENAMETOOLONG, for root too), while the record itself can
   * still be written directly and read.
   */
  const useUnwritableRecord = () => {
    paths = { ...paths, record: join(root, "r".repeat(230)) };
  };

  test("a SessionStart that cannot mark the record writes nothing", async () => {
    // The reviewed case: the record write failed silently, the Stop found no
    // record and sent the materialization unconditionally over a newer DB value.
    useUnwritableRecord();

    await expect(materializeClaudeMd(V2, paths)).rejects.toThrow();
    expect(await Bun.file(paths.file).exists()).toBe(false);
    expect(await stop()).toBeNull();
  });

  test("a SessionStart whose final record write fails leaves the file unpushable", async () => {
    const outcome = await materializeClaudeMd(V2, paths, {
      testPauses: { beforeRecordCommit: failing },
    });

    expect(outcome).toBe("materialized"); // the session still gets the DB value
    expect(await Bun.file(paths.file).text()).toBe(V2);
    expect(await Bun.file(paths.record).text()).toBe(CLAUDE_MD_PENDING_RECORD);
    await Bun.write(paths.file, "edited"); // even an edit on top stays unsynced
    expect(await stop()).toBeNull();
  });

  test("a Stop that cannot mark the record restores nothing", async () => {
    // The reviewed case: the restore's record write failed silently, the record
    // kept describing v2, and a second Stop sent the restored v1 against v2 — a
    // compare-and-set the DB, still at v2, accepts.
    useUnwritableRecord();
    await Bun.write(paths.backup, V1);
    await Bun.write(paths.file, V2);
    await Bun.write(paths.record, JSON.stringify({ written: h(V2), base: h(V2) }));

    expect(await stop()).toBeNull(); // v2 is the hook's own write
    expect(await Bun.file(paths.file).text()).toBe(V2); // not restored: file and record still agree
    expect(await Bun.file(paths.backup).text()).toBe(V1); // the .bak waits for a later Stop
    expect(await stop()).toBeNull();
  });

  test("a Stop whose final record write fails leaves the restored copy unpushable", async () => {
    await Bun.write(paths.file, V1); // before the session
    await materializeClaudeMd(V2, paths);

    expect(await stop({ testPauses: { beforeRecordCommit: failing } })).toBeNull();
    expect(await Bun.file(paths.file).text()).toBe(V1); // restored
    expect(await Bun.file(paths.record).text()).toBe(CLAUDE_MD_PENDING_RECORD);
    expect(await stop()).toBeNull(); // the double Stop does not send v1 against v2
  });

  // A read-only directory is the real failure here, and it does not stop root.
  test.skipIf(process.getuid?.() === 0)(
    "a Stop that cannot remove the file keeps its record",
    async () => {
      await materializeClaudeMd(V2, paths); // nothing on disk before: no .bak
      const dir = dirname(paths.file);
      await chmod(dir, 0o555); // the file can no longer be removed
      try {
        expect(await stop()).toBeNull();
        expect(await Bun.file(paths.file).text()).toBe(V2);
      } finally {
        await chmod(dir, 0o755);
      }
      expect(await stop()).toBeNull(); // v2 still has its record: hook-written
    },
  );
});

describe("default paths", () => {
  test("the lineage record lives next to the file it describes, not in /tmp", () => {
    const { file, backup, record } = DEFAULT_CLAUDE_MD_SESSION_PATHS;
    expect(record).toBe(`${file}.lineage.json`);
    expect(backup).toBe(`${file}.bak`);
  });
});
