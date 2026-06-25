/**
 * System prompt assembly for agent sessions.
 *
 * Uses the template registry (session-templates.ts) for the core prompt
 * building blocks. Dynamic sections (identity, repo context, CLAUDE.md,
 * TOOLS.md) and conditional sections (agent_fs, services, artifacts) are
 * still assembled here based on runtime state.
 */

import type { ProviderTraits } from "../providers/types";
import type { ProviderName } from "../types";
import { resolveTemplateAsync } from "./resolver";

// Side-effect import: register all system + session templates
import "./session-templates";

/** Max characters per individual injected section before truncation */
const BOOTSTRAP_MAX_CHARS = 20_000;

/**
 * Max total characters across all injected sections combined.
 *
 * Sized to stay safely below Linux's `MAX_ARG_STRLEN = 131,072` bytes — the
 * per-argv-element kernel limit that bit Picateclas attempts 4-6
 * (2026-05-28). The base-prompt becomes one argv element when the claude
 * adapter passes `--append-system-prompt <prompt>`, so the prompt MUST stay
 * under MAX_ARG_STRLEN even with a few KB of growth. The claude-adapter
 * also stages the prompt to a file (`--append-system-prompt-file`) as a
 * belt-and-braces fix, but the budget cap is the cheap insurance for any
 * code path that ever passes the prompt inline.
 */
const BOOTSTRAP_TOTAL_MAX_CHARS = 120_000;

/**
 * Per-section cap applied to the *repo* CLAUDE.md (the agent-swarm OSS
 * one is ~18 KB and the biggest volatile component of the system prompt).
 * 12 KB leaves room for the static prompt scaffold + identity + tools +
 * agent CLAUDE.md without ever crossing MAX_ARG_STRLEN.
 */
const REPO_CLAUDE_MD_MAX_CHARS = 12_000;

/** Truncation notice appended when a section is cut */
const truncationNotice = (file: string) =>
  `\n\n[...truncated, see /workspace/${file} for full content]\n`;

export function areSlackPromptToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const slackDisable = env.SLACK_DISABLE;
  if (slackDisable === "true" || slackDisable === "1") return false;

  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN);
}

export type BasePromptArgs = {
  role: string;
  agentId: string;
  swarmUrl: string;
  capabilities?: string[];
  traits?: ProviderTraits;
  /**
   * Harness provider for this session. Gates provider-specific prompt blocks
   * (e.g. the context-mode block is excluded for `pi`, which has no
   * context-mode MCP wiring yet — deferred to DES-514).
   */
  provider?: ProviderName;
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
    autoStashes?: { ref: string; message: string }[];
    guidelines?: {
      prChecks: string[];
      mergeChecks: string[];
      allowMerge?: boolean;
      review: string[];
    } | null;
  };
  /** Slack context from the current task, if present */
  slackContext?: { channelId: string; threadTs?: string };
  /** Pre-fetched skill summaries for the installed skills section */
  skillsSummary?: { name: string; description: string }[];
  /** Pre-fetched MCP server summaries for the installed MCP servers section */
  mcpServersSummary?: string;
};

