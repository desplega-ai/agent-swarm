import { afterEach, describe, expect, test } from "bun:test";
import { type BasePromptArgs, getBasePrompt } from "../prompts/base-prompt";
import type { ProviderTraits } from "../providers/types";

/** Minimal valid args to reduce boilerplate */
const minimalArgs: BasePromptArgs = {
  role: "worker",
  agentId: "agent-abc-123",
  swarmUrl: "swarm.example.com",
};

const originalSlackDisable = process.env.SLACK_DISABLE;
const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
const originalSlackAppToken = process.env.SLACK_APP_TOKEN;

afterEach(() => {
  restoreEnv("SLACK_DISABLE", originalSlackDisable);
  restoreEnv("SLACK_BOT_TOKEN", originalSlackBotToken);
  restoreEnv("SLACK_APP_TOKEN", originalSlackAppToken);
});

function restoreEnv(
  name: "SLACK_DISABLE" | "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function enableSlackPromptTools() {
  process.env.SLACK_DISABLE = "false";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-token";
}

function disableSlackPromptTools() {
  process.env.SLACK_DISABLE = "true";
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
}

// ---------------------------------------------------------------------------
// Basic fields
// ---------------------------------------------------------------------------
describe("getBasePrompt — basic fields", () => {
  test("includes role and agentId", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("worker");
    expect(result).toContain("agent-abc-123");
  });

  test("lead role gets lead prompt", async () => {
    const result = await getBasePrompt({ ...minimalArgs, role: "lead" });
    expect(result).toContain("lead agent");
    expect(result).toContain("coordinator");
  });

  test("worker role gets worker prompt", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("worker agent");
  });

  test("includes swarmUrl and agentId in services section", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("swarm.example.com");
    expect(result).toContain(`https://agent-abc-123.swarm.example.com`);
  });
});

// ---------------------------------------------------------------------------
// Identity fields (name, description, soulMd, identityMd)
// ---------------------------------------------------------------------------
describe("getBasePrompt — identity fields", () => {
  test("includes name when provided", async () => {
    const result = await getBasePrompt({ ...minimalArgs, name: "TestAgent" });
    expect(result).toContain("**Name:** TestAgent");
  });

  test("includes description when name provided", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "TestAgent",
      description: "A helpful agent",
    });
    expect(result).toContain("**Description:** A helpful agent");
  });

  test("does not include description without name", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      description: "A helpful agent",
    });
    expect(result).not.toContain("**Description:**");
  });

  test("includes soulMd content", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      soulMd: "I am a creative soul.",
    });
    expect(result).toContain("## Your Identity");
    expect(result).toContain("I am a creative soul.");
  });

  test("includes identityMd content", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      identityMd: "Identity content here.",
    });
    expect(result).toContain("## Your Identity");
    expect(result).toContain("Identity content here.");
  });

  test("no identity section when none provided", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).not.toContain("## Your Identity");
  });
});

// ---------------------------------------------------------------------------
// claudeMd and toolsMd injection
// ---------------------------------------------------------------------------
describe("getBasePrompt — claudeMd and toolsMd injection", () => {
  test("includes claudeMd under Agent Instructions", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      claudeMd: "Follow these rules.",
    });
    expect(result).toContain("## Agent Instructions");
    expect(result).toContain("Follow these rules.");
  });

  test("includes toolsMd under Tools & Capabilities", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      toolsMd: "You can use curl.",
    });
    expect(result).toContain("## Your Tools & Capabilities");
    expect(result).toContain("You can use curl.");
  });

  test("both claudeMd and toolsMd coexist", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      claudeMd: "Agent instructions content",
      toolsMd: "Tools content",
    });
    expect(result).toContain("## Agent Instructions");
    expect(result).toContain("Agent instructions content");
    expect(result).toContain("## Your Tools & Capabilities");
    expect(result).toContain("Tools content");
  });

  test("neither present when not provided", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).not.toContain("## Agent Instructions");
    expect(result).not.toContain("## Your Tools & Capabilities");
  });
});

