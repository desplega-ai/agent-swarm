export type ClaudeTransport = "cli" | "sdk";

function resolvedValue(
  env: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined>,
  key: string,
): string | undefined {
  return env[key]?.trim() || fallbackEnv[key]?.trim() || undefined;
}

export function resolveClaudeTransport(
  env: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): ClaudeTransport {
  const raw = resolvedValue(env, fallbackEnv, "CLAUDE_TRANSPORT") ?? "cli";
  if (raw === "cli" || raw === "sdk") return raw;
  throw new Error(`Invalid CLAUDE_TRANSPORT '${raw}'. Expected 'cli' or 'sdk'.`);
}

function enabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "true" || value === "1";
}

export function isClaudeBridgeEffective(
  env: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): boolean {
  const binary = resolvedValue(env, fallbackEnv, "CLAUDE_BINARY")?.toLowerCase() ?? "claude";
  const explicitBridgeBinary = binary.includes("claude-bridge") || binary.includes("shan" + "non");
  if (explicitBridgeBinary) return true;

  const bridgeRequested = enabled(resolvedValue(env, fallbackEnv, "SWARM_USE_CLAUDE_BRIDGE"));
  const oauthToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? fallbackEnv.CLAUDE_CODE_OAUTH_TOKEN)?.trim();
  return bridgeRequested && Boolean(oauthToken);
}
