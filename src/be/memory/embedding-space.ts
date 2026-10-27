/**
 * Re-embed every stored vector when the embedding space changes.
 *
 * A vector only compares with vectors from the same space: the same endpoint,
 * model, dimensions and document prefix (see `EmbeddingSpace`). When an
 * operator switches any of them (for example, from the bundled TEI model to
 * OpenAI), new rows and queries use the new space while old rows keep the old
 * one, and vector search ranks across both with no error. The NULL /
 * wrong-length backfill in boot-reembed.ts cannot see this: an old 512d vector
 * looks valid.
 *
 * State lives in `seed_state` (kind 'maintenance'), so no migration:
 *   - `embedding-space`: fingerprint of the space the stored vectors use.
 *   - `embedding-space:target`: fingerprint a re-embed is moving to. Written
 *     before the first embed call, so it also records that the server ran in
 *     that space and may have written rows in it.
 *   - `embedding-space:memory:cursor` / `embedding-space:scripts:cursor`: the
 *     last id re-embedded, so a restart resumes after it.
 *
 * Rules, on boot and after each config reload:
 *   - No stored fingerprint (first boot after deploy): adopt the current one,
 *     re-embed nothing.
 *   - Stored equals current and no target: nothing to do.
 *   - Otherwise, re-embed toward current: resume when the target already is
 *     current, else restart from the first row. A config that flips back
 *     mid-run also restarts, because rows may already be in the other space.
 *   - The stored fingerprint moves to current only once both tables finish.
 *
 * Search keeps working meanwhile: each row keeps its old vector until its new
 * one lands. When the endpoint stops answering, the run stops with the cursor
 * saved; the next boot, reload or recovered embedding call resumes it. A row
 * the endpoint rejects while others embed loses its vector (it is in the old
 * space) and the NULL backfill, which runs after every finished re-embed,
 * retries it.
 *
 * A full re-embed sends every stored document to the endpoint. So an endpoint
 * URL (`EMBEDDING_API_BASE_URL`, else the SDK's `OPENAI_BASE_URL` fallback)
 * stored through `/api/config` must pass the same SSRF check as the /setup
 * probe; only the deployment environment's own value may be private (the
 * bundled TEI at http://tei:80/v1). A blocked URL changes nothing, and
 * `runEmbeddingMaintenance` then sends no request at all: no probe, no
 * re-embed, no backfill.
 *
 * Logs counts and a short fingerprint prefix only, never content.
 */

import { createHash } from "node:crypto";
import { getDbClient } from "@/be/db";
import { assertUrlSafe, publicEndpointSsrfOptions } from "@/oauth/mcp-wrapper";
import { getEmbeddingProvider, getMemoryStore } from "./index";
import type { EmbeddingProvider } from "./types";

export const EMBEDDING_SPACE_KEY = "embedding-space";
export const EMBEDDING_SPACE_TARGET_KEY = "embedding-space:target";
export const embeddingSpaceCursorKey = (table: "memory" | "scripts") =>
  `embedding-space:${table}:cursor`;

/** Bump to force one re-embed of every install, after a fix to how documents embed. */
const FINGERPRINT_VERSION = 1;
const DEFAULT_BATCH_SIZE = 20;
const LOG_EVERY_BATCHES = 10;
const TAG = "[embedding-space]";

const yieldTick = () => new Promise<void>((r) => setTimeout(r, 5));