// ---------------------------------------------------------------------------
// repoContext
// ---------------------------------------------------------------------------
describe("getBasePrompt — repoContext", () => {
  test("includes repo claudeMd with clone path", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Repo-specific rules here.",
        clonePath: "/workspace/my-repo",
      },
    });
    expect(result).toContain("IMPORTANT: These instructions apply ONLY");
    expect(result).toContain("/workspace/my-repo");
    expect(result).toContain("Repo-specific rules here.");
  });

  test("shows warning when provided", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        warning: "Repo is stale",
      },
    });
    expect(result).toContain("WARNING: Repo is stale");
  });

  test("shows 'no CLAUDE.md' message when claudeMd is null and no warning", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: null,
        clonePath: "/workspace/my-repo",
      },
    });
    expect(result).toContain("but has no CLAUDE.md file");
  });

  test("shows warning when guidelines is null", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        guidelines: null,
      },
    });
    expect(result).toContain("No repository guidelines defined");
    expect(result).toContain("ask the lead or user to define guidelines");
  });

  test("renders PR checks, merge policy, and review guidance when guidelines has content", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        guidelines: {
          prChecks: ["bun test", "bun run lint"],
          mergeChecks: ["all CI checks pass"],
          allowMerge: false,
          review: ["check README.md"],
        },
      },
    });
    expect(result).toContain("Repository Guidelines (MANDATORY)");
    expect(result).toContain("`bun test`");
    expect(result).toContain("`bun run lint`");
    expect(result).toContain("Auto-merge: Not allowed (default)");
    expect(result).toContain("all CI checks pass");
    expect(result).toContain("check README.md");
    expect(result).toContain("Do NOT push code with failing checks");
  });

  test("renders nothing when guidelines has all empty arrays", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        guidelines: {
          prChecks: [],
          mergeChecks: [],
          allowMerge: false,
          review: [],
        },
      },
    });
    expect(result).not.toContain("Repository Guidelines (MANDATORY)");
    expect(result).not.toContain("No repository guidelines defined");
  });

  test("renders merge policy when allowMerge is true even with empty arrays", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        guidelines: {
          prChecks: [],
          mergeChecks: [],
          allowMerge: true,
          review: [],
        },
      },
    });
    expect(result).toContain("Repository Guidelines (MANDATORY)");
    expect(result).toContain("Auto-merge: Allowed");
  });

  test("surfaces swarm-autostash entries when present", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        autoStashes: [
          {
            ref: "stash@{0}",
            message: "On main: swarm-autostash main 2026-06-01T13:00:00.000Z",
          },
        ],
      },
    });

    expect(result).toContain("Pending auto-stashed work exists in this repo");
    expect(result).toContain("stash@{0}: On main: swarm-autostash main");
    expect(result).toContain("git stash apply <ref>");
    expect(result).toContain("git stash pop <ref>");
  });

  test("does not mention auto-stashed work when no swarm-autostash entries exist", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: "Rules",
        clonePath: "/workspace/my-repo",
        autoStashes: [],
      },
    });

    expect(result).not.toContain("Pending auto-stashed work exists in this repo");
    expect(result).not.toContain("git stash apply <ref>");
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
describe("getBasePrompt — capabilities", () => {
  test("services section included by default", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("Service Registry");
  });

  test("services section excluded when capabilities don't include services", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      capabilities: ["artifacts"],
    });
    expect(result).not.toContain("Service Registry");
  });

  test("capabilities list rendered", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      capabilities: ["services", "artifacts"],
    });
    expect(result).toContain("### Capabilities enabled");
    expect(result).toContain("- services");
    expect(result).toContain("- artifacts");
  });
});

