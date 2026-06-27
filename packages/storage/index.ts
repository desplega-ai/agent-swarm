// @swarm/storage — the SQLite DB owner: db.ts + migrations (.sql), db-queries, events/
// users/audit, secrets crypto, the memory stores + chunking/embedding/reranker, the seed
// runners (pricing / prompt-templates / scripts / skills), be/scripts, pages + metrics
// version, the automatic-task-gate, and the page-session signer. Phase-4: real sources live
// in ./src; consumers import "@swarm/storage". The lightweight DB handle (initDb/getDb/
// closeDb) is ALSO exposed via the "@swarm/storage/db" subpath so the test preload can build
// a migration template without eager-loading this whole barrel's side-effecting graph.
//
// TEXT-IMPORT EXCLUSION: ./src/be/seed-scripts/index.ts text-imports the catalog files
// (./src/be/seed-scripts/catalog/*.ts and *.inline.ts) with `{ type: "text" }`. Those files
// are deliberately NOT re-exported here — a module re-export eager-evaluates them BEFORE the
// text-import runs, which poisons the text load (SEED_SCRIPTS[*].source becomes a module
// object instead of the source string). Their only module-consumer is seed-scripts.test.ts,
// which imports them directly via relative paths.
export * from "./src/be/audit-user";
export * from "./src/be/boot-scrub-logs";
export * from "./src/be/budget-admission";
export * from "./src/be/budget-refusal-notify";
export * from "./src/be/chunking";
export * from "./src/be/crypto/index";
export * as BeCryptoKeyBootstrap from "./src/be/crypto/key-bootstrap";
export * as BeCryptoSecretsCipher from "./src/be/crypto/secrets-cipher";
export * from "./src/be/db-queries/mcp-oauth";
export * from "./src/be/db-queries/oauth";
export * from "./src/be/db-queries/tracker";
export * from "./src/be/db";
export * from "./src/be/embedding";
export * from "./src/be/events";
export * from "./src/be/memory/boot-reembed";
export * from "./src/be/memory/constants";
export * from "./src/be/memory/edges-store";
export * from "./src/be/memory/index";
export * from "./src/be/memory/link-resolver";
export * from "./src/be/memory/providers/openai-embedding";
export * from "./src/be/memory/providers/sqlite-store";
export * from "./src/be/memory/raters/explicit-self";
export * from "./src/be/memory/raters/implicit-citation";
// llm-client / llm-summarizer / llm / types hoisted into @swarm/ai-llm (cycle-break #2,
// Phase 3) — they moved out of be/memory/raters/ into src/utils/internal-ai/raters/.
// The remaining DB-backed raters import the folded types/llm via @swarm/ai-llm.
export * from "./src/be/memory/raters/noop";
export * from "./src/be/memory/raters/registry";
export * from "./src/be/memory/raters/retrieval";
export * from "./src/be/memory/raters/run-server-raters";
export * from "./src/be/memory/raters/store";
export * from "./src/be/memory/reranker";
export * from "./src/be/memory/retrieval-store";
export * from "./src/be/memory/types";
export * from "./src/be/migrations/runner";
export * from "./src/be/pricing-refresh";
export * from "./src/be/schedules/validate";
export * from "./src/be/scripts/boot-reembed";
export * from "./src/be/scripts/db";
export * from "./src/be/scripts/embeddings";
export * from "./src/be/scripts/extract-schema";
export * from "./src/be/scripts/maintenance";
export * from "./src/be/scripts/typecheck";
export * from "./src/be/seed-pricing";
export * from "./src/be/seed-prompt-templates";
export * from "./src/be/seed-scripts/index";
export * from "./src/be/seed-skills/index";
export * from "./src/be/seed/index";
export * as BeSeedRegistry from "./src/be/seed/registry";
export * as BeSeedRunner from "./src/be/seed/runner";
export * as BeSeedStateDb from "./src/be/seed/state-db";
export * as BeSeedTypes from "./src/be/seed/types";
export * from "./src/be/skill-sync";
export * from "./src/be/task-lifecycle-events";
export * from "./src/be/unmapped-identities";
export * from "./src/be/users";
export * from "./src/memory/automatic-task-gate";
export * from "./src/metrics/version";
export * from "./src/pages/version";
export * from "./src/utils/page-session";
