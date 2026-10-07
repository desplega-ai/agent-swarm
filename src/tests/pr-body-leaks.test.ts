import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { checkPrBodyLeaks, shouldCheckLeaks } from "../../scripts/check-pr-body";
import { codexPreToolUseBlock } from "../hooks/codex-hook";
import {
  checkGhPrCommand,
  guardGhPrBody,
  type PrBodyGuardDeps,
  parseGhPrCommands,
  shellCommandOf,
} from "../hooks/pr-body-guard";
import { AGENT_FS_PATH_RULE_ENABLED, findPrBodyLeaks, LEAK_RULES } from "../utils/pr-body-leaks";

// Sentinels are assembled at runtime so this file never holds a real-looking
// identifier as a source literal.
const join = (...parts: string[]) => parts.join("");
const hexWithLetter = () => `a${randomUUID().replace(/-/g, "").slice(0, 7)}`;
const slackId = (kind: "C" | "D" | "U") => join(kind, "0", "AB12CD34E");
const slackTs = () => `${1_700_000_000 + 88_356_391}.${291_819}`;
const slackLink = () =>
  join("https://acme.", "slack", ".com/", "archives/", slackId("C"), "/p", "1788356391291819");
const dashboardLink = () =>
  join("https://", ["app", "agent-swarm", "dev"].join("."), "/tasks/", randomUUID());
const agentFsLink = () => join("https://", ["live", "agent-fs", "dev"].join("."), "/file/~/x/y");
const agentFsPath = () => join("thoughts", "/", randomUUID(), "/reports/r.md");
const presignedEmbed = () =>
  join(
    "![qa](https://fly.storage.tigris.dev/bucket/",
    agentFsPath(),
    ".png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc&X-Amz-Signature=",
    "f".repeat(64),
    ")",
  );

const NORMAL_BODY = `## Intent

A maintainer asked that the Slack handler retry on 429. Fixes #1234.

## Decisions & trade-offs

- The retry runs 3 times with backoff. Cost: a slow channel delays the reply by up to 7s.

## Proof of work

- \`bun run test:root -- src/tests/slack.test.ts\`: 42 pass, 0 fail.
- CI run 18234567890 passed on commit 3f2a9c1.

## Urgency

- [ ] asap
- [ ] this week
- [x] nice to have
`;

describe("findPrBodyLeaks: positive controls", () => {
  const cases: Array<[string, () => string]> = [
    ["slack-id", () => `Reported in channel ${slackId("C")} by ${slackId("U")}.`],
    ["slack-id", () => `DM ${slackId("D")}`],
    ["slack-ts", () => `thread ts ${slackTs()}`],
    ["slack-link", () => `See ${slackLink()}`],
    ["swarm-dashboard-link", () => `Run: ${dashboardLink()}`],
    ["agent-fs-link", () => `Report: ${agentFsLink()}`],
    ["swarm-task-ref", () => `Follow-up of task ${hexWithLetter()}.`],
    ["swarm-task-ref", () => `parentTaskId: \`${hexWithLetter()}-1111-2222-3333-444444444444\``],
    ["swarm-task-ref", () => `swarm run ${hexWithLetter()}`],
    ["private-chat-quote", () => `Taras in ${"DM"}: "it would be nice to explain the motivation"`],
    [
      "private-chat-quote",
      () => `From the ${"Slack"} thread, Eze wrote “the deploy is stuck again today”`,
    ],
    ["private-chat-quote", () => `The ask, verbatim from ${"Slack"}:\n> please make it retry`],
  ];
  for (const [category, build] of cases) {
    test(`${category}: ${build().slice(0, 24)}...`, () => {
      expect(findPrBodyLeaks(build())).toContain(category as never);
    });
  }

  test("agent-fs-path rule matches but stays off behind its constant", () => {
    const rule = LEAK_RULES.find((r) => r.category === "agent-fs-path");
    expect(rule?.pattern.test(`Durable copy: ${agentFsPath()}`)).toBe(true);
    expect(AGENT_FS_PATH_RULE_ENABLED).toBe(false);
    expect(rule?.enabled).toBe(false);
    expect(findPrBodyLeaks(`Durable copies: ${agentFsPath()}`)).toEqual([]);
  });

  test("results name categories once, never the matched text", () => {
    const id = slackId("C");
    const leaks = findPrBodyLeaks(`${id} and ${slackId("U")} and ${slackTs()}`);
    expect(leaks).toEqual(["slack-id", "slack-ts"]);
    expect(checkPrBodyLeaks(`see ${id}`).join("\n")).not.toContain(id);
  });
});