// ---------------------------------------------------------------------------
// Truncation (tests truncateSection indirectly)
// ---------------------------------------------------------------------------
describe("getBasePrompt — truncation", () => {
  const bigString = (n: number) => "x".repeat(n);

  test("claudeMd truncated when exceeding per-section limit (20k chars)", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      claudeMd: bigString(25_000),
    });
    expect(result).toContain("[...truncated, see /workspace/CLAUDE.md");
    // The full 25k content should NOT be present
    expect(result).not.toContain(bigString(25_000));
  });

  test("toolsMd truncated when exceeding per-section limit", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      toolsMd: bigString(25_000),
    });
    expect(result).toContain("[...truncated, see /workspace/TOOLS.md");
    expect(result).not.toContain(bigString(25_000));
  });

  test("total budget respected — tools truncated before claudeMd", async () => {
    // Use soulMd to eat up most of the 120k total budget (lowered from 150k
    // in the Picateclas spawn-OOM fix, 2026-05-28) so that truncatable
    // sections (claudeMd, toolsMd) must compete for the remainder.
    // soulMd is part of `prompt` which counts toward protectedLength.
    const baseResult = await getBasePrompt(minimalArgs);
    const staticLength = baseResult.length; // ~12-13k for static content

    // Leave exactly enough budget for claudeMd but not toolsMd.
    // Total budget = 120k - protectedLength.
    // We want: protectedLength ≈ 120k - 18k = 102k, so claudeMd (15k) fits but toolsMd doesn't.
    const soulSize = 102_000 - staticLength;
    const result = await getBasePrompt({
      ...minimalArgs,
      soulMd: bigString(Math.max(0, soulSize)),
      claudeMd: bigString(15_000),
      toolsMd: bigString(15_000),
    });

    // claudeMd (higher priority, injected first) should be present
    expect(result).toContain("## Agent Instructions");
    // toolsMd (lower priority) should be truncated or absent
    const hasToolsTruncation = result.includes("[...truncated, see /workspace/TOOLS.md");
    const hasToolsHeader = result.includes("## Your Tools & Capabilities");
    // Tools is either truncated or entirely omitted (budget <= 0)
    expect(hasToolsTruncation || !hasToolsHeader).toBe(true);
  });

  test("Picateclas spawn-OOM hardening — total prompt stays below MAX_ARG_STRLEN", async () => {
    // Even at the worst-case where every truncatable section maxes out its
    // budget and the repo CLAUDE.md is huge, the final prompt must stay
    // safely below Linux's `MAX_ARG_STRLEN = 131,072` bytes (the per-argv-
    // element kernel limit that bit Picateclas attempts 4-6, 2026-05-28).
    const result = await getBasePrompt({
      ...minimalArgs,
      soulMd: bigString(40_000),
      claudeMd: bigString(40_000),
      toolsMd: bigString(40_000),
      repoContext: {
        claudeMd: bigString(60_000),
        clonePath: "/workspace/repos/big-repo",
      },
    });
    expect(result.length).toBeLessThan(131_072);
  });

  test("repo CLAUDE.md is capped at REPO_CLAUDE_MD_MAX_CHARS (12 KB) with on-disk pointer", async () => {
    // Picateclas spawn-OOM permanent fix (2026-05-28): repo CLAUDE.md was the
    // single biggest volatile component of the bootstrap argv. It is now
    // truncated to ~12 KB with a footer pointing at the on-disk file, mirroring
    // the same shape as the agent claudeMd / toolsMd caps.
    const hugeRepoClaudeMd = bigString(30_000);
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: hugeRepoClaudeMd,
        clonePath: "/workspace/big-repo",
      },
    });
    // The full 30 KB content should NOT survive — capped at ~12 KB.
    expect(result).not.toContain(hugeRepoClaudeMd);
    // The truncation footer points at the on-disk path so readers can find
    // the full content.
    expect(result).toContain("[...truncated — see /workspace/big-repo/CLAUDE.md");
  });

  test("repo CLAUDE.md under the cap is preserved verbatim", async () => {
    const smallRepoClaudeMd = bigString(5_000);
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        claudeMd: smallRepoClaudeMd,
        clonePath: "/workspace/small-repo",
      },
    });
    expect(result).toContain(smallRepoClaudeMd);
    expect(result).not.toContain("[...truncated");
  });
});

// ---------------------------------------------------------------------------
// Remote provider (no MCP, no local environment) — trait-aware prompt assembly
// ---------------------------------------------------------------------------
const remoteTraits: ProviderTraits = { hasMcp: false, hasLocalEnvironment: false };
const remoteProviderArgs: BasePromptArgs = {
  ...minimalArgs,
  traits: remoteTraits,
};

