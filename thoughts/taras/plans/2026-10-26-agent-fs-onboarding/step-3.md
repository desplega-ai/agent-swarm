---
id: step-3
name: Swarm memory on a local TEI
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: Swarm memory on a local TEI

## Overview

Make swarm memory correct on a local OpenAI-compatible server such as Hugging Face TEI with nomic-embed-text-v1.5. Three changes: optional task prefixes for queries and documents, a per-input fallback when the server rejects a batch as too big, and a `/setup` memory probe that accepts the operator's configured private endpoint. Unset envs give today's requests byte for byte. Dimensions stay at the 512 default (root decision 2).

Spike evidence (`thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/tei-local/README.md`):
- TEI truncates `dimensions: 512` correctly (cosine 0.99997 against the nomic card recipe).
- With TEI's default `--max-client-batch-size 32`, a 139-chunk document stored 0 embeddings. The log said `[memory] Batch embedding failed: 422`. The retry path handles only 400 (`src/be/memory/providers/openai-embedding.ts:31-33,142-156,170`).
- The probe calls `assertUrlSafe(baseUrl, publicEndpointSsrfOptions())` (`src/http/onboarding.ts:211-262`), which rejects `http://tei:80/v1` when `NODE_ENV` is unset (the production image).

## Changes Required:

#### 1. Task prefixes
**Files**: `src/be/memory/types.ts:7-14`, `src/be/memory/providers/openai-embedding.ts`
**Changes**:
- `embed(text, opts?: { kind?: "query" | "document" })` and `embedBatch(texts, opts?)`. The second argument is optional, so the existing test mocks still compile.
- The provider reads `EMBEDDING_QUERY_PREFIX` and `EMBEDDING_DOCUMENT_PREFIX` when it is constructed (config reload already calls `resetEmbeddingProvider()`, `src/http/core.ts:188-243`). It prepends the prefix after `cleanInput` and before the request. Unset or empty means no prefix. Use the value verbatim (nomic needs `search_query: ` with the trailing space). Cut the cleaned input to `MAX_EMBEDDING_INPUT_CHARS - prefix.length` before prepending, so the total stays under the cap.
- No `kind` means no prefix, so a missed call site keeps today's behavior.

#### 2. Call sites
**Changes**: Pass `kind: "query"` at `src/tools/memory-search.ts:121-123`, `src/http/memory.ts:915-917` and `:1041-1042`, `src/be/scripts/embeddings.ts:208`. Pass `kind: "document"` at `src/tools/memory-edit.ts:185-186`, `src/tools/inject-learning.ts:75-76`, `src/be/memory/index-content.ts:107` and `:165`, `src/be/memory/boot-reembed.ts:59`, `src/http/memory.ts:1291-1292` and `:1371-1381`, `src/be/scripts/embeddings.ts:82`. Leave the health probes `embed("test")` at `boot-reembed.ts:36` and `src/be/scripts/boot-reembed.ts:74` without a kind. Re-check these line numbers with `grep -n "embed(\|embedBatch(" <file>` before editing.

