/**
 * System prompt assembly for agent sessions (prompt v2).
 *
 * Order, static before volatile:
 *
 *   A-D, F, G  composite session template (role + persona, contract, workspace,
 *              memory, communication, secrets) from session-templates.ts
 *   E          outputs (gated on AGENT_FS_API_URL and the pages capability)
 *   H          deployment-gated notes: slack, steering
 *   I          tools and skills (deferred-tools line, skills, MCP server names)
 *   J          agent notes: CLAUDE.md for codex, opencode, pi, only when edited
 *   K          repository (per task)
 *
 * The runner appends the requester profile, the operator SYSTEM_PROMPT, and a
 * cwd warning after this.
 */

import type { ProviderTraits } from "../providers/types";
import type { ProviderName } from "../types";
import { isSteeringEnabled } from "../utils/steering-enabled";
import { matchesDefaultClaudeMd, matchesDefaultIdentityMd } from "./defaults";
import { resolveTemplateAsync } from "./resolver";

// Side-effect import: register all system + session templates
import "./session-templates";

/** Max characters for the injected agent CLAUDE.md section before truncation */
export const BOOTSTRAP_MAX_CHARS = 20_000;

/**
 * Max total characters for the whole base prompt.
 *
 * Sized to stay safely below Linux's `MAX_ARG_STRLEN = 131,072` bytes, the
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
 * Per-section cap applied to the *repo* CLAUDE.md when it is inlined (opencode
 * only). The agent-swarm OSS one is ~18 KB and the biggest volatile component
 * of the system prompt.
 */
const REPO_CLAUDE_MD_MAX_CHARS = 12_000;

/** Providers that do not load the agent's CLAUDE.md natively. Claude does. */
const CLAUDE_MD_INJECT_PROVIDERS: ReadonlySet<string> = new Set(["codex", "opencode", "pi"]);

/** Providers that get the repo CLAUDE.md inlined until native loading is verified. */
const REPO_CLAUDE_MD_INLINE_PROVIDERS: ReadonlySet<string> = new Set(["opencode"]);

export function areSlackPromptToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const slackDisable = env.SLACK_DISABLE;
  if (slackDisable === "true" || slackDisable === "1") return false;

  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN);
}

export type BasePromptArgs = {
  role: string;
  agentId: string;
  /** The agent's own declared skill tags (task routing). Also an input to the generated defaults. */
  capabilities?: string[];
  /**
   * The API server's enabled capability flags (which MCP tool groups it
   * registers), from the register response. Gates prompt sections that
   * instruct capability-gated tools so agents aren't told about tools the
   * server doesn't expose. Undefined when the server is older and doesn't
   * report it; sections then fall back to their legacy inclusion rules.
   */
  serverCapabilities?: string[];
  traits?: ProviderTraits;
  /** Harness provider for this session. Gates the CLAUDE.md injection. */
  provider?: ProviderName;
  /**
   * Resolved by the runner from the worker environment and raw config row.
   * Direct callers retain the process-env fallback below during migration.
   */
  scriptsOnly?: boolean;
  name?: string;
  description?: string;
  soulMd?: string;
  identityMd?: string;
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
  /** Pre-fetched skill summaries for the tools and skills section */
  skillsSummary?: { name: string; description: string }[];
  /** Names of the MCP servers connected for this agent */
  mcpServers?: string[];
};

