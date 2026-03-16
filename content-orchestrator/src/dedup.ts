import { ALL_STYLES, COMMON_TOOLS, CONFIG, STYLE_CATEGORIES } from "./config.js";
import type { StateManager } from "./state-manager.js";
import type { DedupContext } from "./types.js";

/**
 * Mechanism 1: Check if workflow is within cooldown period.
 * Returns true if the workflow should be skipped.
 */
export function shouldSkipWorkflow(
  stateManager: StateManager,
  workflowName: string,
): boolean {
  const cooldownHours = CONFIG.COOLDOWNS[workflowName];
  if (!cooldownHours) return false;

  const lastExecution = stateManager.getLastWorkflowExecution(workflowName);
  if (!lastExecution) return false;

  const elapsed = Date.now() - lastExecution.getTime();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  if (elapsed < cooldownMs) {
    const remainingHours = ((cooldownMs - elapsed) / (60 * 60 * 1000)).toFixed(1);
    console.log(
      `[dedup] Workflow "${workflowName}" is within cooldown. ${remainingHours}h remaining.`,
    );
    return true;
  }

  return false;
}

/**
 * Mechanism 2: Build dedup context from content history (90-day window).
 * Injects recent topics, main topics, and keywords for the research prompt.
 */
export function buildDedupContext(
  stateManager: StateManager,
  workflowName: string,
  seriesName: string,
  days: number = 90,
): DedupContext {
  const records = stateManager.getContentHistory(workflowName, seriesName, days);

  const recentTopics: string[] = [];
  const recentMainTopics: string[] = [];
  const keywordsSet = new Set<string>();

  for (const record of records.slice(0, 20)) {
    if (record.topic) recentTopics.push(record.topic);
    if (record.mainTopic) {
      const normalized = normalizeMainTopic(record.mainTopic);
      if (!recentMainTopics.includes(normalized)) {
        recentMainTopics.push(normalized);
      }
    }
    if (record.keywords) {
      try {
        const kws: string[] = JSON.parse(record.keywords);
        for (const kw of kws) keywordsSet.add(kw);
      } catch {
        // keywords stored as comma-separated string fallback
        record.keywords.split(",").forEach((k) => keywordsSet.add(k.trim()));
      }
    }
  }

  const ctx: DedupContext = {
    recentTopics,
    recentMainTopics,
    recentKeywords: [...keywordsSet].slice(0, 50),
    topicsCount: records.length,
  };

  // Mechanism 6: Tool frequency analysis for Level Up series
  if (seriesName === "Level Up") {
    ctx.toolFrequency = analyzeToolFrequency(recentMainTopics);
  }

  return ctx;
}

/**
 * Mechanism 5: Normalize main topic by stripping common prefixes and suffixes.
 * Catches variations like "From Bolt.new to Cursor" vs "Bolt.new to Cursor Migration".
 */
export function normalizeMainTopic(topic: string): string {
  let normalized = topic;

  // Strip prefixes (case-insensitive)
  normalized = normalized.replace(
    /^(From\s+|Migrating\s+from\s+|Moving\s+from\s+|Transitioning\s+from\s+)/i,
    "",
  );

  // Strip suffixes
  normalized = normalized.replace(/\s+(Migration|Guide|Tutorial)$/i, "");

  return normalized.trim();
}

/**
 * Mechanism 6: Analyze tool frequency in Level Up migration topics.
 * Returns tool name -> count map. Tools with >=5 uses are over-represented.
 */
export function analyzeToolFrequency(
  mainTopics: string[],
): Record<string, number> {
  const toolCounts: Record<string, number> = {};
  const migrationPattern = /^([A-Za-z0-9.]+)(?:\s+to\s+|\s+→\s+)/;

  for (const topic of mainTopics) {
    // Try regex first
    const match = topic.match(migrationPattern);
    if (match?.[1]) {
      const tool = match[1].toLowerCase();
      toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      continue;
    }

    // Fallback: scan for known tool names
    const lower = topic.toLowerCase();
    for (const tool of COMMON_TOOLS) {
      if (lower.includes(tool)) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
        break;
      }
    }
  }

  return toolCounts;
}

/**
 * Mechanism 7: Suggest the least-used image style category for variety.
 */
