/**
 * Learnings captured through `store-progress`: one swarm-scope `manual` memory
 * per learning, keyed `/learnings/<workstream>/<slug>` and tied to its task by
 * `sourceTaskId`, so "what did we learn doing X" is one `keyPrefix` search.
 *
 * Source stays `manual` so nightly curation (memtax B1 reads only manual and
 * file_index rows) picks learnings up without a new source value.
 *
 * A learning close to an existing swarm memory (raw cosine at or above
 * LEARNING_DUPLICATE_MIN_SIMILARITY) is not stored: the existing row gets a
 * positive rating instead. Known gap: embeddings are written in the background,
 * so two near-identical learnings seconds apart can both pass the check.
 * Nightly curation catches those.
 */
import { getDbClient } from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { LEARNING_DUPLICATE_MIN_SIMILARITY } from "@/be/memory/constants";
import { indexMemoryContent } from "@/be/memory/index-content";
import { applyRating } from "@/be/memory/raters/store";
import { contentSha256 } from "@/commands/profile-sync";
import type { AgentTask } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";

/** ~500 tokens at ceil(chars / 4); also keeps a learning to one memory chunk. */
export const LEARNING_MAX_CHARS = 2000;
export const LEARNING_MAX_TAGS = 5;
const LEARNINGS_ROOT = "/learnings";
const SEGMENT_MAX_CHARS = 60;
const KEY_ATTEMPTS = 4;
/** Where a near duplicate can already live: any workstream's learnings and the workstream digests. */
const DUPLICATE_SEARCH_PREFIXES = [`${LEARNINGS_ROOT}/`, "/longterm/workstreams/"];
/** memory_rating.source for the positive rating a duplicate gives the existing row. */
export const LEARNING_DUPLICATE_RATING_SOURCE = "learning-duplicate";

export type TaskLearningInput = string | { text: string; workstream?: string; tags?: string[] };

export type TaskLearningResult =
  | { status: "stored"; memoryId: string; key: string; workstream: string }
  | { status: "replayed"; memoryId: string; key: string }
  | { status: "duplicate"; memoryId: string; key: string; similarity: number }
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
  // Scrub before anything is derived: a token in the title, workstream or a tag
  // would otherwise survive (kebab-cased) in the key and tags, and the replay
  // hash must match the hash of the scrubbed content the store persists.
  const text = scrubSecrets(input.text).trim();
  if (!text) return { status: "failed", error: "learning text is empty" };
  if (text.length > LEARNING_MAX_CHARS) {
    return {
      status: "failed",
      error: `learning text is over ~500 tokens (${LEARNING_MAX_CHARS} characters); shorten it`,
    };
  }
  const tags = [
    ...new Set((input.tags ?? []).map((tag) => toKebab(scrubSecrets(tag))).filter(Boolean)),
  ].filter((tag) => tag !== "learning");
  if (tags.length > LEARNING_MAX_TAGS) {
    return { status: "failed", error: `learning takes at most ${LEARNING_MAX_TAGS} tags` };
  }

  const workstream = resolveLearningWorkstream(
    input.workstream === undefined ? undefined : scrubSecrets(input.workstream),
    task.vcsRepo === undefined ? undefined : scrubSecrets(task.vcsRepo),
  );

  try {
    // Replay first: the same text on the same task is a retry, not a duplicate.
    const replay = await findReplay(task.id, contentSha256(text));
    if (replay) return replay;
    // Outside the write transaction: the embedding call goes over the network.
    const duplicate = await findNearDuplicate({ agentId, isLead, text });
    if (duplicate) {
      await rateDuplicate(duplicate, task.id);
      return duplicate;
    }
    // One write transaction for the replay check and the insert, so two
    // overlapping calls with the same learning store it once.
    return await getDbClient().transaction(() =>
      insertLearning({ agentId, isLead, taskId: task.id, text, tags, workstream }),
    );
  } catch (err) {
    return {
      status: "failed",
      error: scrubSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function findReplay(
  taskId: string,
  contentHash: string,
): Promise<Extract<TaskLearningResult, { status: "replayed" }> | null> {
  const replay = await getDbClient().get<{ id: string; key: string }>(
    `SELECT id, key FROM agent_memory
     WHERE sourceTaskId = ? AND contentHash = ? AND key LIKE '${LEARNINGS_ROOT}/%'
     LIMIT 1`,
    [taskId, contentHash],
  );
  return replay ? { status: "replayed", memoryId: replay.id, key: replay.key } : null;
}

/**
 * The closest swarm memory under the duplicate prefixes when its raw cosine to
 * the learning reaches the threshold. No `queryText`, so the store takes the
 * vector or brute-force path and `similarity` is raw cosine, not an FTS rank or
 * a fused score. Any failure (no embedding provider, a search error) returns
 * null so the learning is stored as usual.
 */
async function findNearDuplicate(params: {
  agentId: string;
  isLead: boolean;
  text: string;
}): Promise<Extract<TaskLearningResult, { status: "duplicate" }> | null> {
  try {
    const embedding = await getEmbeddingProvider().embed(params.text);
    if (!embedding) return null;
    const store = getMemoryStore();
    const results = await Promise.all(
      DUPLICATE_SEARCH_PREFIXES.map((keyPrefix) =>
        store.search(embedding, params.agentId, {
          scope: "swarm",
          isLead: params.isLead,
          keyPrefix,
          limit: 1,
        }),
      ),
    );
    const best = results
      .flat()
      .filter((candidate) => candidate.key)
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (!best || best.similarity < LEARNING_DUPLICATE_MIN_SIMILARITY) return null;
    return {
      status: "duplicate",
      memoryId: best.id,
      key: best.key!,
      similarity: Math.round(best.similarity * 1000) / 1000,
    };
  } catch (err) {
    console.warn(
      "[task-learning] near-duplicate check failed; storing the learning:",
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/** A repeated lesson is evidence the existing row is useful. A failed rating never fails the call. */
async function rateDuplicate(
  duplicate: Extract<TaskLearningResult, { status: "duplicate" }>,
  taskId: string,
): Promise<void> {
  try {
    await applyRating(
      [
        {
          memoryId: duplicate.memoryId,
          signal: 1,
          weight: 1,
          source: LEARNING_DUPLICATE_RATING_SOURCE,
          reasoning: `store-progress learning matched at cosine ${duplicate.similarity}`,
        },
      ],
      { taskId },
    );
  } catch (err) {
    console.warn(
      "[task-learning] duplicate rating failed:",
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    );
  }
}

async function insertLearning(params: {
  agentId: string;
  isLead: boolean;
  taskId: string;
  text: string;
  tags: string[];
  workstream: string;
}): Promise<TaskLearningResult> {
  const { agentId, isLead, taskId, text, tags, workstream } = params;
  // indexMemoryContent stores text this short as one trimmed chunk, so this
  // hash is the row's contentHash: a replayed call finds its own earlier write.
  const replay = await findReplay(taskId, contentSha256(text));
  if (replay) return replay;

  const title = text.split(/\r?\n/, 1)[0]!.trim().slice(0, 200);
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
        sourceTaskId: taskId,
        tags: ["learning", ...tags],
        intent: "store-progress learning",
        key,
        writer: { principal: { kind: "agent", agentId, isLead }, source: "mcp" },
      });
      return { status: "stored", memoryId: result.memoryIds[0]!, key, workstream };
    } catch (err) {
      // The key is taken after all: try a suffixed one.
      if (/UNIQUE constraint failed/i.test((err as Error).message)) continue;
      throw err;
    }
  }
  return { status: "failed", error: `no free key under ${baseKey}` };
}
