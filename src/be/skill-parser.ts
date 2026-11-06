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

  const frontmatterRaw = trimmed.slice(3, secondDelimiter);
  const body = trimmed.slice(secondDelimiter + 3).trim();

  // Keep permissive single-line values; delegate block scalar semantics to YAML.
  const metadata: Record<string, string> = {};
  const lines = frontmatterRaw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (/^[>|][-+]?$/.test(value)) {
      const start = i;
      const indentation = line.length - line.trimStart().length;
      while (i + 1 < lines.length) {
        const next = lines[i + 1] as string;
        if (next.trim() && next.length - next.trimStart().length <= indentation) break;
        i++;
      }
      // The final split entry already represents the frontmatter's terminating newline.
      const scalar = lines.slice(start, i + 1).join("\n") + (i < lines.length - 1 ? "\n" : "");
      const block = Bun.YAML.parse(scalar) as Record<string, string>;
      value = block[key] ?? "";
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      // Preserve the existing JSON-unescaping and malformed-quote fallback.
      try {
        value = JSON.parse(value) as string;
      } catch {
        // keep raw
      }
    }
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
