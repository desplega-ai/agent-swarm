import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import type { EmbeddingProvider } from "../be/memory/types";
import { getScript, upsertScriptByName } from "../be/scripts/db";
import {
  reembedAllScripts,
  searchScripts,
  setScriptEmbeddingProviderForTests,
} from "../be/scripts/embeddings";
import { runScriptsMaintenanceCommand } from "../be/scripts/maintenance";

const TEST_DB_PATH = "./test-scripts-embeddings.sqlite";

const signatureJson = JSON.stringify({
  argsType: "{ value: string }",
  resultType: "Promise<{ ok: boolean }>",
  description: "",
});

async function clearDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

function source(label: string) {
  return `export default async () => ({ label: ${JSON.stringify(label)} });`;
}

function embeddingFor(text: string): Float32Array {
  const lower = text.toLowerCase();
  if (lower.includes("exact-name")) return new Float32Array([0.1, 0.995, 0, 0, 0]);

  const vector = [0, 0, 0, 0, 0];
  if (/(linear|issue|ticket|triage)/.test(lower)) vector[0] += 1;
  if (/(github|pull request|\bpr\b|review|comments?)/.test(lower)) vector[1] += 1;
  if (/(memory|recall|remember|search)/.test(lower)) vector[2] += 1;
  if (/(slack|message|channel)/.test(lower)) vector[3] += 1;
  if (/(csv|spreadsheet|table|rows?)/.test(lower)) vector[4] += 1;
  return new Float32Array(vector);
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "test/fake-script-embedding";
  readonly dimensions = 5;
  readonly calls: string[] = [];

  async embed(text: string): Promise<Float32Array | null> {
    this.calls.push(text);
    return embeddingFor(text);
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  reset(): void {
    this.calls.length = 0;
  }
}

let provider: FakeEmbeddingProvider;

function embeddingCount(scriptId: string): number {
  return (
    getDb()
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM script_embeddings WHERE scriptId = ?",
      )
      .get(scriptId)?.count ?? 0
  );
}

function embeddedText(scriptId: string): string | null {
  return (
    getDb()
      .prepare<{ embeddedText: string }, [string]>(
        "SELECT embeddedText FROM script_embeddings WHERE scriptId = ?",
      )
      .get(scriptId)?.embeddedText ?? null
  );
}

async function upsertFixture(args: {
  name: string;
  sourceLabel?: string;
  description: string;
  intent?: string;
  isScratch?: boolean;
}) {
  return upsertScriptByName({
    name: args.name,
    scope: "agent",
    scopeId: "agent-1",
    source: source(args.sourceLabel ?? args.name),
    description: args.description,
    intent: args.intent ?? args.description,
    signatureJson,
    agentId: "agent-1",
    isScratch: args.isScratch,
    typeChecked: !args.isScratch,
  });
}

beforeAll(async () => {
  await clearDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await clearDb();
});

beforeEach(() => {
  getDb().run("DELETE FROM scripts");
  provider = new FakeEmbeddingProvider();
  setScriptEmbeddingProviderForTests(provider);
});