describe("getBasePrompt — remote provider composite selection", () => {
  test("uses remote worker composite (not generic worker)", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    // Remote worker template says "output is captured automatically"
    expect(result).toContain("output is captured automatically");
    // Should NOT contain generic worker tools
    expect(result).not.toContain("store-progress");
    expect(result).not.toContain("task-action");
    expect(result).not.toContain("read-messages");
  });

  test("still includes role and agentId", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).toContain("worker");
    expect(result).toContain("agent-abc-123");
  });
});

describe("getBasePrompt — remote provider excluded sections", () => {
  test("excludes join-swarm / register instructions", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("join-swarm");
  });

  test("excludes /workspace filesystem layout", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("/workspace/personal");
    expect(result).not.toContain("/workspace/shared");
  });

  test("excludes How You Are Built section", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("How You Are Built");
    expect(result).not.toContain("hooks fire during your session");
  });

  test("excludes context mode tools", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("context-mode");
    expect(result).not.toContain("batch_execute");
  });

  test("excludes system packages section", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("sudo apt-get install");
    expect(result).not.toContain("System packages available");
  });

  test("excludes VCS CLI tools table", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("glab mr create");
    expect(result).not.toContain("gh pr create");
  });

  test("excludes service registry / PM2", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("Service Registry");
    expect(result).not.toContain("pm2 start");
  });

  test("excludes code quality section", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).not.toContain("Code Quality");
    expect(result).not.toContain("--no-verify");
  });

  test("excludes capabilities listing", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      capabilities: ["core", "task-pool"],
    });
    expect(result).not.toContain("Capabilities enabled");
  });

  test("skips Slack instructions even with slackContext", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      slackContext: { channelId: "C123", threadTs: "123.456" },
    });
    expect(result).not.toContain("slack-reply");
    expect(result).not.toContain("C123");
  });

  test("skips skills section even when provided", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      skillsSummary: [{ name: "commit", description: "Create a commit" }],
    });
    expect(result).not.toContain("Installed Skills");
    expect(result).not.toContain("/commit");
  });

  test("skips MCP servers section even when provided", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      mcpServersSummary: "- my-server: http://localhost:3000",
    });
    expect(result).not.toContain("Installed MCP Servers");
    expect(result).not.toContain("my-server");
  });

  test("skips CLAUDE.md and TOOLS.md truncatable sections", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      claudeMd: "# Agent instructions here",
      toolsMd: "# Tools here",
    });
    expect(result).not.toContain("Agent Instructions");
    expect(result).not.toContain("Agent instructions here");
    expect(result).not.toContain("Your Tools & Capabilities");
    expect(result).not.toContain("Tools here");
  });
});

describe("getBasePrompt — remote provider identity", () => {
  test("uses simplified identity (no SOUL.md / IDENTITY.md)", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      name: "remote-worker-1",
      description: "A remote worker",
      soulMd: "# SOUL.md content that should NOT appear",
      identityMd: "# IDENTITY.md content that should NOT appear",
    });
    expect(result).toContain("**Name:** remote-worker-1");
    expect(result).toContain("**Description:** A remote worker");
    expect(result).toContain("Desplega platform");
    // Identity files should NOT be injected
    expect(result).not.toContain("SOUL.md content that should NOT appear");
    expect(result).not.toContain("IDENTITY.md content that should NOT appear");
  });

  test("identity section present even without name", async () => {
    const result = await getBasePrompt(remoteProviderArgs);
    expect(result).toContain("Your Identity");
    expect(result).toContain("Desplega platform");
  });
});