export const getBasePrompt = async (args: BasePromptArgs): Promise<string> => {
  const { role, agentId, swarmUrl, traits } = args;
  const { hasMcp = true, hasLocalEnvironment: hasLocalEnv = true } = traits ?? {};

  const vars: Record<string, string> = { role, agentId, swarmUrl };

  // Resolve the composite session template (trait-aware for remote providers)
  let compositeEventType: string;
  if (!hasMcp) {
    // If no MCP, role cannot be lead
    compositeEventType = "system.session.worker.remote";
  } else if (role === "lead") {
    compositeEventType = "system.session.lead";
  } else if (args.provider === "pi") {
    // Pi has no context-mode MCP wiring yet (deferred to DES-514), so it uses a
    // worker composite that omits the context_mode block to avoid advertising
    // phantom `ctx_*` tools. All other local providers (claude, codex,
    // opencode, ai-sdk-agent) keep the block via the standard worker composite.
    compositeEventType = "system.session.worker.pi";
  } else {
    compositeEventType = "system.session.worker";
  }
  const compositeResult = await resolveTemplateAsync(compositeEventType, vars);
  let prompt = compositeResult.text;

  const slackPromptToolsEnabled = areSlackPromptToolsEnabled();

  if (hasMcp && slackPromptToolsEnabled) {
    const slackResult = await resolveTemplateAsync("system.agent.slack", {});
    prompt += slackResult.text;
  }

  // Conditionally inject Slack instructions for workers with Slack-originated tasks
  if (role !== "lead" && args.slackContext && hasMcp && slackPromptToolsEnabled) {
    const slackResult = await resolveTemplateAsync("system.agent.worker.slack", {
      slackChannelId: args.slackContext.channelId,
      slackThreadTs: args.slackContext.threadTs ?? "",
    });
    prompt += slackResult.text;
  }

  // Inject agent identity
  if (!hasLocalEnv) {
    // Simplified identity for remote providers — no self-evolution, no /workspace files
    prompt += "\n\n## Your Identity\n\n";
    if (args.name) {
      prompt += `**Name:** ${args.name}\n`;
      if (args.description) {
        prompt += `**Description:** ${args.description}\n`;
      }
      prompt += "\n";
    }
    prompt += `You are part of an agent swarm managed by the Desplega platform. `;
    prompt += `You receive tasks from the swarm's lead agent and execute them independently. `;
    prompt += `Focus on quality work and clear communication of results.\n`;
  } else if (args.soulMd || args.identityMd || args.name) {
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
  if (hasMcp && args.skillsSummary && args.skillsSummary.length > 0) {
    const summaries = args.skillsSummary.map((s) => `- /${s.name}: ${s.description}`).join("\n");
    const usage =
      args.provider === "ai-sdk-agent"
        ? "Use the Skill tool to load them by name."
        : "Use the slash-command name when invoking them.";
    prompt += `\n\n## Installed Skills\n\nThe following skills are available. ${usage}\n\n${summaries}\n`;
  }

  // Installed MCP servers section — skip for providers without MCP
  if (hasMcp && args.mcpServersSummary) {
    prompt += `\n\n## Installed MCP Servers\n\nThe following MCP servers are configured for your use:\n${args.mcpServersSummary}\n`;
  }

  // Repo context (protected, never truncated)
  if (args.repoContext) {
    prompt += "\n\n## Repository Context\n\n";

    if (args.repoContext.warning) {
      prompt += `WARNING: ${args.repoContext.warning}\n\n`;
    }

    if (hasLocalEnv) {
      if (args.repoContext.claudeMd) {
        prompt += `The following CLAUDE.md is from the repository cloned at \`${args.repoContext.clonePath}\`. `;
        prompt += `**IMPORTANT: These instructions apply ONLY when working within the \`${args.repoContext.clonePath}\` directory.** `;
        prompt += `Do NOT apply these rules to files outside that directory.\n\n`;
        // Cap the repo CLAUDE.md so it can't blow the bootstrap budget on its
        // own. Pre-cap, the agent-swarm OSS CLAUDE.md was 17,856 B — the
        // single biggest volatile component of the system prompt and the
        // direct driver of the Picateclas argv-E2BIG saga (2026-05-28).
        // Truncation footer points readers at the on-disk copy in the cwd.
        prompt += `${truncateRepoClaudeMd(
          args.repoContext.claudeMd,
          args.repoContext.clonePath,
          REPO_CLAUDE_MD_MAX_CHARS,
        )}\n`;
      } else if (!args.repoContext.warning) {
        prompt += `Repository is cloned at \`${args.repoContext.clonePath}\` but has no CLAUDE.md file.\n`;
      }

      if (args.repoContext.autoStashes && args.repoContext.autoStashes.length > 0) {
        const stashes = args.repoContext.autoStashes
          .map((stash) => `- ${stash.ref}: ${stash.message}`)
          .join("\n");
        prompt += `\nPending auto-stashed work exists in this repo:\n${stashes}\nRestore if relevant with \`git stash apply <ref>\` or \`git stash pop <ref>\`.\n`;
      }
    }

    // Inject repo guidelines
    const g = args.repoContext.guidelines;
    if (g === null || g === undefined) {
      prompt += `\n### Repository Guidelines\n\nNo repository guidelines defined. If you need to push code, ask the lead or user to define guidelines first.\n`;
    } else {
      const hasAnyContent =
        g.prChecks.length > 0 || g.mergeChecks.length > 0 || g.review.length > 0 || g.allowMerge;
      if (hasAnyContent) {
        prompt += `\n### Repository Guidelines (MANDATORY)\n\n`;
        if (g.prChecks.length > 0) {
          prompt += `**PR Checks — Run ALL before pushing code or creating a PR:**\n`;
          g.prChecks.forEach((check, i) => {
            prompt += `${i + 1}. \`${check}\`\n`;
          });
          prompt += `If ANY check fails, fix the issue before pushing. Do NOT push code with failing checks.\nDo NOT use \`--no-verify\` or any flag that bypasses git hooks.\n\n`;
        }
        prompt += `**Merge Policy:**\n`;
        prompt += `- Auto-merge: ${g.allowMerge ? "Allowed" : "Not allowed (default)"}\n`;
        if (g.mergeChecks.length > 0) {
          prompt += `- Before merging, verify:\n`;
          g.mergeChecks.forEach((check) => {
            prompt += `  - ${check}\n`;
          });
        }
        prompt += `\n`;
        if (g.review.length > 0) {
          prompt += `**Review Guidance:**\n`;
          g.review.forEach((item) => {
            prompt += `- ${item}\n`;
          });
          prompt += `\n`;
        }
      }
    }
  }

  // Skip conditional suffix and truncatable sections for remote providers — these
  // reference local Docker environment features (agent-fs, services, artifacts, /workspace files)
  if (hasLocalEnv) {
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
  }

  return prompt;
};

/**
 * Truncate the repo CLAUDE.md to a hard byte budget so it can't blow the
 * bootstrap argv ceiling on its own (Picateclas spawn-OOM, 2026-05-28).
 *
 * The footer is structured as a `[truncated — see <path>/CLAUDE.md for full
 * content]` notice so anyone reading the system prompt knows exactly where
 * the dropped content lives on disk.
 *
 * Exported only for testing.
 */
export function truncateRepoClaudeMd(content: string, clonePath: string, budget: number): string {
  if (content.length <= budget) return content;
  const notice = `\n\n[...truncated — see ${clonePath}/CLAUDE.md for full content]\n`;
  const contentBudget = budget - notice.length;
  if (contentBudget <= 0) return notice.trimStart();
  return content.slice(0, contentBudget) + notice;
}

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
