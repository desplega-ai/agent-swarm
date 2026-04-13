/**
 * Parses SKILL.md content (YAML frontmatter + markdown body).
 */

export interface ParsedSkill {
  name: string;
  description: string;
  allowedTools?: string;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  body: string;
}

/**
 * Parse SKILL.md content into structured metadata + body.
 * Frontmatter is delimited by `---` lines at the start.
 */
export function parseSkillContent(content: string): ParsedSkill {
  const trimmed = content.trim();

  if (!trimmed.startsWith("---")) {
    throw new Error("Skill content must start with YAML frontmatter (---). No frontmatter found.");
  }

  const secondDelimiter = trimmed.indexOf("---", 3);
  if (secondDelimiter === -1) {
    throw new Error("Skill content has unterminated frontmatter. Missing closing ---.");
  }

  const frontmatterRaw = trimmed.slice(3, secondDelimiter).trim();
  const body = trimmed.slice(secondDelimiter + 3).trim();

  // Parse simple YAML key-value pairs
  const metadata: Record<string, string> = {};
  for (const line of frontmatterRaw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      metadata[key] = value;
    }
  }

  // Validate required fields
  if (!metadata.name) {
    throw new Error('Skill frontmatter is missing required field: "name"');
  }
  if (!metadata.description) {
    throw new Error('Skill frontmatter is missing required field: "description"');
  }

  return {
    name: metadata.name,
    description: metadata.description,
    allowedTools: metadata["allowed-tools"] || undefined,
    model: metadata.model || undefined,
    effort: metadata.effort || undefined,
    context: metadata.context || undefined,
    agent: metadata.agent || undefined,
    disableModelInvocation: metadata["disable-model-invocation"] === "true" ? true : undefined,
    userInvocable:
      metadata["user-invocable"] !== undefined ? metadata["user-invocable"] !== "false" : undefined,
    body,
  };
}