#### 3. Batch-size rejections fall back per input
**File**: `src/be/memory/providers/openai-embedding.ts` (`isInputRejection`, about lines 30-39, and `embedBatch`, 127-186)
**Changes**: Today a rejected batch already falls back to one request per input (lines 168-180), but only for HTTP 400. Also take that path for HTTP 413, and for HTTP 422 whose message matches `/batch size/i` (record TEI's exact text in the live QA). Do not treat every 422 as an input rejection: TEI also answers 422 for a bad `dimensions` value, and that must stay one logged failure, not N requests per document.

#### 4. `/setup` memory probe for the configured endpoint
**File**: `src/http/onboarding.ts:199-300` (`handleMemoryProbe`)
**Changes**: For preset `existing`, the probe tests the server's own configured `EMBEDDING_API_BASE_URL`. Skip `assertUrlSafe` for that case only, and only when `EMBEDDING_API_BASE_URL` is set, because the URL is then operator config and not request input. With it unset, keep today's default and checks (`onboarding.ts:210-215`). Keep the check for every preset that takes `baseUrl` from the request. Do not turn on `ALLOW_PRIVATE_NETWORK_URLS` (it widens SSRF for OAuth, script connections and the MCP proxy).

#### 5. Catalog and docs
**Files**:
- `apps/ui/src/lib/configuration-catalog.ts`, group `memory` (near `EMBEDDING_MODEL`, lines 241-249): two `string` entries, `EMBEDDING_QUERY_PREFIX` and `EMBEDDING_DOCUMENT_PREFIX`. Description: "Text added before each search query (document). nomic-embed models need 'search_query: ' and 'search_document: '. Changing it on an install with stored memories needs a re-embed." No `restartRequired`.
- Docs: `reference/environment-variables.mdx` (EMBEDDING_* rows, lines 63-67), `architecture/memory.mdx` (lines 16-28: add "Local embeddings with TEI" with the two prefixes, `--max-client-batch-size 256`, `--max-batch-tokens 2048`, and that `EMBEDDING_API_KEY` must be non-empty), `ui/configuration.mdx`.
- `src/tests/preload.ts` and `src/tests/preload-env.test.ts`: both prefix envs.

### Success Criteria:

#### Automated Verification:
- [x] Provider tests: `bun run test:root -- src/tests/openai-embedding-provider.test.ts` (new cases against the fake server: query prefix on `kind: "query"`, document prefix on `kind: "document"`, none when unset, none without `kind`)
- [x] Batch fallback: `bun run test:root -- src/tests/memory-embedding-input-cap.test.ts` (new fake server that answers 422 `batch size 70 > maximum allowed batch size 32` above 32 inputs: a 70-input batch embeds all 70; a 422 with another message is one logged failure and makes no per-input calls)
- [x] Probe: `bun run test:root -- src/tests/onboarding.test.ts` (new case with `NODE_ENV=production` set inside the test: preset `existing` with `EMBEDDING_API_BASE_URL=http://127.0.0.1:<fake>/v1` passes; preset `custom` with the same URL in the body is still blocked)
- [x] Memory suite, one at a time: `bun run test:root -- src/tests/memory-store.test.ts && bun run test:root -- src/tests/memory.test.ts && bun run test:root -- src/tests/memory-e2e.test.ts && bun run test:root -- src/tests/memory-reranker.test.ts && bun run test:root -- src/tests/memory-key-paths.test.ts`
- [x] Scripts embeddings: `bun run test:root -- src/tests/scripts-boot-reembed.test.ts && bun run test:root -- src/tests/scripts-embeddings.test.ts`
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] Live TEI run (needs Docker). Start TEI exactly as root Manual E2E part A does (container `afo-step-3-tei`, port 8091; on x86 use the `cpu-1.9.4` tag, on arm64 `cpu-arm64-1.9.4`). Boot the API in the background from a fresh worktree (save the PID to `/tmp/afo-step-3/pid`) with `bun --expose-gc src/http.ts`. On macOS only, add the preload that loads Homebrew SQLite for sqlite-vec: `bun --expose-gc --preload thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/tei-local/scripts/preload.ts src/http.ts`. Keep `NODE_ENV` unset, `DATABASE_PATH=/tmp/afo-step-3/db.sqlite`, the four `EMBEDDING_*` envs plus both prefixes.
  - `POST /api/memory/index` with a 150 KB document stores an embedding for every chunk (count rows in the temp DB).
  - 5 paraphrase queries through `POST /api/memory/search` return the right memory first, with `retrievalSource` `vec` or `hybrid`.
  - `POST /api/onboarding/memory` with `{"preset":"existing"}` returns `ok: true`.
  - A 24,000-character memory (the `memory-edit` cap) stores an embedding, so TEI's `--max-batch-tokens 2048` with `auto_truncate` does not reject long inputs. Record what TEI does.
  - Then `kill "$(cat /tmp/afo-step-3/pid)"`, remove the container, its volume and the image, and delete `/tmp/afo-step-3`.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-3] memory prefixes, batch fallback and private probe for local TEI` after verification passes.
