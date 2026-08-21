import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { type BasePromptArgs, getBasePrompt, truncateRepoClaudeMd } from "../prompts/base-prompt";
import { generateDefaultClaudeMd, generateDefaultIdentityMd } from "../prompts/defaults";
import type { ProviderTraits } from "../providers/types";

// ---------------------------------------------------------------------------
// Fixtures and env handling
// ---------------------------------------------------------------------------

const AGENT_ID = "11111111-2222-3333-4444-555555555555";

/** Minimal valid args: a local claude worker with nothing optional set. */
const minimalArgs: BasePromptArgs = {
  role: "worker",
  agentId: AGENT_ID,
};

const localTraits: ProviderTraits = { hasMcp: true, hasLocalEnvironment: true };
/** claude-managed: MCP tools exist, the container and the /workspace mirrors do not. */
const managedTraits: ProviderTraits = { hasMcp: true, hasLocalEnvironment: false };
/** devin: no MCP, no container. */
const remoteTraits: ProviderTraits = { hasMcp: false, hasLocalEnvironment: false };

const ENV_KEYS = [
  "SLACK_DISABLE",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "STEERING_ENABLED",
  "AGENT_FS_API_URL",
  "SCRIPTS_ONLY_MCP",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enableSlack() {
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  process.env.SLACK_APP_TOKEN = "xapp-test-token";
}

/** U+2014. Written as an escape so this file stays free of the character. */
const EM_DASH = "\u2014";

/**
 * The IDENTITY.md default shipped before the prompt v2 rewrite. Agents created
 * back then still carry this text, so it must count as unedited. Copied from
 * `generateLegacyDefaultIdentityMd` in defaults.ts, which is private.
 */
function legacyDefaultIdentityMd(agent: {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
}): string {
  const aboutSection = agent.description ? `## About\n\n${agent.description}\n\n` : "";
  const expertiseSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Expertise\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# IDENTITY.md ${EM_DASH} ${agent.name}

This isn't just metadata. It's the start of figuring out who you are.

- **Name:** ${agent.name}
- **Role:** ${agent.role || "worker"}
- **Vibe:** (discover and fill in as you work)

${aboutSection}${expertiseSection}## Working Style

Discover and document your working patterns here.
(e.g., Do you prefer to plan before coding? Do you test first?
Do you like to explore the codebase broadly or dive deep immediately?)

## Quirks

(What makes you... you? Discover these as you work.)

## Self-Evolution

This identity is yours to refine. After completing tasks, reflect on
what you learned about your strengths. Edit this file directly.
`;
}

/** The CLAUDE.md default shipped before the prompt v2 rewrite. Same reason. */
function legacyDefaultClaudeMd(agent: {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
}): string {
  const descSection = agent.description ? `${agent.description}\n\n` : "";
  const roleSection = agent.role ? `## Role\n\n${agent.role}\n\n` : "";
  const capSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Capabilities\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# Agent: ${agent.name}

${descSection}${roleSection}${capSection}---

## Your Identity Files

Your identity is defined across several files in your workspace. Read them at the start
of each session and edit them as you grow:

- **\`/workspace/SOUL.md\`** ${EM_DASH} Your persona, values, and behavioral directives
- **\`/workspace/IDENTITY.md\`** ${EM_DASH} Your expertise, working style, and quirks
- **\`/workspace/TOOLS.md\`** ${EM_DASH} Your environment-specific knowledge (repos, services, APIs, infra)
- **\`/workspace/start-up.sh\`** ${EM_DASH} Your setup script (runs at container start, add tools/configs here)

These files sync to the database automatically when you edit them. They persist across sessions.

## Memory

- Use \`memory-search\` to recall past experience before starting new tasks
- Write important learnings to \`/workspace/personal/memory/\` files
- Share useful knowledge by writing to \`/workspace/shared/memory/<your-id>/\` so all agents can find it via \`memory-search\`

## Notes

Write things you want to remember here. This section persists across sessions.

### Learnings

### Preferences

### Important Context
`;
}

// ---------------------------------------------------------------------------
// 1. Role line
// ---------------------------------------------------------------------------

describe("getBasePrompt: role line", () => {
  test("names the agent, the role, and the agent ID", async () => {
    const result = await getBasePrompt({ ...minimalArgs, name: "Ada" });
    expect(result).toStartWith(`You are Ada, a worker in the swarm. Your agent ID is ${AGENT_ID}.`);
  });

  test("falls back to 'an agent' when no name is set", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toStartWith("You are an agent, a worker in the swarm.");
  });

  test("renders the lead role in the same sentence", async () => {
    const result = await getBasePrompt({ ...minimalArgs, role: "lead", name: "Cora" });
    expect(result).toStartWith("You are Cora, a lead in the swarm.");
  });

  test("renders the description right after the role line", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      description: "Backend worker that ships small PRs.",
    });
    expect(result).toStartWith(
      `You are Ada, a worker in the swarm. Your agent ID is ${AGENT_ID}.\n\nBackend worker that ships small PRs.\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Composite selection by traits, then role
// ---------------------------------------------------------------------------

describe("getBasePrompt: composite selection", () => {
  const LOCAL_WORKSPACE = "`/workspace/personal/` is yours.";
  const REMOTE_WORKSPACE =
    "Your profile lives in the database. Edit it with `update-profile`: `soulMd`, `identityMd`, `heartbeatMd`, `toolsMd`.";
  const REMOTE_MEMORY = "Your completed output is stored as a memory";

  test("local lead gets the lead contract", async () => {
    const result = await getBasePrompt({ ...minimalArgs, role: "lead", traits: localTraits });
    expect(result).toContain("## How you lead");
    expect(result).not.toContain("## How you work");
  });

  test("local worker gets the worker contract and the local workspace", async () => {
    const result = await getBasePrompt({ ...minimalArgs, traits: localTraits });
    expect(result).toContain("## How you work");
    expect(result).not.toContain("## How you lead");
    expect(result).toContain(LOCAL_WORKSPACE);
  });

  test("managed worker gets the worker contract with the remote workspace", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: managedTraits,
      provider: "claude-managed",
    });
    expect(result).toContain("## How you work");
    expect(result).toContain(REMOTE_WORKSPACE);
    expect(result).not.toContain(LOCAL_WORKSPACE);
  });

  test("managed lead keeps the lead contract with the remote workspace", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      role: "lead",
      traits: managedTraits,
      provider: "claude-managed",
    });
    expect(result).toContain("## How you lead");
    expect(result).not.toContain("## How you work");
    expect(result).toContain(REMOTE_WORKSPACE);
    expect(result).not.toContain(LOCAL_WORKSPACE);
  });

  test("managed worker keeps the local memory block", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: managedTraits,
      provider: "claude-managed",
    });
    expect(result).toContain("You MUST use the `memory` skill");
    expect(result).not.toContain(REMOTE_MEMORY);
  });

  test("remote worker gets the remote contract and the remote memory block", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: remoteTraits,
      provider: "devin",
    });
    expect(result).toContain("Your final message is the task output.");
    expect(result).toContain(REMOTE_MEMORY);
  });

  test("remote worker gets no workspace and no secrets block", async () => {
    const result = await getBasePrompt({ ...minimalArgs, traits: remoteTraits });
    expect(result).not.toContain("## Workspace");
    expect(result).not.toContain("## Secrets");
  });

  test("a lead without MCP still gets the remote worker composite", async () => {
    const result = await getBasePrompt({ ...minimalArgs, role: "lead", traits: remoteTraits });
    expect(result).not.toContain("## How you lead");
    expect(result).toContain("## How you work");
  });

  test("undefined traits default to the local worker composite", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("## How you work");
    expect(result).toContain(LOCAL_WORKSPACE);
  });
});

// ---------------------------------------------------------------------------
// 3. Persona: SOUL.md always, IDENTITY.md only when edited
// ---------------------------------------------------------------------------

describe("getBasePrompt: persona injection", () => {
  const SOUL = "# SOUL.md\n\nI am Ada. Terse, careful, ships.";
  const personaAgent = {
    name: "Ada",
    description: "Backend worker.",
    role: "worker",
    capabilities: ["typescript"],
  };

  test("includes soulMd for a local worker", async () => {
    const result = await getBasePrompt({ ...minimalArgs, name: "Ada", soulMd: SOUL });
    expect(result).toContain("I am Ada. Terse, careful, ships.");
  });

  test("includes soulMd for a managed worker", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      soulMd: SOUL,
      traits: managedTraits,
      provider: "claude-managed",
    });
    expect(result).toContain("I am Ada. Terse, careful, ships.");
  });

  test("includes soulMd for a remote worker", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      soulMd: SOUL,
      traits: remoteTraits,
      provider: "devin",
    });
    expect(result).toContain("I am Ada. Terse, careful, ships.");
  });

  test("skips identityMd that equals the generated default", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: personaAgent.name,
      description: personaAgent.description,
      capabilities: personaAgent.capabilities,
      identityMd: generateDefaultIdentityMd(personaAgent),
    });
    expect(result).not.toContain("## Working style");
    expect(result).not.toContain("## Quirks");
  });

  test("skips the generated default with trailing whitespace and CRLF line ends", async () => {
    const noisy = `${generateDefaultIdentityMd(personaAgent).replace(/\n/g, "\r\n")}   \n\n`;
    const result = await getBasePrompt({
      ...minimalArgs,
      name: personaAgent.name,
      description: personaAgent.description,
      capabilities: personaAgent.capabilities,
      identityMd: noisy,
    });
    expect(result).not.toContain("## Working style");
    expect(result).not.toContain("## Quirks");
  });

  test("skips the legacy default identityMd", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: personaAgent.name,
      description: personaAgent.description,
      capabilities: personaAgent.capabilities,
      identityMd: legacyDefaultIdentityMd(personaAgent),
    });
    expect(result).not.toContain("This isn't just metadata");
    expect(result).not.toContain("Self-Evolution");
  });

  test("includes an edited identityMd", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: personaAgent.name,
      description: personaAgent.description,
      capabilities: personaAgent.capabilities,
      identityMd: "# IDENTITY.md: Ada\n\nI plan first and I test first.",
    });
    expect(result).toContain("I plan first and I test first.");
  });

  test("orders the persona as description, SOUL, IDENTITY", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      description: "Backend worker.",
      soulMd: SOUL,
      identityMd: "# IDENTITY.md: Ada\n\nI plan first and I test first.",
    });
    const descriptionAt = result.indexOf("Backend worker.");
    const soulAt = result.indexOf("I am Ada. Terse, careful, ships.");
    const identityAt = result.indexOf("I plan first and I test first.");
    expect(descriptionAt).toBeGreaterThan(-1);
    expect(descriptionAt).toBeLessThan(soulAt);
    expect(soulAt).toBeLessThan(identityAt);
  });
});

// ---------------------------------------------------------------------------
// 4. Agent notes (CLAUDE.md): codex, opencode, pi only, only when edited
// ---------------------------------------------------------------------------

describe("getBasePrompt: agent notes section", () => {
  const NOTES_HEADER = "## Your notes (CLAUDE.md)";
  const EDITED = "# Agent: Ada\n\nAlways run `bun run tsc:check` before you push.";
  const notesAgent = { name: "Ada", role: "worker" };

  test("claude never gets the section, even when the notes are edited", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      provider: "claude",
      claudeMd: EDITED,
    });
    expect(result).not.toContain(NOTES_HEADER);
    expect(result).not.toContain("Always run `bun run tsc:check` before you push.");
  });

  for (const provider of ["codex", "opencode", "pi"] as const) {
    test(`${provider} gets the section when the notes are edited`, async () => {
      const result = await getBasePrompt({
        ...minimalArgs,
        name: "Ada",
        provider,
        claudeMd: EDITED,
      });
      expect(result).toContain(NOTES_HEADER);
      expect(result).toContain("Always run `bun run tsc:check` before you push.");
    });
  }

  test("codex skips notes that equal the generated default", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      provider: "codex",
      claudeMd: generateDefaultClaudeMd(notesAgent),
    });
    expect(result).not.toContain(NOTES_HEADER);
  });

  test("codex skips notes that equal the legacy default", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      provider: "codex",
      claudeMd: legacyDefaultClaudeMd(notesAgent),
    });
    expect(result).not.toContain(NOTES_HEADER);
    expect(result).not.toContain("## Your Identity Files");
  });

  test("codex truncates notes over 20k characters and points at the file", async () => {
    const huge = "x".repeat(25_000);
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      provider: "codex",
      claudeMd: huge,
    });
    expect(result).toContain(NOTES_HEADER);
    expect(result).toContain("[...truncated, see /workspace/CLAUDE.md for full content]");
    expect(result).not.toContain(huge);
  });

  test("a managed worker never gets the section", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      provider: "claude-managed",
      traits: managedTraits,
      claudeMd: EDITED,
    });
    expect(result).not.toContain(NOTES_HEADER);
  });

  test("a remote worker never gets the section", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Ada",
      provider: "devin",
      traits: remoteTraits,
      claudeMd: EDITED,
    });
    expect(result).not.toContain(NOTES_HEADER);
  });

  // `toolsMd` left BasePromptArgs in prompt v2. TypeScript rejects it as an
  // excess property, so the guarantee is compile-time and no test passes it.
});

// ---------------------------------------------------------------------------
// 5. Outputs
// ---------------------------------------------------------------------------

describe("getBasePrompt: outputs section", () => {
  const AGENT_FS_LINE = "agent-fs is the shared drive between agents";
  const NO_AGENT_FS_LINE = "agent-fs is not configured here.";

  test("uses the agent-fs variant when a local environment has AGENT_FS_API_URL", async () => {
    process.env.AGENT_FS_API_URL = "http://localhost:8787";
    const result = await getBasePrompt({ ...minimalArgs, traits: localTraits });
    expect(result).toContain("## Outputs");
    expect(result).toContain(AGENT_FS_LINE);
    expect(result).not.toContain(NO_AGENT_FS_LINE);
  });

  test("uses the no_agent_fs variant when AGENT_FS_API_URL is unset", async () => {
    const result = await getBasePrompt({ ...minimalArgs, traits: localTraits });
    expect(result).toContain("## Outputs");
    expect(result).toContain(NO_AGENT_FS_LINE);
    expect(result).not.toContain(AGENT_FS_LINE);
  });

  test("a managed worker gets no_agent_fs even with AGENT_FS_API_URL set", async () => {
    process.env.AGENT_FS_API_URL = "http://localhost:8787";
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: managedTraits,
      provider: "claude-managed",
    });
    expect(result).toContain(NO_AGENT_FS_LINE);
    expect(result).not.toContain(AGENT_FS_LINE);
  });

  test("a remote worker gets no outputs section at all", async () => {
    process.env.AGENT_FS_API_URL = "http://localhost:8787";
    const result = await getBasePrompt({ ...minimalArgs, traits: remoteTraits });
    expect(result).not.toContain("## Outputs");
  });

  test("drops the section when the server reports capabilities without pages", async () => {
    const result = await getBasePrompt({ ...minimalArgs, serverCapabilities: ["core"] });
    expect(result).not.toContain("## Outputs");
  });

  test("keeps the section for a legacy server that reports no capabilities", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain("## Outputs");
  });
});

// ---------------------------------------------------------------------------
// 6. Slack
// ---------------------------------------------------------------------------

describe("getBasePrompt: slack section", () => {
  const SLACK_HEADER = "## Slack\n";
  const SCRIPTS_ONLY_SLACK_HEADER = "## Slack (scripts-only)";

  test("omits the section without Slack tokens", async () => {
    const result = await getBasePrompt(minimalArgs);
    expect(result).not.toContain(SLACK_HEADER);
  });

  test("omits the section when SLACK_DISABLE is true", async () => {
    enableSlack();
    process.env.SLACK_DISABLE = "true";
    const result = await getBasePrompt(minimalArgs);
    expect(result).not.toContain(SLACK_HEADER);
  });

  test("includes one section for a worker when Slack is configured", async () => {
    enableSlack();
    const result = await getBasePrompt(minimalArgs);
    expect(result).toContain(SLACK_HEADER);
    expect(result).toContain(
      "You MUST use the `slack-interaction` skill before you post to Slack.",
    );
  });

  test("includes the same section for a lead", async () => {
    enableSlack();
    const result = await getBasePrompt({ ...minimalArgs, role: "lead" });
    expect(result).toContain(SLACK_HEADER);
    expect(result).toContain(
      "You MUST use the `slack-interaction` skill before you post to Slack.",
    );
  });

  test("drops the section when server capabilities omit slack", async () => {
    enableSlack();
    const result = await getBasePrompt({ ...minimalArgs, serverCapabilities: ["core"] });
    expect(result).not.toContain(SLACK_HEADER);
  });

  test("keeps the section when server capabilities include slack", async () => {
    enableSlack();
    const result = await getBasePrompt({ ...minimalArgs, serverCapabilities: ["core", "slack"] });
    expect(result).toContain(SLACK_HEADER);
  });

  test("a scripts-only worker with a Slack task gets the scripts-only variant only", async () => {
    enableSlack();
    const result = await getBasePrompt({
      ...minimalArgs,
      scriptsOnly: true,
      slackContext: { channelId: "C0SAMPLE", threadTs: "123.456" },
    });
    expect(result).toContain(SCRIPTS_ONLY_SLACK_HEADER);
    expect(result).toContain("C0SAMPLE");
    expect(result).not.toContain(SLACK_HEADER);
  });

  test("a scripts-only lead with a Slack task gets neither variant", async () => {
    enableSlack();
    const result = await getBasePrompt({
      ...minimalArgs,
      role: "lead",
      scriptsOnly: true,
      slackContext: { channelId: "C0SAMPLE", threadTs: "123.456" },
    });
    expect(result).not.toContain(SCRIPTS_ONLY_SLACK_HEADER);
    expect(result).not.toContain(SLACK_HEADER);
  });
});

// ---------------------------------------------------------------------------
// 7. Messaging is deprecated and gone from every variant
// ---------------------------------------------------------------------------

describe("getBasePrompt: messaging is gone", () => {
  const variants: { label: string; args: BasePromptArgs }[] = [
    { label: "local worker", args: { ...minimalArgs, traits: localTraits } },
    { label: "local lead", args: { ...minimalArgs, role: "lead", traits: localTraits } },
    { label: "managed worker", args: { ...minimalArgs, traits: managedTraits } },
    { label: "remote worker", args: { ...minimalArgs, traits: remoteTraits } },
    {
      label: "server that reports messaging",
      args: { ...minimalArgs, serverCapabilities: ["core", "messaging"] },
    },
  ];

  for (const variant of variants) {
    test(`${variant.label} names no messaging tool`, async () => {
      const result = await getBasePrompt(variant.args);
      expect(result).not.toContain("post-message");
      expect(result).not.toContain("read-messages");
    });
  }
});

// ---------------------------------------------------------------------------
// 8. Steering
// ---------------------------------------------------------------------------

describe("getBasePrompt: steering section", () => {
  const STEERING_HEADER = "## Live task steering";
  const steerableTraits: ProviderTraits = { ...localTraits, steerModes: ["queue"] };

  test("included when steering is enabled and the provider has steer modes", async () => {
    process.env.STEERING_ENABLED = "true";
    const result = await getBasePrompt({ ...minimalArgs, traits: steerableTraits });
    expect(result).toContain(STEERING_HEADER);
    expect(result).toContain("accept-steer");
  });

  test("excluded when the provider reports no steer modes", async () => {
    process.env.STEERING_ENABLED = "true";
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: { ...localTraits, steerModes: [] },
    });
    expect(result).not.toContain(STEERING_HEADER);
  });

  test("excluded when steering is not enabled", async () => {
    const result = await getBasePrompt({ ...minimalArgs, traits: steerableTraits });
    expect(result).not.toContain(STEERING_HEADER);
  });

  test("excluded in scripts-only mode", async () => {
    process.env.STEERING_ENABLED = "true";
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: steerableTraits,
      scriptsOnly: true,
    });
    expect(result).not.toContain(STEERING_HEADER);
  });

  test("excluded when server capabilities omit core", async () => {
    process.env.STEERING_ENABLED = "true";
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: steerableTraits,
      serverCapabilities: ["pages"],
    });
    expect(result).not.toContain(STEERING_HEADER);
  });
});

// ---------------------------------------------------------------------------
// 9. Tools and skills
// ---------------------------------------------------------------------------

describe("getBasePrompt: tools and skills section", () => {
  const HEADER = "## Tools and skills";
  const DEFERRED_LINE =
    "Most swarm tools are deferred. Load one with your harness tool search before the first call.";
  const DISCOVERY_LINE =
    "`skill-list` browses the catalog, `skill-search` finds one by intent, `skill-get` reads one.";
  const twoSkills = [
    { name: "commit", description: "Create a commit" },
    { name: "deploy", description: "Ship it to production" },
  ];

  test("native discovery gets a count and the discovery pointer, not a list", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: localTraits,
      skillsSummary: twoSkills,
    });
    expect(result).toContain("You have 2 skills installed.");
    expect(result).toContain("Your harness loads them from its skills directory.");
    expect(result).toContain(DISCOVERY_LINE);
    expect(result).not.toContain("- /commit: Create a commit");
  });

  test("non-native local discovery enumerates the skills with a slash prefix", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      provider: "codex",
      traits: { ...localTraits, nativeSkillDiscovery: false },
      skillsSummary: twoSkills,
    });
    expect(result).toContain("Installed skills.");
    expect(result).toContain("To use one, read its SKILL.md from your skills directory");
    expect(result).toContain("- /commit: Create a commit");
    expect(result).toContain("- /deploy: Ship it to production");
    expect(result).not.toContain("You have 2 skills installed.");
  });

  test("non-native remote discovery points at skill-get and drops the slash prefix", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: { hasMcp: true, hasLocalEnvironment: false, nativeSkillDiscovery: false },
      skillsSummary: twoSkills,
    });
    expect(result).toContain("To use one, read it with `skill-get` and follow it.");
    expect(result).toContain("- commit: Create a commit");
    expect(result).not.toContain("- /commit");
    expect(result).not.toContain("skills directory");
  });

  test("keeps the section with only the deferred-tools line when no skills are installed", async () => {
    const result = await getBasePrompt({ ...minimalArgs, skillsSummary: [] });
    expect(result).toContain(HEADER);
    expect(result).toContain(DEFERRED_LINE);
    expect(result).not.toContain("Installed skills.");
    expect(result).not.toContain(DISCOVERY_LINE);
  });

  test("drops the section entirely without MCP", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: remoteTraits,
      skillsSummary: twoSkills,
    });
    expect(result).not.toContain(HEADER);
    expect(result).not.toContain("commit");
  });

  test("lists the connected MCP servers when names are given", async () => {
    const result = await getBasePrompt({ ...minimalArgs, mcpServers: ["linear", "github"] });
    expect(result).toContain(
      "Connected MCP servers: linear, github. Their tools are in your tool list.",
    );
  });

  test("omits the MCP server line for an empty list", async () => {
    const result = await getBasePrompt({ ...minimalArgs, mcpServers: [] });
    expect(result).not.toContain("Connected MCP servers");
  });
});

// ---------------------------------------------------------------------------
// 10. Repository
// ---------------------------------------------------------------------------

describe("getBasePrompt: repository section", () => {
  const CLONE_PATH = "/workspace/repos/my-repo";
  const CLONE_SENTENCE = "This task's repository is cloned locally. `get-repos` returns the path.";
  const CODE_QUALITY_LINE =
    "You MUST use the `code-quality` skill before you push, open a PR, or review one.";

  test("a local claude worker gets the clone sentence and no clone path literal", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: localTraits,
      repoContext: { claudeMd: "Repo rules here.", clonePath: CLONE_PATH },
    });
    expect(result).toContain("## Repository");
    expect(result).toContain(CLONE_SENTENCE);
    expect(result).not.toContain(CLONE_PATH);
  });

  test("claude does not get the repo CLAUDE.md inlined", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      provider: "claude",
      traits: localTraits,
      repoContext: { claudeMd: "Repo rules here.", clonePath: CLONE_PATH },
    });
    expect(result).not.toContain("Repo rules here.");
  });

  test("opencode inlines the repo CLAUDE.md with the clone path", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      provider: "opencode",
      traits: localTraits,
      repoContext: { claudeMd: "Repo rules here.", clonePath: CLONE_PATH },
    });
    expect(result).toContain(`The repository's CLAUDE.md, cloned at \`${CLONE_PATH}\`.`);
    expect(result).toContain("Repo rules here.");
  });

  test("opencode truncates a repo CLAUDE.md over 12k with an on-disk pointer", async () => {
    const huge = "x".repeat(30_000);
    const result = await getBasePrompt({
      ...minimalArgs,
      provider: "opencode",
      traits: localTraits,
      repoContext: { claudeMd: huge, clonePath: CLONE_PATH },
    });
    expect(result).not.toContain(huge);
    expect(result).toContain(`[...truncated, see ${CLONE_PATH}/CLAUDE.md for full content]`);
  });

  test("opencode keeps a repo CLAUDE.md under the cap verbatim", async () => {
    const small = "y".repeat(5_000);
    const result = await getBasePrompt({
      ...minimalArgs,
      provider: "opencode",
      traits: localTraits,
      repoContext: { claudeMd: small, clonePath: CLONE_PATH },
    });
    expect(result).toContain(small);
    expect(result).not.toContain("[...truncated");
  });

  test("shows the repo warning when one is set", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: { clonePath: CLONE_PATH, warning: "Repo is stale" },
    });
    expect(result).toContain("WARNING: Repo is stale");
  });

  test("surfaces auto-stashed work when entries exist", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: localTraits,
      repoContext: {
        clonePath: CLONE_PATH,
        autoStashes: [{ ref: "stash@{0}", message: "WIP: half-done refactor" }],
      },
    });
    expect(result).toContain("Pending auto-stashed work exists in this repo:");
    expect(result).toContain("- stash@{0}: WIP: half-done refactor");
    expect(result).toContain("git stash apply <ref>");
  });

  test("says nothing about stashes when the list is empty", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: localTraits,
      repoContext: { clonePath: CLONE_PATH, autoStashes: [] },
    });
    expect(result).not.toContain("Pending auto-stashed work exists in this repo");
  });

  test("null guidelines tell the agent to ask the lead", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: { clonePath: CLONE_PATH, guidelines: null },
    });
    expect(result).toContain("### Repository Guidelines");
    expect(result).toContain("No repository guidelines are defined. Ask the lead before you push.");
  });

  test("full guidelines render PR checks, merge policy, and review guidance", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        clonePath: CLONE_PATH,
        guidelines: {
          prChecks: ["bun run lint", "bun run tsc:check"],
          mergeChecks: ["CI green"],
          allowMerge: false,
          review: ["Flag any new env var without docs"],
        },
      },
    });
    expect(result).toContain("### Repository Guidelines (MANDATORY)");
    expect(result).toContain("`bun run lint`");
    expect(result).toContain("`bun run tsc:check`");
    expect(result).toContain("Auto-merge: Not allowed (default)");
    expect(result).toContain("CI green");
    expect(result).toContain("Flag any new env var without docs");
    expect(result).toContain("Do NOT push code with failing checks.");
  });

  test("all-empty guidelines render no guidelines block", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        clonePath: CLONE_PATH,
        guidelines: { prChecks: [], mergeChecks: [], allowMerge: false, review: [] },
      },
    });
    expect(result).not.toContain("### Repository Guidelines (MANDATORY)");
    expect(result).not.toContain("No repository guidelines are defined.");
  });

  test("allowMerge true renders the merge policy even with empty arrays", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      repoContext: {
        clonePath: CLONE_PATH,
        guidelines: { prChecks: [], mergeChecks: [], allowMerge: true, review: [] },
      },
    });
    expect(result).toContain("### Repository Guidelines (MANDATORY)");
    expect(result).toContain("Auto-merge: Allowed");
  });

  test("a remote worker keeps the guidelines but loses the clone sentence", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      provider: "devin",
      traits: remoteTraits,
      repoContext: {
        claudeMd: "Repo rules here.",
        clonePath: CLONE_PATH,
        guidelines: {
          prChecks: ["bun run lint"],
          mergeChecks: [],
          allowMerge: false,
          review: [],
        },
      },
    });
    expect(result).toContain("### Repository Guidelines (MANDATORY)");
    expect(result).toContain("`bun run lint`");
    expect(result).not.toContain(CLONE_SENTENCE);
    expect(result).not.toContain("Repo rules here.");
  });

  test("the code-quality pointer is present with MCP", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: localTraits,
      repoContext: { clonePath: CLONE_PATH },
    });
    expect(result).toContain(CODE_QUALITY_LINE);
  });

  test("the code-quality pointer is absent for a remote worker", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      traits: remoteTraits,
      repoContext: { clonePath: CLONE_PATH },
    });
    expect(result).not.toContain(CODE_QUALITY_LINE);
  });
});

