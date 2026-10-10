import type { Env } from "./types.ts";

/** Trimmed value, or undefined when unset or blank. An explicitly empty var counts as unset. */
export function envValue(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/** Same truthy set Claude Code uses for its `CLAUDE_CODE_USE_*` flags. */
export function isEnvTruthy(env: Env, key: string): boolean {
  const value = envValue(env, key)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
