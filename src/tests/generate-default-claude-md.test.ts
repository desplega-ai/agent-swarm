import { describe, expect, test } from "bun:test";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  matchesDefaultClaudeMd,
  matchesDefaultIdentityMd,
} from "../prompts/defaults";

/** U+2014. Written as an escape so this file stays free of the character. */
const EM_DASH = "\u2014";

/** The CLAUDE.md default shipped before the prompt v2 rewrite. */
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

/** The IDENTITY.md default shipped before the prompt v2 rewrite. */
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

describe("generateDefaultClaudeMd", () => {
  test("should generate basic template with just name", () => {
    const result = generateDefaultClaudeMd({ name: "TestAgent" });

    expect(result).toContain("# Agent: TestAgent");
    expect(result).toContain("## Notes");
    expect(result).toContain("### Learnings");
    expect(result).toContain("### Preferences");
    expect(result).toContain("### Important context");
  });

  test("should point at update-profile and drop the identity file list", () => {
    const result = generateDefaultClaudeMd({ name: "TestAgent" });

    expect(result).toContain("## Notes");
    expect(result).toContain("`update-profile`");
    expect(result).toContain("### Important context");
    expect(result).not.toContain("/workspace/SOUL.md");
    expect(result).not.toContain("## Your Identity Files");
    expect(result).not.toContain("## Memory");
  });

  test("should include description when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      description: "A helpful test agent",
    });

    expect(result).toContain("# Agent: TestAgent");
    expect(result).toContain("A helpful test agent");
  });

  test("should include role section when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      role: "Frontend Developer",
    });

    expect(result).toContain("## Role");
    expect(result).toContain("Frontend Developer");
  });

  test("should include capabilities list when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      capabilities: ["typescript", "react", "node"],
    });

    expect(result).toContain("## Capabilities");
    expect(result).toContain("- typescript");
    expect(result).toContain("- react");
    expect(result).toContain("- node");
  });

  test("should include all fields when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "FullAgent",
      description: "A fully configured agent",
      role: "Senior Engineer",
      capabilities: ["python", "docker"],
    });

    expect(result).toContain("# Agent: FullAgent");
    expect(result).toContain("A fully configured agent");
    expect(result).toContain("## Role");
    expect(result).toContain("Senior Engineer");
    expect(result).toContain("## Capabilities");
    expect(result).toContain("- python");
    expect(result).toContain("- docker");
    expect(result).toContain("## Notes");
  });

  test("should not include role section when role is undefined", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      role: undefined,
    });

    expect(result).not.toContain("## Role");
  });

  test("should not include capabilities section when capabilities is empty", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      capabilities: [],
    });

    expect(result).not.toContain("## Capabilities");
  });

  test("should handle special characters in name", () => {
    const result = generateDefaultClaudeMd({
      name: "Test Agent (v2.0)",
    });

    expect(result).toContain("# Agent: Test Agent (v2.0)");
  });
});

// The base prompt injects CLAUDE.md and IDENTITY.md only when the agent edited
// them, so "unedited" must cover the current default and the pre-v2 default.
const AGENT = {
  name: "TestAgent",
  description: "A helpful test agent",
  role: "worker",
  capabilities: ["typescript"],
};

describe("matchesDefaultClaudeMd", () => {
  test("matches the current generated default", () => {
    expect(matchesDefaultClaudeMd(generateDefaultClaudeMd(AGENT), AGENT)).toBe(true);
  });

  test("matches the legacy default", () => {
    expect(matchesDefaultClaudeMd(legacyDefaultClaudeMd(AGENT), AGENT)).toBe(true);
  });

  test("matches through whitespace differences", () => {
    const noisy = `\n\n${generateDefaultClaudeMd(AGENT).replace(/\n/g, "\r\n")}   \n`;
    expect(matchesDefaultClaudeMd(noisy, AGENT)).toBe(true);
  });

  test("does not match after a one-word edit", () => {
    const edited = generateDefaultClaudeMd(AGENT).replace("Learnings", "Lessons");
    expect(matchesDefaultClaudeMd(edited, AGENT)).toBe(false);
  });
});

describe("matchesDefaultIdentityMd", () => {
  test("matches the current generated default", () => {
    expect(matchesDefaultIdentityMd(generateDefaultIdentityMd(AGENT), AGENT)).toBe(true);
  });

  test("matches the legacy default", () => {
    expect(matchesDefaultIdentityMd(legacyDefaultIdentityMd(AGENT), AGENT)).toBe(true);
  });

  test("matches through whitespace differences", () => {
    const noisy = `\n\n${generateDefaultIdentityMd(AGENT).replace(/\n/g, "\r\n")}   \n`;
    expect(matchesDefaultIdentityMd(noisy, AGENT)).toBe(true);
  });

  test("does not match after a one-word edit", () => {
    const edited = generateDefaultIdentityMd(AGENT).replace("Quirks", "Habits");
    expect(matchesDefaultIdentityMd(edited, AGENT)).toBe(false);
  });
});
