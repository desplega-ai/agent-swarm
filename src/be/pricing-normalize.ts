/**
 * Phase 2 fix — normalize provider model ids before pricing-table lookup.
 *
 * Different harnesses report the same underlying model under different keys:
 *
 *   - claude-adapter      → `claude-opus-4-7`               (bare)
 *   - codex-adapter       → `gpt-5.4`                       (bare, dotted)
 *   - opencode-adapter    → `openrouter/anthropic/claude-sonnet-4.5`
 *   - pi-mono-adapter     → `github-copilot/gpt-5.4` or
 *                            `openrouter/anthropic/claude-sonnet-4.5`
 *
 * The pricing seed in `src/be/seed-pricing.ts` keys by what models.dev calls
 * the model (e.g. `anthropic/claude-sonnet-4.5` for openrouter rows,
 * `gpt-5.4` for openai rows). That means harness-emitted ids with extra
 * routing prefixes (`openrouter/`, `github-copilot/`, …) fall through to
 * `costSource='unpriced'` even when we have a perfectly good rate row.
 *
 * Rather than rewriting the adapter outputs (which are the harness's source
 * of truth and useful for debugging), we normalize at the *lookup boundary*:
 * strip noisy routing prefixes so the seeded canonical key resolves.
 *
 * Apply this helper symmetrically: once when seeding rows (so seed keys are
 * canonical) and once when querying (so adapter-emitted keys collapse onto
 * the same canonical form).
 */

import type { PricingProvider } from "../types";

/**
 * Routing prefixes that a harness may prepend to the underlying model id but
 * that have no pricing semantics. Stripping these collapses
 * `openrouter/anthropic/claude-sonnet-4.5` → `anthropic/claude-sonnet-4.5`
 * which is the key models.dev/openrouter uses.
 *
 * Order matters: we only ever strip the *first* matching prefix so we don't
 * accidentally chew through a model id like `openai/openai-test-model`.
 */
const ROUTING_PREFIXES_BY_PROVIDER: Record<PricingProvider, readonly string[]> = {
  // opencode routes via opencode-server which proxies to openrouter, anthropic,
  // openai, … — strip whichever proxy prefix the user picked.
  opencode: ["openrouter/", "github-copilot/"],
  // pi-mono can hit openrouter mirrors, the github-copilot proxy, or native
  // anthropic/openai/google providers.
  pi: ["openrouter/", "github-copilot/"],
  // codex normally reports a bare id, but a user may set MODEL_OVERRIDE to a
  // prefixed form. Be forgiving on the lookup side.
  codex: ["openai/", "github-copilot/"],
  // claude / claude-managed / devin / gemini emit bare ids today. The empty
  // list keeps the helper a no-op for them but the entry-per-provider shape
  // means a future provider can opt in without changing call-sites.
  claude: [],
  "claude-managed": [],
  devin: [],
  gemini: [],
  acp: [],
};

/**
 * Canonical model key for a `(provider, model)` pair. Idempotent — calling
 * this on an already-normalized value is a no-op.
 *
 * Rules:
 *  1. Lowercase the input. Adapters sometimes pass mixed case (codex calls
 *     `.toLowerCase()` itself; opencode/pi don't always).
 *  2. Strip the first matching routing prefix for this provider, if any.
 *
 * We deliberately do NOT touch dotted-vs-dashed minor versions
 * (`gpt-5.4` vs `gpt-5-4`) — both harness output and models.dev use dotted
 * for openai and dashed for anthropic, so there's no real drift there.
 */
export function normalizeModelKey(provider: PricingProvider, model: string): string {
  if (!model) return model;
  let key = model.toLowerCase();
  const prefixes = ROUTING_PREFIXES_BY_PROVIDER[provider] ?? [];
  for (const prefix of prefixes) {
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
      break;
    }
  }
  return key;
}
