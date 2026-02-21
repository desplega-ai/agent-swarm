import { findRecentSimilarTasks } from "@/be/db";
import type { AgentTask } from "@/types";

/**
 * Jaccard similarity on word sets.
 * Tokenizes both strings into lowercase word sets and computes |intersection| / |union|.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 0),
    );

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

/** Similarity above which any two task descriptions are considered duplicates */
const HIGH_SIMILARITY_THRESHOLD = 0.8;
/** Lower threshold used when the tasks also target the same agent */
const SAME_AGENT_SIMILARITY_THRESHOLD = 0.6;

export interface DedupMatch {
  task: AgentTask;
  reason: string;
}

/**
 * Check for duplicate tasks created recently.
 * Returns the first matching duplicate, or null if none found.
 */
export function findDuplicateTask(opts: {
  taskDescription: string;
  creatorAgentId: string;
  targetAgentId?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  windowMinutes?: number;
}): DedupMatch | null {
  const recentTasks = findRecentSimilarTasks({
    creatorAgentId: opts.creatorAgentId,
    windowMinutes: opts.windowMinutes ?? 10,
  });

  for (const existing of recentTasks) {
    // 1. Exact Slack thread match — definitely a duplicate
    if (
      opts.slackChannelId &&
      opts.slackThreadTs &&
      existing.slackChannelId === opts.slackChannelId &&
      existing.slackThreadTs === opts.slackThreadTs
    ) {
      return {
        task: existing,
        reason: `same Slack thread (${opts.slackChannelId}/${opts.slackThreadTs})`,
      };
    }

    const similarity = jaccardSimilarity(existing.task, opts.taskDescription);

    // 2. Very similar task description — likely duplicate regardless of target
    if (similarity > HIGH_SIMILARITY_THRESHOLD) {
      return {
        task: existing,
        reason: `similar task description (${(similarity * 100).toFixed(0)}% match)`,
      };
    }

    // 3. Same target agent + moderately similar task — lower threshold
    if (opts.targetAgentId && existing.agentId === opts.targetAgentId && similarity > SAME_AGENT_SIMILARITY_THRESHOLD) {
      return {
        task: existing,
        reason: `similar task to same agent (${(similarity * 100).toFixed(0)}% match)`,
      };
    }
  }

  return null;
}
