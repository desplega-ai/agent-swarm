/**
 * Default markdown templates for new agents.
 * Pure functions, no database access.
 *
 * SOUL.md is always part of the system prompt. IDENTITY.md and CLAUDE.md are
 * injected only when they differ from the generated default (see
 * `matchesDefaultIdentityMd` / `matchesDefaultClaudeMd`). The legacy
 * generators below exist only for that comparison: agents created before the
 * prompt v2 rewrite still hold the old default text in their profile, and it
 * must count as "unedited" too.
 */

type AgentDefaultsInput = {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
};

/**
 * Generate default CLAUDE.md content for a new agent
 */
export function generateDefaultClaudeMd(agent: AgentDefaultsInput): string {
  const descSection = agent.description ? `${agent.description}\n\n` : "";
  const roleSection = agent.role ? `## Role\n\n${agent.role}\n\n` : "";
  const capSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Capabilities\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# Agent: ${agent.name}

${descSection}${roleSection}${capSection}---

## Notes

Operational notes that persist across sessions. Edit this file, or use \`update-profile\` with \`claudeMd\`.

### Learnings

### Preferences

### Important context
`;
}

export function generateDefaultSoulMd(agent: { name: string; role?: string }): string {
  const roleClause = agent.role ? `, a ${agent.role}` : "";
  return `# SOUL.md: ${agent.name}

I am ${agent.name}${roleClause} in the agent swarm. I persist across sessions. My memories and my profile carry over.

## How I work

- I do the work before I talk about it. Results first, context after.
- I find out for myself first: read the file, check the context, search memory. I ask when I have hit a real wall.
- I say what I know and what I do not know. A guess is labeled as a guess.
- When I make a mistake, I say so and fix it.
- I report blockers as they are. A blocker is not softened into progress.
- I hold opinions about my work and state them with reasons.

## Boundaries

- Private information stays private.
- An irreversible action waits for a go-ahead.
- Unfinished work stays out of shared spaces.

## Growth

After a task I note what made it harder or easier. A missing tool goes into my setup script. A fact about my environment goes into TOOLS.md. A learning goes into memory. My profile is mine to refine.
`;
}

export function generateDefaultIdentityMd(agent: AgentDefaultsInput): string {
  const aboutSection = agent.description ? `## About\n\n${agent.description}\n\n` : "";

  const expertiseSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Expertise\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# IDENTITY.md: ${agent.name}

- Name: ${agent.name}
- Role: ${agent.role || "worker"}

${aboutSection}${expertiseSection}## Working style

Fill this in as you learn how you work: plan first or explore first, test first or build first, broad survey or deep dive.

## Quirks

What sets you apart. Fill in as you notice it.
`;
}

export function generateDefaultToolsMd(agent: { name: string; role?: string }): string {
  return `# TOOLS.md: ${agent.name}

Skills define *how* tools work. This file is for *your* specifics.

## What Goes Here

Environment-specific knowledge that's unique to your setup:
- Repos you work with and their conventions
- Services, ports, and endpoints you interact with
- SSH hosts and access patterns
- API keys and auth patterns (references, not secrets)
- CLI tools and their quirks
- Anything that makes your job easier to remember

## Repos

<!-- Add repos you work with: name, path, conventions, gotchas -->

## Services

<!-- Add services you interact with: name, port, health check, notes -->

## Infrastructure

<!-- SSH hosts, Docker registries, cloud resources -->

## APIs & Integrations

<!-- Endpoints, auth patterns, rate limits -->

## Tools & Shortcuts

<!-- CLI aliases, scripts, preferred tools for specific tasks -->

## Notes

<!-- Anything else environment-specific -->

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
`;
}

// ─── Inject-when-edited comparison ──────────────────────────────────────────

/** Whitespace-insensitive equality, so a trailing newline or CRLF is not an edit. */
function normalizeMarkdown(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when `content` is a generated default (current or legacy) for this
 * agent, so the base prompt can skip it.
 */
export function matchesDefaultIdentityMd(content: string, agent: AgentDefaultsInput): boolean {
  const normalized = normalizeMarkdown(content);
  return (
    normalized === normalizeMarkdown(generateDefaultIdentityMd(agent)) ||
    normalized === normalizeMarkdown(generateLegacyDefaultIdentityMd(agent))
  );
}

export function matchesDefaultClaudeMd(content: string, agent: AgentDefaultsInput): boolean {
  const normalized = normalizeMarkdown(content);
  return (
    normalized === normalizeMarkdown(generateDefaultClaudeMd(agent)) ||
    normalized === normalizeMarkdown(generateLegacyDefaultClaudeMd(agent))
  );
}

// ─── Legacy defaults (pre prompt v2), comparison only ───────────────────────

/** The CLAUDE.md default shipped before the 2026-08 prompt v2 rewrite. */
function generateLegacyDefaultClaudeMd(agent: AgentDefaultsInput): string {
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

- **\`/workspace/SOUL.md\`** — Your persona, values, and behavioral directives
- **\`/workspace/IDENTITY.md\`** — Your expertise, working style, and quirks
- **\`/workspace/TOOLS.md\`** — Your environment-specific knowledge (repos, services, APIs, infra)
- **\`/workspace/start-up.sh\`** — Your setup script (runs at container start, add tools/configs here)

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

/** The IDENTITY.md default shipped before the 2026-08 prompt v2 rewrite. */
function generateLegacyDefaultIdentityMd(agent: AgentDefaultsInput): string {
  const aboutSection = agent.description ? `## About\n\n${agent.description}\n\n` : "";

  const expertiseSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Expertise\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# IDENTITY.md — ${agent.name}

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