export const getBasePrompt = async (args: BasePromptArgs): Promise<string> => {
  const { role, agentId, traits } = args;
  const {
    hasMcp = true,
    hasLocalEnvironment: hasLocalEnv = true,
    nativeSkillDiscovery = true,
  } = traits ?? {};
  const steerModes = traits?.steerModes ?? [];
  const provider = args.provider ?? "claude";

  const defaultsInput = {
    name: args.name ?? agentId,
    description: args.description,
    role,
    capabilities: args.capabilities,
  };

  // A. Persona: description, SOUL.md always, IDENTITY.md only when edited.
  const personaParts: string[] = [];
  if (args.description) personaParts.push(args.description);
  if (args.soulMd) personaParts.push(args.soulMd.trim());
  if (args.identityMd && !matchesDefaultIdentityMd(args.identityMd, defaultsInput)) {
    personaParts.push(args.identityMd.trim());
  }
  const persona = personaParts.length > 0 ? `\n${personaParts.join("\n\n")}\n` : "";

  const vars: Record<string, string> = {
    name: args.name ?? "an agent",
    role,
    agentId,
    persona,
  };

  // Composite choice by traits, then role.
  let compositeEventType: string;
  if (!hasMcp) {
    // No MCP means no tools to name and no lead role (devin).
    compositeEventType = "system.session.worker.remote";
  } else if (!hasLocalEnv) {
    // MCP tools but no container or /workspace mirrors (claude-managed).
    compositeEventType =
      role === "lead" ? "system.session.lead.managed" : "system.session.worker.managed";
  } else if (role === "lead") {
    compositeEventType = "system.session.lead";
  } else {
    compositeEventType = "system.session.worker";
  }
  const compositeResult = await resolveTemplateAsync(compositeEventType, vars);
  let prompt = compositeResult.text;

  // Experimental scripts-only MCP surface (code-mode): named swarm tools are
  // not registered, so tell the agent everything goes through script-run.
  const scriptsOnly = args.scriptsOnly ?? process.env.SCRIPTS_ONLY_MCP === "true";
  const scriptsOnlyMode = hasMcp && scriptsOnly;
  if (scriptsOnlyMode) {
    const scriptsOnlyResult = await resolveTemplateAsync("system.agent.scripts_only_mode", {});
    prompt += `\n${scriptsOnlyResult.text}`;
  }

  // Server-side capability flags gate which MCP tool groups the API server
  // registers. When the server is older and didn't report its capabilities,
  // `whenUnknown` picks the legacy behavior per section.
  const serverHasCapability = (cap: string, whenUnknown: boolean): boolean =>
    args.serverCapabilities ? args.serverCapabilities.includes(cap) : whenUnknown;

  // E. Outputs. Pages and apps register under the `pages` capability; the
  // agent-fs CLI needs a local environment with AGENT_FS_API_URL set.
  if (hasMcp && serverHasCapability("pages", true)) {
    const agentFsConfigured = hasLocalEnv && Boolean(process.env.AGENT_FS_API_URL);
    const outputsResult = await resolveTemplateAsync(
      agentFsConfigured ? "system.agent.outputs" : "system.agent.outputs.no_agent_fs",
      {},
    );
    prompt += outputsResult.text;
  }

  // H. Slack. One block for both roles; the scripts-only variant covers Slack
  // via ctx.swarm.slack_* for Slack-originated tasks.
  const slackPromptToolsEnabled = areSlackPromptToolsEnabled();
  if (hasMcp && slackPromptToolsEnabled && !scriptsOnlyMode && serverHasCapability("slack", true)) {
    const slackResult = await resolveTemplateAsync("system.agent.slack", {});
    prompt += slackResult.text;
  }
  if (role !== "lead" && args.slackContext && scriptsOnlyMode && slackPromptToolsEnabled) {
    const slackResult = await resolveTemplateAsync("system.agent.scripts_only_mode.slack", {
      slackChannelId: args.slackContext.channelId,
      slackThreadTs: args.slackContext.threadTs ?? "",
    });
    prompt += slackResult.text;
  }

  if (
    hasMcp &&
    isSteeringEnabled() &&
    steerModes.length > 0 &&
    !scriptsOnlyMode &&
    // steer-task/accept-steer register under the core capability (steering
    // works on directly-assigned tasks, not just the pool).
    serverHasCapability("core", true)
  ) {
    const steeringResult = await resolveTemplateAsync("system.agent.steering", {});
    prompt += steeringResult.text;
  }

  // I. Tools and skills. Skipped without MCP: the discovery tools are MCP tools.
  if (hasMcp) {
    const toolsResult = await resolveTemplateAsync(
      "system.agent.tools_skills",
      renderToolsAndSkillsVars({
        skillsSummary: args.skillsSummary,
        mcpServers: args.mcpServers,
        nativeSkillDiscovery,
        hasLocalEnv,
      }),
    );
    prompt += toolsResult.text;
  }

  // J. Agent notes (CLAUDE.md). Claude loads ~/.claude/CLAUDE.md and
  // /workspace/CLAUDE.md natively; the others get it here, and only when it
  // differs from the generated default.
  if (
    hasLocalEnv &&
    args.claudeMd &&
    CLAUDE_MD_INJECT_PROVIDERS.has(provider) &&
    !matchesDefaultClaudeMd(args.claudeMd, defaultsInput)
  ) {
    const budget = Math.min(
      BOOTSTRAP_MAX_CHARS,
      Math.max(0, BOOTSTRAP_TOTAL_MAX_CHARS - prompt.length),
    );
    prompt += truncateSection(args.claudeMd, "## Your notes (CLAUDE.md)", "CLAUDE.md", budget);
  }

  // K. Repository (per task). Never truncated except the inlined repo CLAUDE.md.
  if (args.repoContext) {
    const repoResult = await resolveTemplateAsync(
      "system.agent.repository",
      renderRepositoryVars(args.repoContext, { hasMcp, hasLocalEnv, provider }),
    );
    prompt += repoResult.text;
  }

  // Blocks start and end with a newline; collapse the seams to one blank line.
  return prompt.replace(/\n{3,}/g, "\n\n");
};

