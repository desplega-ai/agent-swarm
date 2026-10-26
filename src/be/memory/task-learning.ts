/**
 * Learnings captured through `store-progress`: one swarm-scope `manual` memory
 * per learning, keyed `/learnings/<workstream>/<slug>` and tied to its task by
 * `sourceTaskId`, so "what did we learn doing X" is one `keyPrefix` search.
 *
 * Source stays `manual` so nightly curation (memtax B1 reads only manual and
 * file_index rows) picks learnings up without a new source value.
 */
import { getDbClient } from "@/be/db";
import { indexMemoryContent } from "@/be/memory/index-content";
import { contentSha256 } from "@/commands/profile-sync";
import type { AgentTask } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";

/** ~500 tokens at ceil(chars / 4); also keeps a learning to one memory chunk. */
export const LEARNING_MAX_CHARS = 2000;
export const LEARNING_MAX_TAGS = 5;
const LEARNINGS_ROOT = "/learnings";
const SEGMENT_MAX_CHARS = 60;
const KEY_ATTEMPTS = 4;

export type TaskLearningInput = string | { text: string; workstream?: string; tags?: string[] };

export type TaskLearningResult =
  | { status: "stored"; memoryId: string; key: string; workstream: string }
  | { status: "replayed"; memoryId: string; key: string }
  | { status: "failed"; error: string };

/** Lowercase kebab slug: `Agent Swarm!` -> `agent-swarm`. Empty when nothing usable is left. */
export function toKebab(value: string, maxChars = SEGMENT_MAX_CHARS): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, maxChars)
    .replace(/-+$/, "");
}

/** Explicit workstream, else the repo name from `vcsRepo` (`owner/name` or a URL), else `general`. */
export function resolveLearningWorkstream(
  explicit: string | undefined,
  vcsRepo: string | undefined,
): string {
  const fromExplicit = explicit ? toKebab(explicit) : "";
  if (fromExplicit) return fromExplicit;
  const repoName = vcsRepo
    ?.trim()
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.replace(/\.git$/, "");
  const fromRepo = repoName ? toKebab(repoName) : "";
  return fromRepo || "general";
}

export async function storeTaskLearning(params: {
  agentId: string;
  isLead: boolean;
  task: Pick<AgentTask, "id" | "vcsRepo">;
  learning: TaskLearningInput;
}): Promise<TaskLearningResult> {
  const { agentId, isLead, task } = params;
  const input = typeof params.learning === "string" ? { text: params.learning } : params.learning;
  const text = input.text.trim();
  if (!text) return { status: "failed", error: "learning text is empty" };
  if (text.length > LEARNING_MAX_CHARS) {
    return {
      status: "failed",
      error: `learning text is over ~500 tokens (${LEARNING_MAX_CHARS} characters); shorten it`,
    };
  }
  const tags = [...new Set((input.tags ?? []).map((tag) => toKebab(tag)).filter(Boolean))].filter(
    (tag) => tag !== "learning",
  );
  if (tags.length > LEARNING_MAX_TAGS) {
    return { status: "failed", error: `learning takes at most ${LEARNING_MAX_TAGS} tags` };
  }

  try {
    // indexMemoryContent stores text this short as one trimmed chunk, so this
    // hash is the row's contentHash: a replayed call finds its own earlier write.
    const contentHash = contentSha256(text);
    const replay = await getDbClient().get<{ id: string; key: string }>(
      `SELECT id, key FROM agent_memory
       WHERE sourceTaskId = ? AND contentHash = ? AND key LIKE '${LEARNINGS_ROOT}/%'
       LIMIT 1`,
      [task.id, contentHash],
    );
    if (replay) return { status: "replayed", memoryId: replay.id, key: replay.key };

    const title = text.split(/\r?\n/, 1)[0]!.trim().slice(0, 200);
    const workstream = resolveLearningWorkstream(input.workstream, task.vcsRepo);
    const baseKey = `${LEARNINGS_ROOT}/${workstream}/${toKebab(title) || "learning"}`;

    // Keys are unique per owner and a reused key fails rather than upserts.
    // Keep the path unique across the swarm: on a taken key, add a short suffix.
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
      const key = attempt === 0 ? baseKey : `${baseKey}-${crypto.randomUUID().slice(0, 6)}`;
      const taken = await getDbClient().get<{ id: string }>(
        "SELECT id FROM agent_memory WHERE scope = 'swarm' AND key = ? LIMIT 1",
        [key],
      );
      if (taken) continue;
      try {
        const result = await indexMemoryContent({
          agentId,
          content: text,
          name: title,
          scope: "swarm",
          source: "manual",
          sourceTaskId: task.id,
          tags: ["learning", ...tags],
          intent: "store-progress learning",
          key,
          writer: { principal: { kind: "agent", agentId, isLead }, source: "mcp" },
        });
        return { status: "stored", memoryId: result.memoryIds[0]!, key, workstream };
      } catch (err) {
        // Lost a race for the same key: try a suffixed one.
        if (/UNIQUE constraint failed/i.test((err as Error).message)) continue;
        throw err;
      }
    }
    return { status: "failed", error: `no free key under ${baseKey}` };
  } catch (err) {
    return {
      status: "failed",
      error: scrubSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}