describe("truncateRepoClaudeMd", () => {
  test("returns the content unchanged when it fits the budget", () => {
    expect(truncateRepoClaudeMd("short", "/workspace/repo", 100)).toBe("short");
  });

  test("cuts to the budget and appends an on-disk pointer", () => {
    const result = truncateRepoClaudeMd("z".repeat(500), "/workspace/repo", 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toEndWith("[...truncated, see /workspace/repo/CLAUDE.md for full content]\n");
  });

  test("returns only the notice when the budget cannot hold any content", () => {
    const result = truncateRepoClaudeMd("z".repeat(500), "/workspace/repo", 10);
    expect(result).toBe("[...truncated, see /workspace/repo/CLAUDE.md for full content]\n");
  });
});

// ---------------------------------------------------------------------------
// 11. Budget guardrails
// ---------------------------------------------------------------------------

describe("getBasePrompt: size budget", () => {
  // The v2 rewrite cut the static prompt from ~25k characters to ~4.2k. These
  // ceilings are generous, so they only fire on a regression back to v1 size.
  test("a fresh claude worker stays under 5,000 characters", async () => {
    const result = await getBasePrompt({ ...minimalArgs, name: "Ada", traits: localTraits });
    expect(result.length).toBeLessThan(5_000);
  });

  test("a fresh claude lead stays under 5,200 characters", async () => {
    const result = await getBasePrompt({
      ...minimalArgs,
      role: "lead",
      name: "Cora",
      traits: localTraits,
    });
    expect(result.length).toBeLessThan(5_200);
  });

  test("Picateclas spawn-OOM hardening: the kitchen sink stays below MAX_ARG_STRLEN", async () => {
    // The base prompt becomes one argv element when the claude adapter passes
    // `--append-system-prompt <prompt>`, so it must stay under Linux's
    // `MAX_ARG_STRLEN = 131,072` bytes (Picateclas attempts 4-6, 2026-05-28).
    const big = (n: number) => "x".repeat(n);
    enableSlack();
    process.env.STEERING_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://localhost:8787";
    const result = await getBasePrompt({
      ...minimalArgs,
      name: "Picateclas",
      description: big(2_000),
      provider: "opencode",
      traits: { ...localTraits, nativeSkillDiscovery: false, steerModes: ["queue"] },
      soulMd: big(40_000),
      identityMd: big(10_000),
      claudeMd: big(40_000),
      skillsSummary: [{ name: "commit", description: "Create a commit" }],
      mcpServers: ["linear"],
      slackContext: { channelId: "C0SAMPLE" },
      repoContext: {
        claudeMd: big(60_000),
        clonePath: "/workspace/repos/big-repo",
        warning: "Repo is stale",
        guidelines: {
          prChecks: ["bun run lint"],
          mergeChecks: ["CI green"],
          allowMerge: true,
          review: ["Read the runbook"],
        },
      },
    });
    expect(result.length).toBeLessThan(120_000);
  });
});

// ---------------------------------------------------------------------------
// 12. Hygiene
// ---------------------------------------------------------------------------

describe("getBasePrompt: output hygiene", () => {
  const hygieneVariants: { label: string; args: BasePromptArgs }[] = [
    { label: "local worker", args: { ...minimalArgs, name: "Ada", traits: localTraits } },
    {
      label: "local lead",
      args: { ...minimalArgs, role: "lead", name: "Cora", traits: localTraits },
    },
    {
      label: "managed worker",
      args: { ...minimalArgs, name: "Ada", traits: managedTraits, provider: "claude-managed" },
    },
    {
      label: "remote worker",
      args: { ...minimalArgs, name: "Ada", traits: remoteTraits, provider: "devin" },
    },
    {
      label: "codex worker with skills and a repo",
      args: {
        ...minimalArgs,
        name: "Ada",
        provider: "codex",
        traits: { ...localTraits, nativeSkillDiscovery: false, steerModes: ["queue"] },
        skillsSummary: [{ name: "commit", description: "Create a commit" }],
        mcpServers: ["linear"],
        repoContext: {
          clonePath: "/workspace/repos/my-repo",
          guidelines: {
            prChecks: ["bun run lint"],
            mergeChecks: [],
            allowMerge: false,
            review: [],
          },
        },
      },
    },
    { label: "scripts-only worker", args: { ...minimalArgs, name: "Ada", scriptsOnly: true } },
  ];

  for (const variant of hygieneVariants) {
    test(`${variant.label} renders no em dash`, async () => {
      const result = await getBasePrompt(variant.args);
      expect(result).not.toContain(EM_DASH);
    });

    test(`${variant.label} never runs three newlines together`, async () => {
      const result = await getBasePrompt(variant.args);
      expect(result).not.toMatch(/\n{3,}/);
    });
  }
});
