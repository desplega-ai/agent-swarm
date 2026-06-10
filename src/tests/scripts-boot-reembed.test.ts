import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import type { EmbeddingProvider } from "../be/memory/types";
import { runBootReembedScripts } from "../be/scripts/boot-reembed";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";

const TEST_DB_PATH = "./test-scripts-boot-reembed.sqlite";

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

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "test/fake-boot-reembed";
  readonly dimensions = 5;
  readonly calls: string[] = [];

  async embed(text: string): Promise<Float32Array | null> {
    this.calls.push(text);
    return new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
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

function totalEmbeddingCount(): number {
  return (
    getDb().prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM script_embeddings").get()
      ?.count ?? 0
  );
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
  getDb().run("DELETE FROM script_embeddings");
  provider = new FakeEmbeddingProvider();
  setScriptEmbeddingProviderForTests(provider);
});

describe("boot-reembed-scripts", () => {
  test("backfills scripts that were seeded with embeddingMode: skip", async () => {
    const result = await upsertScriptByName({
      name: "skipped-embed",
      scope: "global",
      source: source("skipped"),
      description: "A script seeded without embedding",
      intent: "Test backfill",
      signatureJson,
      embeddingMode: "skip",
    });
    expect(embeddingCount(result.script.id)).toBe(0);

    provider.reset();
    await runBootReembedScripts();
    expect(embeddingCount(result.script.id)).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  test("no-ops when all scripts already have embeddings", async () => {
    await upsertScriptByName({
      name: "already-embedded",
      scope: "global",
      source: source("embedded"),
      description: "Already has embedding",
      intent: "No-op test",
      signatureJson,
    });
    expect(totalEmbeddingCount()).toBe(1);

    provider.reset();
    await runBootReembedScripts();
    expect(provider.calls).toHaveLength(0);
  });

  test("skips scratch scripts during backfill", async () => {
    await upsertScriptByName({
      name: "scratch-no-backfill",
      scope: "agent",
      scopeId: "agent-1",
      source: source("scratch"),
      description: "Scratch script",
      intent: "Should not be backfilled",
      signatureJson,
      isScratch: true,
    });

    provider.reset();
    await runBootReembedScripts();
    expect(provider.calls).toHaveLength(0);
  });

  test("backfills only scripts missing embeddings, not those that already have them", async () => {
    const withEmbed = await upsertScriptByName({
      name: "has-embed",
      scope: "global",
      source: source("has"),
      description: "Has embedding",
      intent: "Already embedded",
      signatureJson,
    });
    const withoutEmbed = await upsertScriptByName({
      name: "missing-embed",
      scope: "global",
      source: source("missing"),
      description: "Missing embedding",
      intent: "Needs backfill",
      signatureJson,
      embeddingMode: "skip",
    });
    expect(embeddingCount(withEmbed.script.id)).toBe(1);
    expect(embeddingCount(withoutEmbed.script.id)).toBe(0);

    provider.reset();
    await runBootReembedScripts();
    expect(provider.calls).toHaveLength(1);
    expect(embeddingCount(withoutEmbed.script.id)).toBe(1);
  });
});
