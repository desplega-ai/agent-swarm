import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPreToolUseBlock } from "../hooks/codex-hook";
import { gitRemoteOrigin, guardGhPrRoom, type PrRoomGuardDeps } from "../hooks/pr-room-guard";
import { expectChildOk, runChild } from "./test-proc";

const ROOM_LINE = "PR room: prr-abcde23457";
const BLOCK_REASON =
  'This repo uses PR rooms. Create the room first with the pr-room skill (app action createRoom). Then pass the returned prBody with --body-file. The body must contain the line "PR room: prr-...".';

function fakeDeps(overrides: Partial<PrRoomGuardDeps> = {}): PrRoomGuardDeps {
  return {
    env: { PR_ROOM_REPOS: "owner/repo" },
    readFile: async () => "No room marker",
    remoteOrigin: async () => "https://github.com/owner/repo.git",
    ...overrides,
  };
}

const check = (command: string, deps = fakeDeps()) => guardGhPrRoom({ command }, "/w", deps);

describe("guardGhPrRoom", () => {
  test.each([undefined, "", " ,  , "])("allows disabled configuration %p", async (value) => {
    expect(
      await check(
        "gh pr create -R owner/repo -b plain",
        fakeDeps({ env: { PR_ROOM_REPOS: value } }),
      ),
    ).toBeNull();
  });

  test("blocks a configured repo without a room marker", async () => {
    expect(await check("gh pr create --repo owner/repo --body plain")).toBe(BLOCK_REASON);
    expect(await check("gh pr create -Rowner/repo")).toBe(BLOCK_REASON);
  });

  test("allows a marker in the inline body", async () => {
    expect(await check(`gh pr create -R owner/repo --body 'Summary\n${ROOM_LINE}'`)).toBeNull();
  });

  test("resolves body files relative to cd", async () => {
    const paths: string[] = [];
    const deps = fakeDeps({
      readFile: async (path) => {
        paths.push(path);
        return ROOM_LINE;
      },
    });
    expect(
      await check("cd /checkout && gh pr create -R owner/repo --body-file body.md", deps),
    ).toBeNull();
    expect(paths).toEqual(["/checkout/body.md"]);
  });

  test("allows a heredoc body with a marker", async () => {
    expect(
      await check(`gh pr create -R owner/repo --body-file - <<'EOF'\n${ROOM_LINE}\nEOF`),
    ).toBeNull();
  });

  test("blocks resolved files and heredocs without a marker", async () => {
    expect(await check("gh pr create -R owner/repo -F body.md")).toBe(BLOCK_REASON);
    expect(await check("gh pr create -R owner/repo -F - <<'EOF'\nplain\nEOF")).toBe(BLOCK_REASON);
  });

  test("allows another repo without reading its body", async () => {
    expect(await check("gh pr create -R other/repo -b plain")).toBeNull();
  });

  test.each([
    "GH_REPO=owner/repo gh pr create -b plain",
    "export GH_REPO=owner/repo && gh pr create -b plain",
  ])("checks command targeting: %s", async (command) => {
    expect(await check(command)).toBe(BLOCK_REASON);
  });

  test("allows an ambiguous target unless every candidate is configured", async () => {
    const otherCheckout = fakeDeps({ remoteOrigin: async () => "https://github.com/other/repo" });
    expect(await check("GH_REPO=owner/repo && gh pr create -b plain", otherCheckout)).toBeNull();
    expect(await check("GH_REPO=owner/repo && gh pr create -b plain")).toBe(BLOCK_REASON);
    expect(await check("gh pr create -R owner/repo -R other/repo -b plain")).toBeNull();
  });

  test("checks inherited GH_REPO and honors an explicit override", async () => {
    const deps = fakeDeps({ env: { PR_ROOM_REPOS: "owner/repo", GH_REPO: "owner/repo" } });
    expect(await check("gh pr create -b plain", deps)).toBe(BLOCK_REASON);
    expect(await check("gh pr create -R other/repo -b plain", deps)).toBeNull();
  });

  test("trims configured repos and matches case insensitively", async () => {
    const deps = fakeDeps({ env: { PR_ROOM_REPOS: " other/repo, OWNER/REPO , " } });
    expect(await check("gh -R Owner/Repo pr create -b plain", deps)).toBe(BLOCK_REASON);
  });

  test("allows edits and unrelated commands", async () => {
    expect(await check("gh pr edit 123 -R owner/repo -b plain")).toBeNull();
    expect(await check("gh pr view 123 -R owner/repo")).toBeNull();
    expect(await guardGhPrRoom(undefined, "/w", fakeDeps())).toBeNull();
  });

  test.each([
    "https://github.com/Owner/Repo.git",
    "https://github.com/Owner/Repo",
    "git@github.com:Owner/Repo.git",
    "ssh://git@github.com/Owner/Repo.git",
  ])("resolves checkout remote %s", async (remote) => {
    const lookups: string[] = [];
    const deps = fakeDeps({
      remoteOrigin: async (cwd) => {
        lookups.push(cwd);
        return remote;
      },
    });
    expect(await check("cd /checkout && gh pr create -b plain", deps)).toBe(BLOCK_REASON);
    expect(lookups).toEqual(["/checkout"]);
  });

  test("allows failed remote lookup and unsupported remote forms", async () => {
    expect(
      await check("gh pr create -b plain", fakeDeps({ remoteOrigin: async () => "local/path" })),
    ).toBeNull();
    expect(
      await check(
        "gh pr create -b plain",
        fakeDeps({
          remoteOrigin: async () => {
            throw new Error("no checkout");
          },
        }),
      ),
    ).toBeNull();
  });

  // git exports GIT_DIR to a pre-push hook in a linked worktree. The lookup then reads that repo.
  test.skipIf(process.env.GIT_DIR !== undefined)(
    "allows a checkout remote lookup that does not finish",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pr-room-fifo-"));
      try {
        expectChildOk(await runChild(["git", "init", "-q", dir]), "git init");
        await rm(join(dir, ".git", "config"));
        expectChildOk(await runChild(["mkfifo", join(dir, ".git", "config")]), "mkfifo");
        await expect(gitRemoteOrigin(dir, 200)).rejects.toThrow();
        const deps = fakeDeps({ remoteOrigin: (cwd) => gitRemoteOrigin(cwd, 200) });
        expect(await guardGhPrRoom({ command: "gh pr create -b plain" }, dir, deps)).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    'gh pr create -R "$UNKNOWN" -b plain',
    'gh pr create -R owner/repo -b "$UNKNOWN"',
    'gh pr create -R owner/repo -F "$UNKNOWN"',
    "cd - && gh pr create -R owner/repo -b plain",
    'cd "$UNKNOWN" && gh pr create -b plain',
    "read GH_REPO && gh pr create -b plain",
  ])("allows unresolved inputs: %s", async (command) => {
    expect(await check(command)).toBeNull();
  });

  test("allows unreadable body files", async () => {
    const deps = fakeDeps({
      readFile: async () => {
        throw new Error("unreadable");
      },
    });
    expect(await check("gh pr create -R owner/repo -F missing.md", deps)).toBeNull();
  });

  test("resolves known variables without changing leak guard texts", async () => {
    expect(await check('REPO=owner/repo && gh pr create -R "$REPO" -b plain')).toBe(BLOCK_REASON);
    expect(await check(`BODY='${ROOM_LINE}' && gh pr create -R owner/repo -b "$BODY"`)).toBeNull();
  });

  test.each([
    "cat room.md | gh pr create -R owner/repo -F -",
    "printf plain | gh pr create -R owner/repo -F -",
    "gh pr create -R owner/repo -b $(cat room.md)",
    "gh pr create -R owner/repo --fill",
    "gh pr create -R owner/repo -f",
    "gh pr create -R owner/repo --fill-first",
    "gh pr create -R owner/repo --fill-verbose",
    "gh pr create -R owner/repo -T template.md -b plain",
    "gh pr create -R owner/repo --template=template.md",
    "gh pr create -R owner/repo -dw -b plain",
    "gh pr create -R owner/repo --web",
    "gh pr create -R owner/repo -e",
    "gh pr create -R owner/repo --editor",
    "gh pr create -R owner/repo --recover input.json",
  ])("allows a body the guard cannot read: %s", async (command) => {
    expect(await check(command)).toBeNull();
  });

  test.each([
    "PR room: prr-abcde2345",
    "PR room: prr-abcde234578",
    "PR room: prr-ABCDE23457",
    "prefix PR room: prr-abcde23457",
  ])("rejects an invalid marker: %s", async (line) => {
    expect(await check(`gh pr create -R owner/repo -b '${line}'`)).toBe(BLOCK_REASON);
  });

  test("does not accept a marker only in the title", async () => {
    expect(await check(`gh pr create -R owner/repo -t '${ROOM_LINE}' -b plain`)).toBe(BLOCK_REASON);
  });

  test("checks every create invocation", async () => {
    expect(await check(`gh pr edit 1 -b plain && gh pr create -R owner/repo -b plain`)).toBe(
      BLOCK_REASON,
    );
  });

  test("Codex runs the room guard after the leak guard, including app-server sessions", async () => {
    const roomDeps = fakeDeps();
    const leakDeps = {
      env: { SWARM_CODEX_APP_SERVER: "1" },
      readFile: roomDeps.readFile,
      repoVisibility: async () => "PUBLIC",
    };
    const msg = {
      hook_event_name: "PreToolUse",
      cwd: "/w",
      tool_input: { command: "gh pr create -R owner/repo -b plain" },
    };
    expect(await codexPreToolUseBlock(msg, leakDeps, roomDeps)).toBe(BLOCK_REASON);
    const leaky = {
      ...msg,
      tool_input: {
        command:
          "gh pr create -R owner/repo -b 'https://acme.slack.com/archives/C01234567/p1700000000000000'",
      },
    };
    expect(await codexPreToolUseBlock(leaky, leakDeps, roomDeps)).toContain("PR body leak check:");
    expect(
      await codexPreToolUseBlock({ ...msg, hook_event_name: "PostToolUse" }, leakDeps, roomDeps),
    ).toBeNull();
  });
});