describe("findPrBodyLeaks: negative controls", () => {
  test("a normal PR body", () => {
    expect(findPrBodyLeaks(NORMAL_BODY)).toEqual([]);
  });

  test("a code UUID in a fixture", () => {
    const body = `\`\`\`ts\nconst agentId = "${randomUUID()}";\nconst run = { taskId: "${"0".repeat(8)}-0000-0000-0000-000000000000" };\n\`\`\``;
    expect(findPrBodyLeaks(body)).toEqual([]);
  });

  test("a fenced code example with a fresh UUID taskId", () => {
    const body = `## Proof of work\n\n\`\`\`ts\nconst taskId = "${randomUUID()}";\nawait store({ parentTaskId: "${randomUUID()}" });\n\`\`\`\n`;
    expect(findPrBodyLeaks(body)).toEqual([]);
    // The same line outside the fence is still a ref. The rule needs a letter in
    // the first group, so a random UUID would flake (~2% are all digits there).
    const ref = `${hexWithLetter()}-1111-2222-3333-444444444444`;
    expect(findPrBodyLeaks(`taskId = "${ref}"`)).toEqual(["swarm-task-ref"]);
  });

  test("a fence does not hide Slack or dashboard links", () => {
    expect(findPrBodyLeaks(`\`\`\`\n${slackLink()}\n\`\`\`\n`)).toContain("slack-link");
  });

  test("a run label followed by an 8-char SHA", () => {
    const sha = hexWithLetter();
    expect(findPrBodyLeaks(`CI run ${sha} passed. Test run: ${sha}.`)).toEqual([]);
    expect(findPrBodyLeaks(`workflow run ${sha}`)).toEqual(["swarm-task-ref"]);
    expect(findPrBodyLeaks(`run_id: ${sha}`)).toEqual(["swarm-task-ref"]);
  });

  test("a commit SHA", () => {
    const sha = randomUUID().replace(/-/g, "").slice(0, 40);
    expect(findPrBodyLeaks(`Reverts ${sha} (commit ${sha.slice(0, 7)}), see #12.`)).toEqual([]);
  });

  test("a presigned QA embed", () => {
    expect(findPrBodyLeaks(`## Proof of work\n\n${presignedEmbed()}\n`)).toEqual([]);
  });

  test("prose that mentions Slack or DMs without quoting anyone", () => {
    const body =
      'The Slack handler now returns "ok_with_retry_after" on 429. DM delivery is unchanged.';
    expect(findPrBodyLeaks(body)).toEqual([]);
  });

  test("file names that contain slack, followed by a quote", () => {
    const body = [
      '`docs/integrations/slack.mdx`: all three said "Assistant View"; fixed to "Agent View".',
      "`src/tests/slack-render-v2.test.ts:1480`, “resumes an unfinished outcome by thread,” fails.",
    ].join("\n");
    expect(findPrBodyLeaks(body)).toEqual([]);
  });

  test("the repo PR template passes its own check", async () => {
    const template = await Bun.file(".github/pull_request_template.md").text();
    expect(findPrBodyLeaks(template)).toEqual([]);
  });
});

describe("findPrBodyLeaks: Swarm provenance allowlist", () => {
  const provenance = (...lines: string[]) =>
    `${NORMAL_BODY}\n## Swarm provenance <!-- bot -->\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`;

  test("task, session, agent-fs and Slack permalinks pass inside the section", () => {
    const body = provenance(
      `Task: ${dashboardLink()} · tree: ${dashboardLink().replace("/tasks/", "/sessions/")}`,
      `Ask: ${slackLink()}?thread_ts=${slackTs()}&cid=${slackId("D")}`,
      `Plan: ${agentFsLink()} (durable: ${agentFsPath()})`,
      `Follow-up of task ${hexWithLetter()}.`,
    );
    expect(findPrBodyLeaks(body)).toEqual([]);
  });

  test("the same links outside the section still fail", () => {
    const body = `${NORMAL_BODY}\nSee ${slackLink()} and ${dashboardLink()}.\n${provenance()}`;
    // The permalink's embedded channel id also counts outside the section.
    expect(findPrBodyLeaks(body)).toEqual(["slack-id", "slack-link", "swarm-dashboard-link"]);
  });

  test("bare Slack ids, ts values and private-chat quotes stay blocked inside it", () => {
    expect(findPrBodyLeaks(provenance(`Channel ${slackId("C")}`))).toEqual(["slack-id"]);
    expect(findPrBodyLeaks(provenance(`ts ${slackTs()}`))).toEqual(["slack-ts"]);
    expect(
      findPrBodyLeaks(provenance(`Taras in ${"DM"}: "it would be nice to explain the motivation"`)),
    ).toEqual(["private-chat-quote"]);
  });

  test("the section ends at the next heading, and a fenced heading does not open it", () => {
    const after = `${provenance(`Task: ${dashboardLink()}`)}\n## Notes\n\n${dashboardLink()}\n`;
    expect(findPrBodyLeaks(after)).toEqual(["swarm-dashboard-link"]);
    const fenced = `\`\`\`md\n## Swarm provenance\n\`\`\`\n${slackLink()}\n`;
    expect(findPrBodyLeaks(fenced)).toContain("slack-link");
  });

  test("the heading matches case-insensitively with a trailing marker", () => {
    const body = `## swarm  PROVENANCE <!-- bot -->\n\n- ${dashboardLink()}\n`;
    expect(findPrBodyLeaks(body)).toEqual([]);
  });
});

