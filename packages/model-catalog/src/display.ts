/**
 * Display helpers shared by the swarm app and the evals app. Pure module.
 */

/**
 * models.dev marks a moving alias entry with a trailing "(latest)" in its name
 * ("Claude Haiku 4.5 (latest)"). The suffix says how models.dev files the
 * entry, not what the model is, so labels drop it.
 */
export function modelDisplayName(name: string): string;
export function modelDisplayName(name: string | null | undefined): string | undefined;
export function modelDisplayName(name: string | null | undefined): string | undefined {
  if (name === null || name === undefined) return undefined;
  const cleaned = name.replace(/\s*\((?:latest)\)\s*$/i, "").trim();
  return cleaned || name;
}
