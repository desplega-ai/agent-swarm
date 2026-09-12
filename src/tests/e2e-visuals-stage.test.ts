import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChild } from "./test-proc";

const SCRIPT = join(import.meta.dir, "../../scripts/e2e/visuals-stage.sh");

let outRoot: string;
let stagedRoot: string;

beforeEach(() => {
  outRoot = mkdtempSync(join(tmpdir(), "visuals-stage-out-"));
  stagedRoot = join(mkdtempSync(join(tmpdir(), "visuals-stage-target-")), "staged");
});

afterEach(() => {
  rmSync(outRoot, { recursive: true, force: true });
  rmSync(stagedRoot, { recursive: true, force: true });
});

function writeProfile(profile: string) {
  const dir = join(outRoot, profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify({ profile }));
  writeFileSync(join(dir, "channel.png"), "png-bytes");
  mkdirSync(join(dir, "frames"), { recursive: true });
  return dir;
}

function writeFrame(profileDir: string, relPath: string, contents = "frame-bytes") {
  const full = join(profileDir, "frames", relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

async function stage() {
  return runChild(["bash", SCRIPT, outRoot, stagedRoot]);
}

describe("visuals-stage.sh", () => {
  test("stages nested scenario/thread frames at their original relative path", async () => {
    const dir = writeProfile("v2");
    writeFrame(dir, "slack-mention/mention/final-thread.png");
    writeFrame(dir, "slack-mention/mention/final-desktop.gif");
    writeFrame(dir, "slack-delegation/delegation-child-result/final-desktop.png");

    const result = await stage();
    expect(result.exitCode).toBe(0);

    const staged = Bun.file(
      join(stagedRoot, "v2", "frames", "slack-mention", "mention", "final-thread.png"),
    );
    expect(await staged.exists()).toBe(true);
    expect(await staged.text()).toBe("frame-bytes");

    const gif = Bun.file(
      join(stagedRoot, "v2", "frames", "slack-mention", "mention", "final-desktop.gif"),
    );
    expect(await gif.exists()).toBe(true);

    const other = Bun.file(
      join(
        stagedRoot,
        "v2",
        "frames",
        "slack-delegation",
        "delegation-child-result",
        "final-desktop.png",
      ),
    );
    expect(await other.exists()).toBe(true);
  });

  test("rejects a symlinked intermediate frame directory", async () => {
    const dir = writeProfile("v2");
    const realDir = join(dir, "frames", "real-scenario");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "thread"), "");
    rmSync(join(realDir, "thread"));
    mkdirSync(join(realDir, "thread"), { recursive: true });
    writeFileSync(join(realDir, "thread", "final.png"), "frame-bytes");

    // Symlink a second scenario dir's "thread" segment at the intermediate level.
    const evilScenario = join(dir, "frames", "evil-scenario");
    mkdirSync(evilScenario, { recursive: true });
    symlinkSync(join(realDir, "thread"), join(evilScenario, "thread"));

    const result = await stage();
    // The good scenario still stages one frame, so overall exit is 0 — assert the symlinked
    // one specifically never lands, either flagged or simply absent from the traversal.
    expect(result.exitCode).toBe(0);
    const evilStaged = Bun.file(
      join(stagedRoot, "v2", "frames", "evil-scenario", "thread", "final.png"),
    );
    expect(await evilStaged.exists()).toBe(false);
  });

  // A literal ".." path component cannot exist as a real filesystem entry — the OS always
  // resolves it to the parent directory, and `find` (without `-L`) never emits "." or ".."
  // as traversal results. So the script's `case "/$rel_path/" in */../*)` guard is defense in
  // depth for a rel_path construction bug, not something a crafted artifact can trigger via a
  // real directory name. This test instead proves the adjacent, actually reachable guard: a
  // directory segment outside the safe charset is rejected while safe siblings still stage.
  test("rejects an unsafe directory segment but keeps safe siblings", async () => {
    const dir = writeProfile("v2");
    writeFrame(dir, "scenario/thread/ok.png");
    writeFrame(dir, "scenario/th read/bad.png");

    const result = await stage();
    expect(result.exitCode).toBe(0);
    const bad = Bun.file(join(stagedRoot, "v2", "frames", "scenario", "th read", "bad.png"));
    expect(await bad.exists()).toBe(false);
    const ok = Bun.file(join(stagedRoot, "v2", "frames", "scenario", "thread", "ok.png"));
    expect(await ok.exists()).toBe(true);
  });

  test("rejects an unsafe leaf frame name but keeps safe siblings", async () => {
    const dir = writeProfile("v2");
    writeFrame(dir, "scenario/thread/ok.png");
    writeFrame(dir, "scenario/thread/bad name!.png");

    const result = await stage();
    expect(result.exitCode).toBe(0);
    const bad = Bun.file(join(stagedRoot, "v2", "frames", "scenario", "thread", "bad name!.png"));
    expect(await bad.exists()).toBe(false);
    const ok = Bun.file(join(stagedRoot, "v2", "frames", "scenario", "thread", "ok.png"));
    expect(await ok.exists()).toBe(true);
  });

  test("fails the whole run when a profile stages zero frames", async () => {
    const dir = writeProfile("v2");
    // frames/ exists but every entry is invalid, so nothing gets staged.
    writeFrame(dir, "scenario/thread/bad name!.png");

    const result = await stage();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Staged zero frames");
  });

  test("fails when frames/ is missing entirely", async () => {
    const dir = join(outRoot, "v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), "{}");
    writeFileSync(join(dir, "channel.png"), "png-bytes");

    const result = await stage();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Missing frames directory");
  });
});
