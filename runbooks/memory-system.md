# Memory system runbook

Architecture, tests, and key files for the agent memory subsystem.

## Architecture

Provider abstractions live in `src/be/memory/`:

- `EmbeddingProvider` — OpenAI embeddings.
- `MemoryStore` — SQLite + sqlite-vec for vector search.
- Reranker scores `similarity × recency_decay × access_boost`.

Tuning constants are env-overridable in `src/be/memory/constants.ts`.

## Tests

Run all four after any change:

```bash
bun test src/tests/memory-reranker.test.ts
bun test src/tests/memory-store.test.ts
bun test src/tests/memory.test.ts
bun test src/tests/memory-e2e.test.ts
```

## Key files

- `src/be/memory/types.ts` — interfaces.
- `src/be/memory/providers/` — OpenAI embeddings + SQLite/sqlite-vec store.
- `src/be/memory/reranker.ts` — scoring.
- `src/be/memory/constants.ts` — env-overridable tuning.
- `src/be/memory/index.ts` — singletons.

## Trigger paths

This runbook applies when modifying:

- `src/be/memory/`
- `src/be/embedding.ts`
- `src/tools/memory-*.ts`
- `src/http/memory.ts`
- `src/tools/store-progress.ts` (memory sections)
