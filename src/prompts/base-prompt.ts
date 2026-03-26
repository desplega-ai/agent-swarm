/**
 * System prompt assembly for agent sessions.
 *
 * Uses the template registry (session-templates.ts) for the core prompt
 * building blocks. Dynamic sections (identity, repo context, CLAUDE.md,
 * TOOLS.md) and conditional sections (agent_fs, services, artifacts) are
 * still assembled here based on runtime state.
 */

import { resolveTemplateAsync } from "./resolver";

// Side-effect import: register all system + session templates
import "./session-templates";

/** Max characters per individual injected section before truncation */
const BOOTSTRAP_MAX_CHARS = 20_000;

/** Max total characters across all injected sections combined */
const BOOTSTRAP_TOTAL_MAX_CHARS = 150_000;

/** Truncation notice appended when a section is cut */
const truncationNotice = (file: string) =>
  `\n\n[...truncated, see /workspace/${file} for full content]\n`;

export type BasePromptArgs = {
  role: string;
  agentId: string;
  swarmUrl: string;
  capabilities?: string[];
  name?: string;
  description?: string;
  soulMd?: string;
  identityMd?: string;
  toolsMd?: string;
  claudeMd?: string;
  repoContext?: {
    claudeMd?: string | null;
    clonePath: string;
    warning?: string | null;
  };
  /** Pre-fetched skill summaries for the installed skills section */
  skillsSummary?: { name: string; description: string }[];
  /** Pre-fetched MCP server summaries for the installed MCP servers section */
  mcpServersSummary?: string;
};

export const getBasePrompt = async (args: BasePromptArgs): Promise<string> => {
  const { role, agentId, swarmUrl } = args;

  const vars: Record<string, string> = { role, agentId, swarmUrl };

  // Resolve the composite session template (lead or worker)
  const compositeEventType = role === "lead" ? "system.session.lead" : "system.session.worker";
  const compositeResult = await resolveTemplateAsync(compositeEventType, vars);
  let prompt = compositeResult.text;

  // Inject agent identity (soul + identity + name/description) if available
  if (args.soulMd || args.identityMd || args.name) {
    prompt += "\n\n## Your Identity\n\n";
    if (args.name) {
      prompt += `**Name:** ${args.name}\n`;
      if (args.description) {
        prompt += `**Description:** ${args.description}\n`;
      }
      prompt += "\n";
    }
    if (args.soulMd) {
      prompt += `${args.soulMd}\n`;
    }
    if (args.identityMd) {
      prompt += `${args.identityMd}\n`;
    }
  }

  // Installed skills section (progressive disclosure — name + description only)
  if (args.skillsSummary && args.skillsSummary.length > 0) {
    const summaries = args.skillsSummary.map((s) => `- /${s.name}: ${s.description}`).join("\n");
    prompt += `\n\n## Installed Skills\n\nThe following skills are available. Use the Skill tool to invoke them by name.\n\n${summaries}\n`;
  }

  // Installed MCP servers section
  if (args.mcpServersSummary) {
    prompt += `\n\n## Installed MCP Servers\n\nThe following MCP servers are configured for your use:\n${args.mcpServersSummary}\n`;
  }

  // Repo context (protected, never truncated)
  if (args.repoContext) {
    prompt += "\n\n## Repository Context\n\n";

    if (args.repoContext.warning) {
      prompt += `WARNING: ${args.repoContext.warning}\n\n`;
    }

    if (args.repoContext.claudeMd) {
      prompt += `The following CLAUDE.md is from the repository cloned at \`${args.repoContext.clonePath}\`. `;
      prompt += `**IMPORTANT: These instructions apply ONLY when working within the \`${args.repoContext.clonePath}\` directory.** `;
      prompt += `Do NOT apply these rules to files outside that directory.\n\n`;
      prompt += `${args.repoContext.claudeMd}\n`;
    } else if (!args.repoContext.warning) {
      prompt += `Repository is cloned at \`${args.repoContext.clonePath}\` but has no CLAUDE.md file.\n`;
    }
  }

  // Build conditional suffix (sections that depend on runtime env/capabilities)
  let conditionalSuffix = "";

  // Conditionally include agent-fs instructions when available
  if (process.env.AGENT_FS_API_URL) {
    const sharedOrgId = process.env.AGENT_FS_SHARED_ORG_ID || "YOUR_SHARED_ORG_ID";
    const agentFsResult = await resolveTemplateAsync("system.agent.agent_fs", {
      agentId,
      sharedOrgId,
    });
    conditionalSuffix += agentFsResult.text;
  }

  if (!args.capabilities || args.capabilities.includes("services")) {
    const servicesResult = await resolveTemplateAsync("system.agent.services", {
      agentId,
      swarmUrl,
    });
    conditionalSuffix += servicesResult.text;
  }

  if (!args.capabilities || args.capabilities.includes("artifacts")) {
    const artifactsResult = await resolveTemplateAsync("system.agent.artifacts", {});
    conditionalSuffix += artifactsResult.text;
  }

  if (args.capabilities) {
    conditionalSuffix += `
### Capabilities enabled for this agent:

- ${args.capabilities.join("\n- ")}
`;
  }

  // Inject truncatable sections with per-section and total character caps
  // Priority: agent CLAUDE.md > tools (tools cut first when over total budget)
  const protectedLength = prompt.length + conditionalSuffix.length;
  const totalBudget = Math.max(0, BOOTSTRAP_TOTAL_MAX_CHARS - protectedLength);
  let totalUsed = 0;

  // Agent CLAUDE.md (higher priority — injected first)
  if (args.claudeMd) {
    const perSectionBudget = Math.min(BOOTSTRAP_MAX_CHARS, totalBudget - totalUsed);
    const section = truncateSection(
      args.claudeMd,
      "## Agent Instructions",
      "CLAUDE.md",
      perSectionBudget,
    );
    prompt += section;
    totalUsed += section.length;
  }

  // Tools (lower priority — gets whatever budget remains)
  if (args.toolsMd) {
    const perSectionBudget = Math.min(BOOTSTRAP_MAX_CHARS, totalBudget - totalUsed);
    const section = truncateSection(
      args.toolsMd,
      "## Your Tools & Capabilities",
      "TOOLS.md",
      perSectionBudget,
    );
    prompt += section;
    totalUsed += section.length;
  }

  prompt += conditionalSuffix;

  return prompt;
};

/** Truncate a section to fit within a character budget, appending a notice if cut */
function truncateSection(
  content: string | undefined,
  header: string,
  fileName: string,
  budget: number,
): string {
  if (!content || budget <= 0) return "";

  const fullSection = `\n\n${header}\n\n${content}\n`;
  if (fullSection.length <= budget) return fullSection;

  const headerStr = `\n\n${header}\n\n`;
  const notice = truncationNotice(fileName);
  const contentBudget = budget - headerStr.length - notice.length;

  if (contentBudget > 0) {
    return headerStr + content.slice(0, contentBudget) + notice;
  }

  return "";
}