export function suggestStyleCategory(
  stateManager: StateManager,
  seriesName: string,
  excludeRecentDays: number = 7,
): string {
  // Get styles used recently for this series
  const recentPrompts = stateManager.getRecentImagePrompts(
    seriesName,
    excludeRecentDays,
  );
  const recentlyUsed = new Set(recentPrompts.map((p) => p.styleCategory));

  // Get usage counts for all styles
  const usageCounts = stateManager.getStyleUsageCounts(30);

  // Find least-used style that wasn't used recently
  const available = ALL_STYLES.filter((s) => !recentlyUsed.has(s)).sort(
    (a, b) => (usageCounts[a] ?? 0) - (usageCounts[b] ?? 0),
  );

  if (available.length > 0) return available[0]!;

  // Fallback: just return least-used overall
  const sorted = [...ALL_STYLES].sort(
    (a, b) => (usageCounts[a] ?? 0) - (usageCounts[b] ?? 0),
  );
  return sorted[0] ?? "comparison_memes";
}

/**
 * Mechanism 7 (cont): Build formatted text of recent image prompts for context injection.
 */
export function getRecentPromptsText(
  stateManager: StateManager,
  seriesName: string,
  days: number = 10,
): string {
  const prompts = stateManager.getRecentImagePrompts(seriesName, days);

  if (prompts.length === 0) return "No recent meme prompts found.";

  // Count template frequency (extract template name from prompt)
  const templateCounts: Record<string, number> = {};
  for (const p of prompts) {
    const template = p.prompt.split(":")[0]?.trim().toLowerCase() ?? "unknown";
    templateCounts[template] = (templateCounts[template] ?? 0) + 1;
  }

  const lines: string[] = [];

  // Forbidden templates (used 2+ times)
  const forbidden = Object.entries(templateCounts).filter(([, c]) => c >= 2);
  if (forbidden.length > 0) {
    lines.push("## FORBIDDEN TEMPLATES (DO NOT USE - Over-represented)");
    for (const [tmpl, count] of forbidden) {
      lines.push(`- **${tmpl}** (${count} uses in last ${days} days)`);
    }
    lines.push("");
  }

  // Recent history
  lines.push("## Recent Meme History (avoid similar themes):");
  for (const p of prompts.slice(0, 10)) {
    const truncated =
      p.prompt.length > 100 ? `${p.prompt.slice(0, 100)}...` : p.prompt;
    lines.push(
      `- [${p.generationDate}] ${p.series} (${p.styleCategory}): ${truncated}`,
    );
  }

  return lines.join("\n");
}

/**
 * Mechanism 8: Select posts for refresh (>30 days since creation/last refresh).
 */
export function selectPostsForRefresh(
  stateManager: StateManager,
  maxCount: number = 5,
  maxAgeDays: number = 30,
) {
  return stateManager.getRefreshCandidates(maxAgeDays, maxCount);
}

/**
 * Format dedup context as text for injection into task description.
 */
export function formatDedupContextForPrompt(ctx: DedupContext): string {
  const lines: string[] = [];

  if (ctx.recentTopics.length > 0) {
    lines.push("## Recently Covered Topics (AVOID DUPLICATES)");
    for (const topic of ctx.recentTopics) {
      lines.push(`- ${topic}`);
    }
    lines.push("");
  }

  if (ctx.recentMainTopics.length > 0) {
    lines.push("## Main Topics Already Covered (DO NOT REPEAT)");
    for (const mt of ctx.recentMainTopics) {
      lines.push(`- ${mt}`);
    }
    lines.push("");
  }

  if (ctx.recentKeywords.length > 0) {
    lines.push("## Recently Used Keywords");
    lines.push(ctx.recentKeywords.join(", "));
    lines.push("");
  }

  if (ctx.toolFrequency) {
    const overRepresented = Object.entries(ctx.toolFrequency).filter(
      ([, count]) => count >= 5,
    );
    if (overRepresented.length > 0) {
      lines.push("## Over-Represented Tools (AVOID)");
      for (const [tool, count] of overRepresented) {
        lines.push(`- ${tool}: ${count} posts (over-represented, skip)`);
      }
      lines.push("");
    }
  }

  lines.push(`Total posts in last 90 days: ${ctx.topicsCount}`);
  return lines.join("\n");
}
