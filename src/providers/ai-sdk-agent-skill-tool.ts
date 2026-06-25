import { dynamicTool, jsonSchema } from "ai";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { McpHttpClient } from "./pi-mono-mcp-client";
import type { ProviderEvent } from "./types";

type SkillForResolution = {
  id?: string;
  name: string;
  description: string;
  content: string;
};

type McpClientLike = Pick<McpHttpClient, "callTool">;

function maxSkillChars(): number {
  return Number(process.env.MAX_SKILL_CHARS) || 100_000;
}

function normalizeSkillName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

export function resolveAvailableSkillByName(
  nameOrSlug: string,
  available: SkillForResolution[],
): { skill: SkillForResolution | null; matchedBy: "exact" | "fuzzy" | null } {
  const query = normalizeSkillName(nameOrSlug);
  const exact =
    available.find((skill) => normalizeSkillName(skill.name) === query) ??
    available.find((skill) => normalizeSkillName(skill.name).replaceAll("_", "-") === query) ??
    available.find((skill) => normalizeSkillName(skill.name).replaceAll("-", "_") === query);

  if (exact) {
    return { skill: exact, matchedBy: "exact" };
  }

  const fuzzy = available.find((skill) => {
    const name = normalizeSkillName(skill.name);
    const description = skill.description.toLowerCase();
    return name.includes(query) || query.includes(name) || description.includes(query);
  });

  return { skill: fuzzy ?? null, matchedBy: fuzzy ? "fuzzy" : null };
}

function skillsFromStructuredContent(structuredContent: unknown): SkillForResolution[] {
  const maybeSkills =
    structuredContent && typeof structuredContent === "object"
      ? (structuredContent as { skills?: unknown }).skills
      : undefined;
  if (!Array.isArray(maybeSkills)) return [];
  return maybeSkills.filter((skill): skill is SkillForResolution => {
    if (!skill || typeof skill !== "object") return false;
    const candidate = skill as Partial<SkillForResolution>;
    return (
      typeof candidate.name === "string" &&
      typeof candidate.description === "string" &&
      typeof candidate.content === "string"
    );
  });
}

async function listInstalledSkills(client: McpClientLike): Promise<SkillForResolution[]> {
  const result = await client.callTool("skill-list", {
    installedOnly: true,
    includeContent: true,
  });
  return skillsFromStructuredContent(result.structuredContent);
}

export async function loadAiSdkAgentSkillContent(args: {
  client: McpClientLike;
  name?: string;
  skill?: string;
}): Promise<string> {
  const requestedName = args.name ?? args.skill;
  if (!requestedName) {
    return "Provide a skill name.";
  }

  const available = await listInstalledSkills(args.client);
  const { skill } = resolveAvailableSkillByName(requestedName, available);

  if (!skill) {
    const candidates = available
      .slice(0, 8)
      .map((availableSkill) => availableSkill.name)
      .join(", ");
    return candidates
      ? `Skill "${requestedName}" not found for this agent. Available examples: ${candidates}.`
      : `Skill "${requestedName}" not found for this agent.`;
  }

  const originalChars = skill.content.length;
  const limit = maxSkillChars();
  return originalChars > limit ? skill.content.slice(0, limit) : skill.content;
}

export function createAiSdkAgentSkillTool(opts: {
  client: McpClientLike;
  emit: (event: ProviderEvent) => void;
}) {
  return dynamicTool({
    description:
      "Load one of this agent's installed skills into context by name or slug. Exact name matches are preferred; fuzzy matching falls back within this agent's available skills.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name or slug to load" },
        skill: { type: "string", description: "Alias for name" },
      },
      additionalProperties: false,
    }),
    execute: async (input, options) => {
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as { name?: string; skill?: string })
          : {};
      const toolCallId = options.toolCallId;
      opts.emit({ type: "tool_start", toolCallId, toolName: "Skill", args });
      try {
        const output = await loadAiSdkAgentSkillContent({ client: opts.client, ...args });
        opts.emit({ type: "tool_end", toolCallId, toolName: "Skill", result: output });
        return output;
      } catch (err) {
        const message = scrubSecrets(err instanceof Error ? err.message : String(err));
        opts.emit({ type: "error", message, category: "tool_error" });
        throw err;
      }
    },
  });
}
