/**
 * OpenRouter base-URL resolution.
 *
 * `OPENROUTER_BASE_URL` lets a deployment route all OpenRouter traffic
 * through an OpenAI-compatible gateway (e.g. the cloud control plane's
 * `/proxy/v1` endpoint) instead of `openrouter.ai` directly, so the raw
 * OpenRouter key never has to live on the box. When the env var is unset
 * the default OpenRouter URL is used and behavior is unchanged.
 *
 * Worker-safe: pure env read, no `src/be/db` / `bun:sqlite` imports.
 * The opencode summarize plugin (`plugin/opencode-plugins/lib/summarize.ts`)
 * vendors this logic — keep the two in sync.
 */

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Resolve the OpenRouter base URL (no trailing slash). Reads
 * `OPENROUTER_BASE_URL` from `env`; blank values fall back to the default.
 * Call sites append paths like `/chat/completions` or `/models`.
 */
export function getOpenRouterBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENROUTER_BASE_URL;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, "");
  }
  return DEFAULT_OPENROUTER_BASE_URL;
}