/**
 * Dynamic lines for `system.agent.tools_skills`. The static text lives in the
 * template so operators can override or skip the section; only the lists that
 * depend on the installed skills and MCP servers are built here.
 */
function renderToolsAndSkillsVars(input: {
  skillsSummary?: { name: string; description: string }[];
  mcpServers?: string[];
  nativeSkillDiscovery: boolean;
  hasLocalEnv: boolean;
}): { skills: string; mcp_servers: string } {
  let section = "";

  const skills = input.skillsSummary ?? [];
  if (skills.length > 0) {
    const discovery =
      "`skill-list` browses the catalog, `skill-search` finds one by intent, `skill-get` reads one.";
    if (input.nativeSkillDiscovery) {
      // Claude and pi read their local skills tree and inject name+description
      // natively, so enumerating here is pure duplication that grows linearly
      // with the installed count.
      const count = skills.length;
      const where = input.hasLocalEnv
        ? "Your harness loads them from its skills directory."
        : "This session has no local skills directory, so reach them through the MCP tools.";
      section += `You have ${count} skill${count === 1 ? "" : "s"} installed. ${where} ${discovery} When a skill matches the task, use it before manual work.\n`;
    } else {
      // Codex and opencode have no native skill system; without this list they
      // have zero ambient awareness that any skill exists.
      const howTo = input.hasLocalEnv
        ? "To use one, read its SKILL.md from your skills directory and follow it."
        : "To use one, read it with `skill-get` and follow it.";
      const lines = skills
        .map((s) => `- ${input.hasLocalEnv ? "/" : ""}${s.name}: ${s.description}`)
        .join("\n");
      section += `Installed skills. ${howTo} When a skill matches the task, use it before manual work.\n\n${lines}\n\n${discovery}\n`;
    }
  }

  const servers = (input.mcpServers ?? []).filter((name) => name.trim().length > 0);
  const mcpLine =
    servers.length > 0
      ? `Connected MCP servers: ${servers.join(", ")}. Their tools are in your tool list.\n`
      : "";

  return { skills: section, mcp_servers: mcpLine };
}

/**
 * Dynamic parts of `system.agent.repository`. Same split as the tools section:
 * the heading lives in the template, the per-task pieces are built here.
 */