describe("check-pr-body leak gating", () => {
  test("only bot authors, or a local run without an author, get the leak check", () => {
    expect(shouldCheckLeaks(undefined)).toBe(true);
    expect(shouldCheckLeaks("")).toBe(true);
    expect(shouldCheckLeaks("desplega-bot")).toBe(true);
    expect(shouldCheckLeaks("desplega-bot[bot]")).toBe(true);
    expect(shouldCheckLeaks("octocat")).toBe(false);
  });
});

function fakeDeps(overrides: Partial<PrBodyGuardDeps> = {}) {
  const calls = { visibility: 0, reads: [] as string[] };
  const deps: PrBodyGuardDeps = {
    env: { HOME: "/home/test" },
    readFile: async (path) => {
      calls.reads.push(path);
      throw new Error("missing");
    },
    repoVisibility: async () => {
      calls.visibility++;
      return "PUBLIC";
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("parseGhPrCommands", () => {
  test("tracks cd, --repo and --body-file", () => {
    const calls = parseGhPrCommands(
      'cd /tmp/wt && gh pr create --title "t" --body-file body.md --repo o/r',
      "/start",
    );
    expect(calls).toEqual([
      {
        cwd: "/tmp/wt",
        repos: ["o/r"],
        alsoCheckout: false,
        unknownTarget: false,
        texts: ["t"],
        bodyFiles: ["body.md"],
        unresolvedBodyFiles: [],
        opaqueBody: false,
      },
    ]);
  });

  test("detects inline bodies, edit, and = forms; ignores other gh calls", () => {
    expect(parseGhPrCommands("gh pr edit 12 -b 'x'", "/w")[0]?.texts).toEqual(["x"]);
    expect(parseGhPrCommands("gh pr edit 12 --body-file=-", "/w")[0]?.opaqueBody).toBe(true);
    expect(parseGhPrCommands("gh pr view 12 --json body", "/w")).toEqual([]);
    expect(parseGhPrCommands("echo gh pr create", "/w")).toEqual([]);
  });

  test("a heredoc, here-string or < file feeds --body-file -", () => {
    const heredoc = parseGhPrCommands("gh pr create -F - <<'EOF'\nline one\nEOF\necho done", "/w");
    expect(heredoc).toHaveLength(1);
    expect(heredoc[0]?.texts).toEqual(["line one"]);
    expect(parseGhPrCommands("gh pr create -F - <<< 'hi'", "/w")[0]?.texts).toEqual(["hi"]);
    expect(parseGhPrCommands("gh pr create -F - < b.md", "/w")[0]?.bodyFiles).toEqual(["b.md"]);
    expect(parseGhPrCommands("cat b.md | gh pr create -F -", "/w")[0]?.opaqueBody).toBe(true);
  });
});

describe("checkGhPrCommand", () => {
  const leakyInline = () => `gh pr create --title t --body "Context: ${slackLink()}"`;

  test("a clean body is allowed without a visibility lookup", async () => {
    const { deps, calls } = fakeDeps();
    expect(
      await checkGhPrCommand('gh pr create --title t --body "Fixes #1."', "/w", deps),
    ).toBeNull();
    expect(calls.visibility).toBe(0);
  });

  test("a leaky inline body on a public repo is blocked by category only", async () => {
    const { deps } = fakeDeps();
    const command = leakyInline();
    const reason = await checkGhPrCommand(command, "/w", deps);
    expect(reason).toContain("slack-link");
    expect(reason).not.toContain(slackId("C"));
  });

  test("a heredoc body is scanned", async () => {
    const { deps } = fakeDeps();
    const command = `gh pr create --title t --body "$(cat <<'EOF'\n## Intent\nFollow-up of task ${hexWithLetter()}, he said "hi".\nEOF\n)"`;
    expect(await checkGhPrCommand(command, "/w", deps)).toContain("swarm-task-ref");
  });

  test("private and internal repos are allowed", async () => {
    for (const visibility of ["PRIVATE", "INTERNAL"]) {
      const { deps } = fakeDeps({ repoVisibility: async () => visibility });
      expect(await checkGhPrCommand(leakyInline(), "/w", deps)).toBeNull();
    }
  });

  test("a failed visibility lookup fails closed when the body leaks", async () => {
    const { deps } = fakeDeps({
      repoVisibility: async () => {
        throw new Error("gh: network down");
      },
    });
    expect(await checkGhPrCommand(leakyInline(), "/w", deps)).toContain("could not be confirmed");
  });

  test("--body-file is read relative to the cd target", async () => {
    const { deps, calls } = fakeDeps({
      readFile: async (path) => {
        calls.reads.push(path);
        return `Follow-up of task ${hexWithLetter()}`;
      },
    });
    const reason = await checkGhPrCommand(
      "cd ~/wt && gh pr edit 7 --body-file notes/body.md",
      "/w",
      deps,
    );
    expect(calls.reads).toEqual(["/home/test/wt/notes/body.md"]);
    expect(reason).toContain("swarm-task-ref");
  });

  test("an unreadable --body-file fails closed on a public repo, open on a private one", async () => {
    const command = "gh pr create -t t -F /nope/body.md";
    expect(await checkGhPrCommand(command, "/w", fakeDeps().deps)).toContain("could not read");
    const priv = fakeDeps({ repoVisibility: async () => "PRIVATE" });
    expect(await checkGhPrCommand(command, "/w", priv.deps)).toBeNull();
  });

  test("an unrelated shell comment does not block a clean body", async () => {
    const { deps, calls } = fakeDeps();
    const command = `# follow-up of task ${hexWithLetter()}\ngh pr create -t t --body "Fixes #1."`;
    expect(await checkGhPrCommand(command, "/w", deps)).toBeNull();
    expect(calls.visibility).toBe(0);
  });

  test("an unquoted $(cat <<EOF) body falls back to scanning the whole command", async () => {
    const { deps } = fakeDeps();
    const command = `gh pr create -t t --body $(cat <<'EOF'\nSee ${slackLink()}\nEOF\n)`;
    expect(await checkGhPrCommand(command, "/w", deps)).toContain("slack-link");
  });

  test("an unexpanded shell variable body is allowed (fail open, CI is the backstop)", async () => {
    const { deps, calls } = fakeDeps();
    expect(await checkGhPrCommand('gh pr create -t t --body "$BODY"', "/w", deps)).toBeNull();
    expect(calls.visibility).toBe(0);
  });
});

// Review finding 5: valid gh forms that bypassed the guard. The current checkout
// is PRIVATE; the real target (repo flag, PR URL or cd target) is PUBLIC.
describe("checkGhPrCommand: resolves the real target and body", () => {
  const flagged = () => `Context: ${slackLink()}`;
  const publicTarget = () => {
    const seen: Array<{ cwd: string; repo?: string }> = [];
    const { deps, calls } = fakeDeps({
      readFile: async (path) => {
        calls.reads.push(path);
        return flagged();
      },
      repoVisibility: async (target) => {
        seen.push(target);
        const isPublic = target.repo ? target.repo === "public/example" : target.cwd === "/public";
        return isPublic ? "PUBLIC" : "PRIVATE";
      },
    });
    return { deps, calls, seen };
  };

  test("gh -R before pr", async () => {
    const { deps } = publicTarget();
    const command = `gh -R public/example pr create --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
  });

  test("attached -Rrepo", async () => {
    const { deps } = publicTarget();
    const command = `gh pr create -Rpublic/example --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
  });

  test("attached -R=repo", async () => {
    const { deps } = publicTarget();
    const command = `gh pr create -R=public/example --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
  });

  test('attached -b"body"', async () => {
    const { deps } = publicTarget();
    const command = `gh pr create -R public/example -b"${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
  });

  test("attached -Fbody.md", async () => {
    const { deps, calls } = publicTarget();
    const command = "gh pr create -R public/example -Fbody.md";
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(calls.reads).toEqual(["/private/body.md"]);
  });

  test("cd -- dir", async () => {
    const { deps } = publicTarget();
    const command = `cd -- /public && gh pr create --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
  });

  test("gh pr edit with a PR URL", async () => {
    const { deps, seen } = publicTarget();
    const command = `gh pr edit https://github.com/public/example/pull/1 --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  test("GH_REPO, as a prefix or exported", async () => {
    for (const command of [
      `GH_REPO=public/example gh pr create --body "${flagged()}"`,
      `export GH_REPO=public/example && gh pr create --body "${flagged()}"`,
    ]) {
      expect(await checkGhPrCommand(command, "/private", publicTarget().deps)).toContain(
        "slack-link",
      );
    }
  });

  test("an unresolvable cd target fails closed", async () => {
    const { deps, seen } = publicTarget();
    const command = `cd - && gh pr create --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("could not be confirmed");
    expect(seen).toEqual([]);
  });

  test("forms that already blocked stay blocked", async () => {
    for (const command of [
      `cd /public && gh pr create --body "${flagged()}"`,
      "cd /public && gh pr create --body-file body.md",
      `cd /public && gh pr create -F - <<'EOF'\n${flagged()}\nEOF`,
    ]) {
      expect(await checkGhPrCommand(command, "/private", publicTarget().deps)).toContain(
        "slack-link",
      );
    }
  });

  test("the same forms on a private target are allowed", async () => {
    const { deps } = publicTarget();
    const command = `gh -R private/example pr create -b"${flagged()}"`;
    expect(await checkGhPrCommand(command, "/public", deps)).toBeNull();
  });

  // A `gh pr edit` target held in a variable must not fall back to the checkout.
  const publicPrUrl = "https://github.com/public/example/pull/1";

  test("gh pr edit with a PR URL variable resolved from the env", async () => {
    for (const command of [
      `gh pr edit "$PR_URL" --body "${flagged()}"`,
      `gh pr edit "\${PR_URL}" --body "${flagged()}"`,
    ]) {
      const { deps, seen } = publicTarget();
      deps.env = { ...deps.env, PR_URL: publicPrUrl };
      expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
      expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
    }
  });

  test("gh pr edit with a PR URL variable resolved from export", async () => {
    const { deps, seen } = publicTarget();
    const command = `export PR_URL=${publicPrUrl} && gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  test("an unresolvable gh pr edit target fails closed without a checkout lookup", async () => {
    for (const command of [
      `gh pr edit "$PR_URL" --body "${flagged()}"`,
      `gh pr edit "$(gh pr list --json url -q '.[0].url')" --body "${flagged()}"`,
      `gh pr edit $(gh pr list --json url -q '.[0].url') --body "${flagged()}"`,
      `gh pr edit https://github.com/public/example/issues/1 --body "${flagged()}"`,
    ]) {
      const { deps, seen } = publicTarget();
      const reason = await checkGhPrCommand(command, "/private", deps);
      expect(reason).toContain("could not be resolved");
      expect(reason).toContain("slack-link");
      expect(seen).toEqual([]);
    }
  });

  test("an unresolvable gh pr edit target with a clean body is allowed", async () => {
    const { deps, seen } = publicTarget();
    const command = 'gh pr edit "$PR_URL" --body "Fixes #1."';
    expect(await checkGhPrCommand(command, "/private", deps)).toBeNull();
    expect(seen).toEqual([]);
  });

  test("PR number and branch targets still resolve in the checkout or -R repo", async () => {
    for (const command of [
      `gh pr edit 12 --body "${flagged()}"`,
      `gh pr edit "#12" --body "${flagged()}"`,
      `gh pr edit fix/some-branch --body "${flagged()}"`,
      `gh pr edit "$BRANCH" --body "${flagged()}"`,
      `gh pr edit --body "${flagged()}"`,
    ]) {
      const priv = publicTarget();
      priv.deps.env = { ...priv.deps.env, BRANCH: "fix/some-branch" };
      expect(await checkGhPrCommand(command, "/private", priv.deps)).toBeNull();
      expect(priv.seen).toEqual([{ cwd: "/private", repo: undefined }]);

      const pub = publicTarget();
      pub.deps.env = { ...pub.deps.env, BRANCH: "fix/some-branch" };
      expect(await checkGhPrCommand(command, "/public", pub.deps)).toContain("slack-link");
    }
    const { deps, seen } = publicTarget();
    const command = `gh pr edit 12 -R public/example --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  // The parser's model of shell variables must not lag the shell. The hook env
  // holds a stale local target; the command changes it before `gh` runs.
  const staleLocal = () => {
    const target = publicTarget();
    target.deps.env = { ...target.deps.env, PR_URL: "fix/old-branch" };
    return target;
  };

  test("a plain assignment overrides a stale env target (flagged inline body)", async () => {
    const { deps, seen } = staleLocal();
    const command = `PR_URL=${publicPrUrl}; gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  test("a plain assignment overrides a stale env target (unreadable body file)", async () => {
    const { deps, seen } = staleLocal();
    deps.readFile = async () => {
      throw new Error("missing");
    };
    const command = `PR_URL=${publicPrUrl}; gh pr edit "$PR_URL" --body-file /tmp/missing.md`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("could not read");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  test("a plain assignment to a local target still resolves in the checkout", async () => {
    const { deps, seen } = publicTarget();
    deps.env = { ...deps.env, PR_URL: publicPrUrl };
    const command = `PR_URL=fix/b; gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toBeNull();
    expect(seen).toEqual([{ cwd: "/private", repo: undefined }]);
  });

  test("a prefix assignment on gh itself does not change the expanded target", async () => {
    const { deps, seen } = publicTarget();
    deps.env = { ...deps.env, PR_URL: publicPrUrl };
    const command = `PR_URL=fix/b gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  const expectUnresolved = async (commands: string[]) => {
    for (const command of commands) {
      const { deps, seen } = staleLocal();
      const reason = await checkGhPrCommand(command, "/private", deps);
      expect({ command, reason }).toEqual({
        command,
        reason: expect.stringContaining("could not be resolved"),
      });
      expect(seen).toEqual([]);
    }
  };

  test("a non-literal assignment makes the target unknown", async () => {
    const edit = `gh pr edit "$PR_URL" --body "${flagged()}"`;
    await expectUnresolved([
      `PR_URL=$(gh pr list --json url -q '.[0].url'); ${edit}`,
      `PR_URL="$(gh pr list --json url -q '.[0].url')"; ${edit}`,
      `PR_URL=\`gh pr list --json url -q .[0].url\`; ${edit}`,
      `PR_URL=$OTHER; ${edit}`,
      `export PR_URL=$(gh pr list --json url -q '.[0].url') && ${edit}`,
      `PR_URL+=/x; ${edit}`,
    ]);
  });

  test("read, source, eval, declare, for, unset and similar make a later target unknown", async () => {
    const edit = `gh pr edit "$PR_URL" --body "${flagged()}"`;
    await expectUnresolved([
      `read -r PR_URL < /tmp/url; ${edit}`,
      `source /tmp/env.sh; ${edit}`,
      `. /tmp/env.sh; ${edit}`,
      `eval "PR_URL=${publicPrUrl}"; ${edit}`,
      `declare PR_URL=${publicPrUrl}; ${edit}`,
      `typeset PR_URL=${publicPrUrl}; ${edit}`,
      `local PR_URL=${publicPrUrl}; ${edit}`,
      `readonly PR_URL=${publicPrUrl}; ${edit}`,
      `mapfile -t PR_URL < /tmp/url; ${edit}`,
      `readarray -t PR_URL < /tmp/url; ${edit}`,
      `printf -v PR_URL '%s' ${publicPrUrl}; ${edit}`,
      `while read -r PR_URL; do ${edit}; done < /tmp/urls`,
      `for PR_URL in ${publicPrUrl}; do ${edit}; done`,
      `unset PR_URL; ${edit}`,
    ]);
  });

  test("an unknown target with a clean body is allowed without a lookup", async () => {
    const { deps, seen } = staleLocal();
    const command = 'read -r PR_URL < /tmp/url; gh pr edit "$PR_URL" --body "Fixes #1."';
    expect(await checkGhPrCommand(command, "/private", deps)).toBeNull();
    expect(seen).toEqual([]);
  });

  test("subshell state does not leak out of ( ... )", async () => {
    const { deps, seen } = publicTarget();
    deps.env = { ...deps.env, PR_URL: publicPrUrl };
    const edit = `(export PR_URL=fix/b); gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(edit, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);

    const create = publicTarget();
    const command = `(cd /private); gh pr create --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/public", create.deps)).toContain("slack-link");
    const inside = publicTarget();
    const nested = `(cd /private && gh pr create --body "${flagged()}")`;
    expect(await checkGhPrCommand(nested, "/public", inside.deps)).toBeNull();
  });

  test("a body file path follows variables assigned in the command", async () => {
    const reads: string[] = [];
    const { deps } = publicTarget();
    deps.env = { ...deps.env, F: "/tmp/clean.md" };
    deps.readFile = async (path) => {
      reads.push(path);
      return path === "/tmp/leaky.md" ? flagged() : "Fixes #1.";
    };
    const command = 'F=/tmp/leaky.md; gh pr create --body-file "$F"';
    expect(await checkGhPrCommand(command, "/public", deps)).toContain("slack-link");
    expect(reads).toEqual(["/tmp/leaky.md"]);
  });

  test("an unexported GH_REPO assignment also checks the checkout", async () => {
    const { deps, seen } = publicTarget();
    const command = `GH_REPO=private/example; gh pr create --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/public", deps)).toContain("slack-link");
    expect(seen).toEqual([
      { cwd: "/public", repo: "private/example" },
      { cwd: "/public", repo: undefined },
    ]);
  });

  test("gh after a reserved word (then, do) is still checked", async () => {
    for (const command of [
      `if true; then gh pr create --body "${flagged()}"; fi`,
      `for i in 1; do gh pr create --body "${flagged()}"; done`,
    ]) {
      const { deps } = publicTarget();
      expect(await checkGhPrCommand(command, "/public", deps)).toContain("slack-link");
    }
  });

  test("gh inside bash -c or eval is checked", async () => {
    for (const command of [
      `bash -c 'gh pr create --body "${flagged()}"'`,
      `sh -lc 'cd /public && gh pr create --body "${flagged()}"'`,
      `eval 'gh pr create --body "${flagged()}"'`,
    ]) {
      const { deps } = publicTarget();
      expect({ command, reason: await checkGhPrCommand(command, "/public", deps) }).toEqual({
        command,
        reason: expect.stringContaining("slack-link"),
      });
    }
    // The child shell sees exported variables and prefix assignments only.
    const { deps, seen } = staleLocal();
    const command = `PR_URL=${publicPrUrl} bash -c 'gh pr edit "$PR_URL" --body "${flagged()}"'`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
    const local = publicTarget();
    const unexported = `PR_URL=fix/b; bash -c 'gh pr edit "$PR_URL" --body "${flagged()}"'`;
    expect(await checkGhPrCommand(unexported, "/private", local.deps)).toContain(
      "could not be resolved",
    );
  });

  test("a wrapper with flags makes the cwd and GH_REPO unknown", async () => {
    const { deps, seen } = publicTarget();
    deps.env = { ...deps.env, GH_REPO: "private/example" };
    const command = `env -u GH_REPO gh pr create --body "${flagged()}"`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("could not be resolved");
    expect(seen).toEqual([]);
  });

  // The parser cannot tell whether a conditional write ran. The hook env holds
  // the public target; each command may or may not move it to a local branch.
  const publicEnvTarget = () => {
    const target = publicTarget();
    target.deps.env = { ...target.deps.env, PR_URL: publicPrUrl };
    return target;
  };

  test("a skipped conditional assignment makes the target unknown", async () => {
    const edit = `gh pr edit "$PR_URL" --body "${flagged()}"`;
    for (const command of [
      `if false; then PR_URL=fix/private; fi\n${edit}`,
      `false && PR_URL=fix/private; ${edit}`,
      `true || PR_URL=fix/private; ${edit}`,
      `false &&\n  PR_URL=fix/private; ${edit}`,
      `false || PR_URL=fix/private && ${edit}`,
      `if c; then PR_URL=fix/private; else ${edit}; fi`,
      `if c; then PR_URL=fix/a; PR_URL=fix/private; fi; ${edit}`,
      `while false; do ${edit}; PR_URL=fix/private; done`,
      `PR_URL=fix/private && true & ${edit}`,
      `f() { PR_URL=fix/private; }; f; ${edit}`,
    ]) {
      const { deps, seen } = publicEnvTarget();
      const reason = await checkGhPrCommand(command, "/private", deps);
      expect({ command, reason }).toEqual({
        command,
        reason: expect.stringContaining("could not be resolved"),
      });
      expect(seen).toEqual([]);
    }
  });

  test("a skipped assignment with an unreadable body file blocks; a clean body allows", async () => {
    const { deps, seen } = publicEnvTarget();
    deps.readFile = async () => {
      throw new Error("missing");
    };
    const unreadable = 'false && PR_URL=fix/private; gh pr edit "$PR_URL" --body-file /tmp/x.md';
    expect(await checkGhPrCommand(unreadable, "/private", deps)).toContain("could not read");
    expect(seen).toEqual([]);

    const clean = publicEnvTarget();
    const command = 'false && PR_URL=fix/private; gh pr edit "$PR_URL" --body "Fixes #1."';
    expect(await checkGhPrCommand(command, "/private", clean.deps)).toBeNull();
    expect(clean.seen).toEqual([]);
  });

  test("an assignment in a subshell or pipeline does not persist", async () => {
    const edit = `gh pr edit "$PR_URL" --body "${flagged()}"`;
    for (const command of [
      `{ PR_URL=fix/private; } | cat; ${edit}`,
      `(false && PR_URL=fix/private; ${edit})`,
    ]) {
      const { deps, seen } = publicEnvTarget();
      const reason = await checkGhPrCommand(command, "/private", deps);
      expect({ command, reason }).toEqual({
        command,
        reason: expect.stringContaining("could not be resolved"),
      });
      expect(seen).toEqual([]);
    }
    // Leaving `( ... )` restores the env value: the public target.
    const { deps, seen } = publicEnvTarget();
    const command = `(PR_URL=fix/private); ${edit}`;
    expect(await checkGhPrCommand(command, "/private", deps)).toContain("slack-link");
    expect(seen.map((t) => t.repo)).toEqual(["public/example"]);
  });

  test("a skipped cd makes the checkout unknown", async () => {
    for (const command of [
      `false && cd /private; gh pr create --body "${flagged()}"`,
      `if false; then cd /private; fi; gh pr create --body "${flagged()}"`,
      `cd /elsewhere || cd /private; gh pr create --body "${flagged()}"`,
    ]) {
      const { deps, seen } = publicTarget();
      const reason = await checkGhPrCommand(command, "/public", deps);
      expect({ command, reason }).toEqual({
        command,
        reason: expect.stringContaining("could not be confirmed"),
      });
      expect(seen).toEqual([]);
    }
  });

  test("a write still counts where it must have run", async () => {
    const { deps, seen } = publicEnvTarget();
    const inBranch = `if c; then PR_URL=fix/b; gh pr edit "$PR_URL" --body "${flagged()}"; fi`;
    expect(await checkGhPrCommand(inBranch, "/private", deps)).toBeNull();
    expect(seen).toEqual([{ cwd: "/private", repo: undefined }]);

    const chain = publicEnvTarget();
    const andChain = `git fetch && PR_URL=fix/b && gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(andChain, "/private", chain.deps)).toBeNull();

    const after = publicEnvTarget();
    const overwritten = `if false; then PR_URL=fix/a; fi; PR_URL=${publicPrUrl}; gh pr edit "$PR_URL" --body "${flagged()}"`;
    expect(await checkGhPrCommand(overwritten, "/private", after.deps)).toContain("slack-link");
    expect(after.seen.map((t) => t.repo)).toEqual(["public/example"]);

    const cd = publicTarget();
    const command = "git fetch && cd /private && gh pr create --body-file b.md";
    expect(await checkGhPrCommand(command, "/public", cd.deps)).toBeNull();
    expect(cd.calls.reads).toEqual(["/private/b.md"]);
  });

  test("clean body files are allowed in public and private checkouts", async () => {
    for (const command of [
      "gh pr create --title t --body-file /tmp/pr-body.md",
      "gh pr edit 1 --body-file f",
    ]) {
      for (const cwd of ["/public", "/private"]) {
        const { deps, seen } = publicTarget();
        deps.readFile = async () => NORMAL_BODY;
        expect(await checkGhPrCommand(command, cwd, deps)).toBeNull();
        expect(seen).toEqual([]);
      }
    }
  });
});

describe("hook entry points", () => {
  test("shellCommandOf reads strings and argv arrays", () => {
    expect(shellCommandOf({ command: "gh pr list" })).toBe("gh pr list");
    expect(shellCommandOf({ command: ["bash", "-lc", "gh pr create"] })).toBe("gh pr create");
    expect(shellCommandOf({ command: ["gh", "pr", "create"] })).toBe("gh pr create");
    expect(shellCommandOf({ file_path: "/x" })).toBeNull();
  });

  test("guardGhPrBody ignores non-shell input and fails closed when the lookup throws", async () => {
    const { deps } = fakeDeps({
      repoVisibility: () => {
        throw new Error("sync throw");
      },
    });
    expect(await guardGhPrBody(undefined, "/w", deps)).toBeNull();
    expect(
      await guardGhPrBody({ command: `gh pr create --body "${slackTs()}"` }, "/w", deps),
    ).toContain("slack-ts");
  });

  test("codex PreToolUse blocks a leaky gh pr create; other events pass", async () => {
    const { deps } = fakeDeps();
    const tool_input = { command: ["bash", "-lc", `gh pr create --body "${dashboardLink()}"`] };
    expect(
      await codexPreToolUseBlock({ hook_event_name: "PreToolUse", tool_input, cwd: "/w" }, deps),
    ).toContain("swarm-dashboard-link");
    expect(
      await codexPreToolUseBlock({ hook_event_name: "PostToolUse", tool_input, cwd: "/w" }, deps),
    ).toBeNull();
  });
});
