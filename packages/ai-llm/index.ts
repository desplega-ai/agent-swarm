// @swarm/ai-llm — worker-safe structured-output LLM abstraction + memory rater
// client. Re-exports the live sources (now local under ./src after the Phase-3
// extraction). index.ts + models.ts are namespaced because their re-exports
// collide with the flat credentials/complete-structured/summarize exports (the
// documented 2 collisions); no consumer imports the colliding symbols
// (parseModelStr/resolveModelString) bare.
//
// Cycle-break #2 (Phase 3): the worker-safe raters (llm/llm-client/llm-summarizer)
// were hoisted out of be/memory/raters/ and the shared rater `types` folded in,
// so ai-llm no longer imports anything under be/. The four rater modules have no
// export-name collisions with each other or the internal-ai modules — all flat.

export * from "./src/utils/internal-ai/complete-structured";
export * from "./src/utils/internal-ai/credentials";
export * as UtilsInternalAiIndex from "./src/utils/internal-ai/index";
export * as UtilsInternalAiModels from "./src/utils/internal-ai/models";
export * from "./src/utils/internal-ai/register-bedrock";
export * from "./src/utils/internal-ai/summarize-session";
// Hoisted + folded raters (cycle-break #2).
export * from "./src/utils/internal-ai/raters/llm";
export * from "./src/utils/internal-ai/raters/llm-client";
export * from "./src/utils/internal-ai/raters/llm-summarizer";
export * from "./src/utils/internal-ai/raters/types";