function renderRepositoryVars(
  repo: NonNullable<BasePromptArgs["repoContext"]>,
  ctx: { hasMcp: boolean; hasLocalEnv: boolean; provider: string },
): Record<string, string> {
  const vars: Record<string, string> = {
    clone_note: "",
    warning: "",
    repo_claude_md: "",
    auto_stashes: "",
    guidelines: "",
    code_quality: "",
  };

  if (ctx.hasLocalEnv) {
    vars.clone_note =
      "This task's repository is cloned locally. `get-repos` returns the path. Its `CLAUDE.md` applies inside that directory.\n";
  }

  if (repo.warning) {
    vars.warning = `\nWARNING: ${repo.warning}\n`;
  }

  if (ctx.hasLocalEnv && repo.claudeMd && REPO_CLAUDE_MD_INLINE_PROVIDERS.has(ctx.provider)) {
    // opencode does not load the repo CLAUDE.md natively (unverified), so it
    // is inlined there, capped so it cannot blow the bootstrap budget on its
    // own (Picateclas argv-E2BIG saga, 2026-05-28).
    vars.repo_claude_md =
      `\nThe repository's CLAUDE.md, cloned at \`${repo.clonePath}\`. It applies only inside that directory.\n\n` +
      `${truncateRepoClaudeMd(repo.claudeMd, repo.clonePath, REPO_CLAUDE_MD_MAX_CHARS)}\n`;
  }

  if (ctx.hasLocalEnv && repo.autoStashes && repo.autoStashes.length > 0) {
    const stashes = repo.autoStashes.map((stash) => `- ${stash.ref}: ${stash.message}`).join("\n");
    vars.auto_stashes = `\nPending auto-stashed work exists in this repo:\n${stashes}\nRestore if relevant with \`git stash apply <ref>\` or \`git stash pop <ref>\`.\n`;
  }

  let section = "";
  const g = repo.guidelines;
  if (g === null || g === undefined) {
    section += `\n### Repository Guidelines\n\nNo repository guidelines are defined. Ask the lead before you push.\n`;
  } else {
    const hasAnyContent =
      g.prChecks.length > 0 || g.mergeChecks.length > 0 || g.review.length > 0 || g.allowMerge;
    if (hasAnyContent) {
      section += `\n### Repository Guidelines (MANDATORY)\n\n`;
      if (g.prChecks.length > 0) {
        section += `**PR Checks. Run ALL before pushing code or creating a PR:**\n`;
        g.prChecks.forEach((check, i) => {
          section += `${i + 1}. \`${check}\`\n`;
        });
        section += `If ANY check fails, fix the issue before pushing. Do NOT push code with failing checks.\nDo NOT use \`--no-verify\` or any flag that bypasses git hooks.\n\n`;
      }
      section += `**Merge Policy:**\n`;
      section += `- Auto-merge: ${g.allowMerge ? "Allowed" : "Not allowed (default)"}\n`;
      if (g.mergeChecks.length > 0) {
        section += `- Before merging, verify:\n`;
        g.mergeChecks.forEach((check) => {
          section += `  - ${check}\n`;
        });
      }
      section += `\n`;
      if (g.review.length > 0) {
        section += `**Review Guidance:**\n`;
        g.review.forEach((item) => {
          section += `- ${item}\n`;
        });
        section += `\n`;
      }
    }
  }

  vars.guidelines = section;

  if (ctx.hasMcp) {
    vars.code_quality = `\nYou MUST use the \`code-quality\` skill before you push, open a PR, or review one.\n`;
  }

  return vars;
}

/**
 * Truncate the repo CLAUDE.md to a hard byte budget so it can't blow the
 * bootstrap argv ceiling on its own (Picateclas spawn-OOM, 2026-05-28).
 *
 * The footer is structured as a `[truncated, see <path>/CLAUDE.md for full
 * content]` notice so anyone reading the system prompt knows exactly where
 * the dropped content lives on disk.
 *
 * Exported only for testing.
 */
export function truncateRepoClaudeMd(content: string, clonePath: string, budget: number): string {
  if (content.length <= budget) return content;
  const notice = `\n\n[...truncated, see ${clonePath}/CLAUDE.md for full content]\n`;
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
  const notice = `\n\n[...truncated, see /workspace/${fileName} for full content]\n`;
  const contentBudget = budget - headerStr.length - notice.length;

  if (contentBudget > 0) {
    return headerStr + content.slice(0, contentBudget) + notice;
  }

  return "";
}