describe("script embeddings", () => {
  test("migration applies and creates script_embeddings storage", () => {
    const schema = getDb()
      .prepare<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'script_embeddings'",
      )
      .get();
    expect(schema?.sql).toContain("scriptId TEXT PRIMARY KEY");
    expect(schema?.sql).toContain("embedding BLOB NOT NULL");
  });

  test("embeds explicit upserts and skips scratch upserts", async () => {
    const explicit = await upsertFixture({
      name: "linear-parser",
      description: "Parse Linear issue payloads",
    });
    expect(embeddingCount(explicit.script.id)).toBe(1);

    provider.reset();
    const scratch = await upsertFixture({
      name: "scratch-linear-parser",
      description: "Scratch Linear issue payloads",
      isScratch: true,
    });
    expect(embeddingCount(scratch.script.id)).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  test("re-embeds on body or searchable metadata changes, but not on no-op upsert", async () => {
    const first = await upsertFixture({
      name: "github-review",
      sourceLabel: "v1",
      description: "Group GitHub review comments",
    });
    expect(provider.calls).toHaveLength(1);

    provider.reset();
    await upsertFixture({
      name: "github-review",
      sourceLabel: "v2",
      description: "Group GitHub review comments",
    });
    expect(provider.calls).toHaveLength(1);

    provider.reset();
    await upsertFixture({
      name: "github-review",
      sourceLabel: "v2",
      description: "Summarize pull request review feedback",
    });
    expect(provider.calls).toHaveLength(1);
    expect(embeddedText(first.script.id)).toContain("Summarize pull request review feedback");

    provider.reset();
    await upsertFixture({
      name: "github-review",
      sourceLabel: "v2",
      description: "Summarize pull request review feedback",
    });
    expect(provider.calls).toHaveLength(0);
  });

  test("scripts reembed command backfills scripts promoted after scratch save", async () => {
    const scratch = await upsertFixture({
      name: "promoted-scratch",
      description: "Parse Slack channel messages",
      isScratch: true,
    });
    expect(embeddingCount(scratch.script.id)).toBe(0);

    getDb().run("UPDATE scripts SET isScratch = 0 WHERE id = ?", [scratch.script.id]);
    provider.reset();
    await runScriptsMaintenanceCommand(["reembed"]);

    expect(provider.calls).toHaveLength(1);
    expect(embeddingCount(scratch.script.id)).toBe(1);
  });

  test("semantic search outranks name-substring-only matches", async () => {
    await upsertFixture({
      name: "review-grouper",
      description: "Group GitHub pull request feedback by reviewer",
    });
    await upsertFixture({
      name: "comments-sorter",
      description: "Sort CSV table rows alphabetically",
    });

    provider.reset();
    const results = await searchScripts({ query: "comments", scopeId: "agent-1", limit: 2 });
    expect(results.map((result) => result.script.name)).toEqual([
      "review-grouper",
      "comments-sorter",
    ]);
  });

  test("hybrid ranking lets an exact name match outrank a weaker semantic match", async () => {
    await upsertFixture({
      name: "exact-name",
      description: "Unrelated helper",
    });
    await upsertFixture({
      name: "semantic-weaker",
      description: "Linear issue triage helper",
    });

    const results = await searchScripts({ query: "exact-name", scopeId: "agent-1", limit: 2 });
    expect(results[0]?.script.name).toBe("exact-name");
  });

  test("semantic recall returns expected top results for overlapping intents", async () => {
    const fixtures = [
      ["linear-json-parser", "Parse Linear issue JSON into task fields"],
      ["linear-ticket-router", "Route Linear tickets by team and priority"],
      ["github-pr-comment-grouper", "Group GitHub pull request comments by file"],
      ["github-review-summary", "Summarize PR review feedback and blockers"],
      ["memory-fanout", "Fan out memory recall searches across related terms"],
      ["memory-ranking", "Rank remembered notes by usefulness"],
      ["slack-thread-digest", "Digest Slack channel messages into a summary"],
      ["slack-alert-router", "Route Slack alerts to the right channel"],
      ["csv-normalizer", "Normalize CSV spreadsheet rows for table output"],
      ["table-formatter", "Format table rows into aligned text"],
    ] as const;

    for (const [name, description] of fixtures) {
      await upsertFixture({ name, description });
    }

    const queries = [
      ["issue payload fields", "linear-json-parser"],
      ["pull request comments", "github-pr-comment-grouper"],
      ["remembered search fanout", "memory-fanout"],
      ["channel message digest", "slack-thread-digest"],
      ["spreadsheet rows", "csv-normalizer"],
    ] as const;

    let topOneHits = 0;
    for (const [query, expected] of queries) {
      const results = await searchScripts({ query, scopeId: "agent-1", limit: 3 });
      if (results[0]?.script.name === expected) topOneHits++;
      expect(results.slice(0, 3).map((result) => result.script.name)).toContain(expected);
    }

    expect(topOneHits).toBeGreaterThanOrEqual(4);
  });

  test("embeddingMode: skip prevents embedding on new script", async () => {
    provider.reset();
    const result = await upsertScriptByName({
      name: "skip-new",
      scope: "agent",
      scopeId: "agent-1",
      source: source("skip-new"),
      description: "Should not embed",
      intent: "Skip mode test",
      signatureJson,
      agentId: "agent-1",
      embeddingMode: "skip",
    });
    expect(result.isNew).toBe(true);
    expect(embeddingCount(result.script.id)).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  test("embeddingMode: skip prevents embedding on source change", async () => {
    const first = await upsertScriptByName({
      name: "skip-update",
      scope: "agent",
      scopeId: "agent-1",
      source: source("v1"),
      description: "Will update",
      intent: "Skip mode update test",
      signatureJson,
      agentId: "agent-1",
    });
    expect(embeddingCount(first.script.id)).toBe(1);

    provider.reset();
    const second = await upsertScriptByName({
      name: "skip-update",
      scope: "agent",
      scopeId: "agent-1",
      source: source("v2"),
      description: "Updated source",
      intent: "Skip mode update test",
      signatureJson,
      agentId: "agent-1",
      embeddingMode: "skip",
    });
    expect(second.contentDeduped).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  test("embeddingMode: skip prevents embedding on metadata change", async () => {
    await upsertScriptByName({
      name: "skip-meta",
      scope: "agent",
      scopeId: "agent-1",
      source: source("skip-meta"),
      description: "Original description",
      intent: "Original intent",
      signatureJson,
      agentId: "agent-1",
    });

    provider.reset();
    await upsertScriptByName({
      name: "skip-meta",
      scope: "agent",
      scopeId: "agent-1",
      source: source("skip-meta"),
      description: "Changed description",
      intent: "Changed intent",
      signatureJson,
      agentId: "agent-1",
      embeddingMode: "skip",
    });
    expect(provider.calls).toHaveLength(0);
  });

  test("embeddingMode defaults to sync (embeds normally)", async () => {
    provider.reset();
    const result = await upsertScriptByName({
      name: "default-sync",
      scope: "agent",
      scopeId: "agent-1",
      source: source("default-sync"),
      description: "Should embed by default",
      intent: "Default mode test",
      signatureJson,
      agentId: "agent-1",
    });
    expect(embeddingCount(result.script.id)).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  test("reembedAllScripts updates every explicit script", async () => {
    await upsertFixture({ name: "linear-one", description: "Linear issue parser" });
    await upsertFixture({ name: "slack-one", description: "Slack message digest" });

    provider.reset();
    await reembedAllScripts();
    expect(provider.calls).toHaveLength(2);
  });

  test("delete cascades script_embeddings", async () => {
    const created = await upsertFixture({
      name: "delete-embedding",
      description: "Memory search helper",
    });
    expect(embeddingCount(created.script.id)).toBe(1);

    getDb().run("DELETE FROM scripts WHERE id = ?", [created.script.id]);
    expect(getScript({ name: "delete-embedding", scope: "agent", scopeId: "agent-1" })).toBeNull();
    expect(embeddingCount(created.script.id)).toBe(0);
  });
});