/** Null when the provider does not describe its space (test fakes). */
export function embeddingSpaceFingerprint(provider: EmbeddingProvider): string | null {
  const space = provider.space?.();
  if (!space) return null;
  const canonical = JSON.stringify({
    v: FINGERPRINT_VERSION,
    baseUrl: space.baseUrl,
    model: space.model,
    dimensions: space.dimensions,
    documentPrefix: space.documentPrefix,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export type EmbeddingSpaceResult =
  | "not-configured"
  | "untracked"
  | "adopted"
  | "unchanged"
  | "reembedded"
  | "interrupted"
  | "blocked";

export type EmbeddingSpaceOptions = {
  batchSize?: number;
  /** Test hook, called after each committed batch. A throw stops the run, cursor saved. */
  afterBatch?: (info: { table: "memory" | "scripts"; ids: string[] }) => void | Promise<void>;
};

/**
 * Reads a key's deployment environment value, without stored config. Set by
 * the HTTP server at boot (http/core owns the env injection). Unset, no URL
 * counts as operator config, so every one gets the SSRF check.
 */
let readDeploymentEnv: (key: string) => string | undefined = () => undefined;

export function setDeploymentEnvReader(read: (key: string) => string | undefined): void {
  readDeploymentEnv = read;
}

/** Checks the URL the provider sends to, in the SDK's precedence order. */
function endpointAllowed(): boolean {
  const key = process.env.EMBEDDING_API_BASE_URL
    ? "EMBEDDING_API_BASE_URL"
    : process.env.OPENAI_BASE_URL
      ? "OPENAI_BASE_URL"
      : null;
  if (!key) return true;
  const baseUrl = process.env[key] ?? "";
  if (baseUrl === readDeploymentEnv(key)) return true;
  try {
    assertUrlSafe(baseUrl, publicEndpointSsrfOptions());
    return true;
  } catch {
    return false;
  }
}

async function readState(key: string): Promise<string | null> {
  const row = await getDbClient().get<{ seededHash: string }>(
    "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
    [key],
  );
  return row?.seededHash ?? null;
}

async function writeState(key: string, value: string): Promise<void> {
  await getDbClient().run(
    `INSERT INTO seed_state (kind, key, seededHash, seededAt)
     VALUES ('maintenance', ?, ?, datetime('now'))
     ON CONFLICT (kind, key) DO UPDATE SET seededHash = excluded.seededHash, seededAt = datetime('now')`,
    [key, value],
  );
}

async function deleteCursors(): Promise<void> {
  await getDbClient().run("DELETE FROM seed_state WHERE kind = 'maintenance' AND key IN (?, ?)", [
    embeddingSpaceCursorKey("memory"),
    embeddingSpaceCursorKey("scripts"),
  ]);
}

const short = (fingerprint: string | null) => (fingerprint ? fingerprint.slice(0, 12) : "none");

/** One failed embed: is the endpoint down (stop), or did it reject this input (skip)? */
async function endpointWorks(provider: EmbeddingProvider): Promise<boolean> {
  try {
    return !!(await provider.embed("test"));
  } catch {
    return false;
  }
}

type Counts = { done: number; failed: number };

/** Re-embed agent_memory after the cursor. False when the endpoint stopped answering. */
async function reembedMemory(
  provider: EmbeddingProvider,
  counts: Counts,
  opts: EmbeddingSpaceOptions,
): Promise<boolean> {
  const client = getDbClient();
  const store = getMemoryStore();
  const cursorKey = embeddingSpaceCursorKey("memory");
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let cursor = (await readState(cursorKey)) ?? "";
  let batches = 0;

  for (;;) {
    const rows = await client.query<{ id: string; content: string }>(
      "SELECT id, content FROM agent_memory WHERE id > ? ORDER BY id ASC LIMIT ?",
      [cursor, batchSize],
    );
    if (rows.length === 0) return true;
    // A config reload built a new provider: the run it queued takes over.
    if (getEmbeddingProvider() !== provider) return false;

    // Embed outside the write lock.
    let vectors: (Float32Array | null)[];
    try {
      vectors = await provider.embedBatch(
        rows.map((r) => r.content),
        { kind: "document" },
      );
    } catch {
      vectors = rows.map(() => null);
    }
    // Down endpoint: commit nothing, so the resume redoes the whole batch.
    if (vectors.some((v) => !v) && !(await endpointWorks(provider))) return false;

    const lastId = rows[rows.length - 1]!.id;
    await client.transaction(async () => {
      for (let i = 0; i < rows.length; i++) {
        const vector = vectors[i];
        if (vector) {
          await store.updateEmbedding(rows[i]!.id, vector, provider.name);
          counts.done++;
        } else {
          await store.clearEmbedding(rows[i]!.id);
          counts.failed++;
        }
      }
      await writeState(cursorKey, lastId);
    });
    cursor = lastId;

    if (++batches % LOG_EVERY_BATCHES === 0) {
      console.log(`${TAG} memory progress: done=${counts.done} failed=${counts.failed}`);
    }
    await opts.afterBatch?.({ table: "memory", ids: rows.map((r) => r.id) });
    await yieldTick();
  }
}

/** Re-embed non-scratch scripts after the cursor. False when the endpoint stopped answering. */
async function reembedScripts(
  memoryProvider: EmbeddingProvider,
  counts: Counts,
  opts: EmbeddingSpaceOptions,
): Promise<boolean> {
  const { computeScriptEmbedding, embeddingProvider, writeScriptEmbedding } = await import(
    "../scripts/embeddings"
  );
  const { toScriptRecord } = await import("../scripts/boot-reembed");
  type ScriptRow = import("../scripts/boot-reembed").ScriptRow;
  type ScriptEmbedding = import("../scripts/embeddings").ScriptEmbedding;

  const client = getDbClient();
  const provider = embeddingProvider();
  const cursorKey = embeddingSpaceCursorKey("scripts");
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let cursor = (await readState(cursorKey)) ?? "";

  for (;;) {
    const rows = await client.query<ScriptRow>(
      "SELECT * FROM scripts WHERE isScratch = 0 AND id > ? ORDER BY id ASC LIMIT ?",
      [cursor, batchSize],
    );
    if (rows.length === 0) return true;
    if (getEmbeddingProvider() !== memoryProvider) return false;

    // Embed outside the write lock.
    const embedded: { id: string; result: ScriptEmbedding | null }[] = [];
    for (const row of rows) {
      let result: ScriptEmbedding | null = null;
      try {
        result = await computeScriptEmbedding(toScriptRecord(row));
      } catch {
        result = null;
      }
      embedded.push({ id: row.id, result });
    }
    // Down endpoint: commit nothing, so the resume redoes the whole batch.
    if (embedded.some((e) => !e.result) && !(await endpointWorks(provider))) return false;

    // Vectors and cursor commit together, so a crash never leaves a new
    // vector behind a cursor that still points before it.
    const lastId = rows[rows.length - 1]!.id;
    await client.transaction(async () => {
      for (const { id, result } of embedded) {
        if (result) {
          await writeScriptEmbedding(id, result);
          counts.done++;
        } else {
          // Rejected input: its old vector is in the old space. The missing-
          // embedding backfill retries it.
          await client.run("DELETE FROM script_embeddings WHERE scriptId = ?", [id]);
          counts.failed++;
        }
      }
      await writeState(cursorKey, lastId);
    });
    cursor = lastId;

    await opts.afterBatch?.({ table: "scripts", ids: rows.map((r) => r.id) });
    await yieldTick();
  }
}

/**
 * Compare the current space with the stored one and re-embed when they
 * differ. Safe to call often: with nothing to do it costs two SELECTs.
 */
export async function reconcileEmbeddingSpace(
  opts: EmbeddingSpaceOptions = {},
): Promise<EmbeddingSpaceResult> {
  const provider = getEmbeddingProvider();
  // No key, no vectors written: leave the record for when one is set.
  if (!provider.isConfigured()) return "not-configured";
  const current = embeddingSpaceFingerprint(provider);
  if (!current) return "untracked";

  const stored = await readState(EMBEDDING_SPACE_KEY);
  const target = await readState(EMBEDDING_SPACE_TARGET_KEY);

  if (stored === null && target === null) {
    await writeState(EMBEDDING_SPACE_KEY, current);
    console.log(`${TAG} adopted current space ${short(current)} (no re-embed)`);
    return "adopted";
  }
  if (stored === current && target === null) return "unchanged";

  if (!endpointAllowed()) {
    console.warn(
      `${TAG} re-embed to ${short(current)} blocked: the stored embedding base URL is not an allowed endpoint`,
    );
    return "blocked";
  }

  if (target !== current) {
    await getDbClient().transaction(async () => {
      await writeState(EMBEDDING_SPACE_TARGET_KEY, current);
      await deleteCursors();
    });
    console.log(
      `${TAG} re-embedding all memories and scripts into ${short(current)} (stored ${short(stored)}, previous target ${short(target)})`,
    );
  } else {
    console.log(`${TAG} resuming re-embed to ${short(current)}`);
  }

  // A provider that cannot answer changes nothing; the next trigger retries.
  if (!(await endpointWorks(provider))) {
    console.warn(`${TAG} re-embed to ${short(current)} paused: embedding endpoint not answering`);
    return "interrupted";
  }

  const memory: Counts = { done: 0, failed: 0 };
  const scripts: Counts = { done: 0, failed: 0 };
  const finished =
    (await reembedMemory(provider, memory, opts)) &&
    (await reembedScripts(provider, scripts, opts));
  if (!finished) {
    console.warn(
      `${TAG} re-embed to ${short(current)} paused (endpoint down or config reloaded): memory done=${memory.done} failed=${memory.failed} scripts done=${scripts.done} failed=${scripts.failed}`,
    );
    return "interrupted";
  }

  await getDbClient().transaction(async () => {
    await writeState(EMBEDDING_SPACE_KEY, current);
    await getDbClient().run("DELETE FROM seed_state WHERE kind = 'maintenance' AND key = ?", [
      EMBEDDING_SPACE_TARGET_KEY,
    ]);
    await deleteCursors();
  });
  console.log(
    `${TAG} re-embed to ${short(current)} complete: memory done=${memory.done} failed=${memory.failed} scripts done=${scripts.done} failed=${scripts.failed}`,
  );
  return "reembedded";
}

/** The queued run that has not started yet; a new call joins it. */
let queued: Promise<void> | null = null;
let queuedBackfill = false;
let tail: Promise<void> = Promise.resolve();

/**
 * Space check, then the NULL / wrong-length backfills for memories and
 * scripts (with `backfill`, or after a finished re-embed). Nothing runs when
 * the endpoint URL fails the SSRF check. Runs one at a time, so boot, a
 * config reload and an embedding recovery never re-embed the same rows twice
 * in parallel. A call made while one waits joins it.
 */
export function runEmbeddingMaintenance(opts: { backfill?: boolean } = {}): Promise<void> {
  queuedBackfill ||= opts.backfill ?? true;
  if (queued) return queued;
  const run = tail.then(async () => {
    const backfill = queuedBackfill;
    queued = null;
    queuedBackfill = false;
    // Every request below (probe, re-embed, both backfills) goes to this URL.
    if (!endpointAllowed()) {
      console.warn(
        `${TAG} maintenance skipped: the stored embedding base URL is not an allowed endpoint`,
      );
      return;
    }
    let result: EmbeddingSpaceResult | null = null;
    try {
      result = await reconcileEmbeddingSpace();
    } catch (err) {
      console.error(`${TAG} space check failed (non-fatal):`, (err as Error).message);
    }
    // A finished re-embed may have cleared rows the endpoint rejected: retry them now.
    if (!backfill && result !== "reembedded") return;
    await Promise.all([
      import("./boot-reembed")
        .then(({ runBootReembed }) => runBootReembed())
        .catch((err) => {
          console.error("[boot-reembed] memory backfill failed (non-fatal):", err);
        }),
      import("../scripts/boot-reembed")
        .then(({ runBootReembedScripts }) => runBootReembedScripts())
        .catch((err) => {
          console.error("[boot-reembed-scripts] script backfill failed (non-fatal):", err);
        }),
    ]);
  });
  queued = run;
  tail = run.catch(() => {});
  return run;
}
