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
      { cwd: "/tmp/wt", repo: "o/r", inlineBody: false, bodyFile: "body.md" },
    ]);
  });

  test("detects inline bodies, edit, and = forms; ignores other gh calls", () => {
    expect(parseGhPrCommands("gh pr edit 12 -b 'x'", "/w")[0]?.inlineBody).toBe(true);
    expect(parseGhPrCommands("gh pr edit 12 --body-file=-", "/w")[0]?.inlineBody).toBe(true);
    expect(parseGhPrCommands("gh pr view 12 --json body", "/w")).toEqual([]);
    expect(parseGhPrCommands("echo gh pr create", "/w")).toEqual([]);
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

  test("an unexpanded shell variable body is allowed (fail open, CI is the backstop)", async () => {
    const { deps, calls } = fakeDeps();
    expect(await checkGhPrCommand('gh pr create -t t --body "$BODY"', "/w", deps)).toBeNull();
    expect(calls.visibility).toBe(0);
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