describe("getBasePrompt — remote provider keeps repo context", () => {
  test("skips CLAUDE.md content for remote providers", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      repoContext: {
        claudeMd: "Run `bun test` before pushing.",
        clonePath: "/workspace/repos/my-repo",
      },
    });
    expect(result).toContain("Repository Context");
    // Remote providers don't get claudeMd injected
    expect(result).not.toContain("Run `bun test` before pushing.");
    expect(result).not.toContain("/workspace/repos/my-repo");
  });

  test("includes repo guidelines", async () => {
    const result = await getBasePrompt({
      ...remoteProviderArgs,
      repoContext: {
        clonePath: "/workspace/repos/my-repo",
        guidelines: {
          prChecks: ["bun run lint:fix", "bun test"],
          mergeChecks: [],
          allowMerge: false,
          review: [],
        },
      },
    });
    expect(result).toContain("Repository Guidelines");
    expect(result).toContain("bun run lint:fix");
    expect(result).toContain("bun test");
  });
});

describe("getBasePrompt — local providers unaffected", () => {
  test("local provider uses generic worker composite", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: { hasMcp: true, hasLocalEnvironment: true },
    });
    expect(result).toContain("store-progress");
    expect(result).toContain("/workspace");
  });

  test("undefined traits defaults to local provider behavior", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("store-progress");
    expect(result).toContain("/workspace");
  });
});

// ---------------------------------------------------------------------------
// Context-mode block — provider gating
//
// The context_mode block advertises the `ctx_*` MCP tools. It is included for
// local providers that have context-mode wired into their per-session config
// (claude, codex, opencode) and excluded for `pi`, which has no context-mode
// wiring yet. DES-514 still requires pi to receive the separate script guidance.
// Remote-provider exclusion is covered by the "remote provider excluded
// sections" suite above.
// ---------------------------------------------------------------------------
const localTraits: ProviderTraits = { hasMcp: true, hasLocalEnvironment: true };

describe("getBasePrompt — context-mode provider gating", () => {
  test("excludes context-mode tools but keeps script guidance for pi provider", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: localTraits,
      provider: "pi",
    });
    expect(result).not.toContain("Context Window Management");
    expect(result).not.toContain("batch_execute");
    expect(result).toContain("Agent Scripts");
    expect(result).toContain("workflow-triage");
  });

  for (const provider of ["claude", "codex", "opencode"] as const) {
    test(`includes context-mode block for ${provider} provider`, async () => {
      const result = await getBasePrompt({
        ...minimalArgs,
        traits: localTraits,
        provider,
      });
      expect(result).toContain("Context Window Management");
      expect(result).toContain("context-mode");
    });
  }

  test("includes context-mode block when provider is unspecified (local default)", async () => {
    const result = await getBasePrompt({ ...minimalArgs, traits: localTraits });
    expect(result).toContain("Context Window Management");
    expect(result).toContain("context-mode");
  });
});

describe("getBasePrompt — conditional Slack templates", () => {
  test("omits Slack tool templates when Slack is disabled", async () => {
    disableSlackPromptTools();

    const result = await getBasePrompt({
      ...minimalArgs,
      role: "lead",
      slackContext: { channelId: "C123", threadTs: "123.456" },
    });

    expect(result).not.toMatch(/\bslack-[a-z-]+\b/);
    expect(result).toContain("Task Routing");
  });

  test("includes Slack tool template for lead when Slack is enabled", async () => {
    enableSlackPromptTools();

    const result = await getBasePrompt({
      ...minimalArgs,
      role: "lead",
    });

    expect(result).toContain("#### Slack Tools");
    expect(result).toContain("slack-reply");
    expect(result).toContain("slack-read");
    expect(result).toContain("slack-list-channels");
  });

  test("includes Slack tool template for worker when Slack is enabled", async () => {
    enableSlackPromptTools();

    const result = await getBasePrompt({
      ...minimalArgs,
      role: "worker",
    });

    expect(result).toContain("#### Slack Tools");
    expect(result).toContain("slack-reply");
    expect(result).toContain("slack-read");
    expect(result).toContain("slack-list-channels");
  });

  test("includes worker Slack thread template when Slack is enabled", async () => {
    enableSlackPromptTools();

    const result = await getBasePrompt({
      ...minimalArgs,
      role: "worker",
      slackContext: { channelId: "C123", threadTs: "123.456" },
    });

    expect(result).toContain("slack-reply");
    expect(result).toContain("C123");
  });
});
