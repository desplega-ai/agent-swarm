import { getSwarmConfigs, upsertSwarmConfig } from "./db";

/**
 * Tool groups that were registered unconditionally before capability gating
 * (PR #996) and are default-enabled today. An explicit `CAPABILITIES` env
 * value written before the gating change could not have intended to exclude
 * them — without a backfill, upgrading silently removes those tools from the
 * MCP surface. The groups that gating deliberately turned off by default
 * (services, prompt-templates, messaging, swarm-x, agentmail, kapso) are NOT
 * backfilled: going dark by default is the point of that change.
 */
const LEGACY_ALWAYS_ON_DEFAULTS = [
  "core",
  "config",
  "scripts",
  "mcp",
  "slack",
  "tracker",
  "skills",
  "repo",
] as const;

/**
 * One-time upgrade seed for deployments that pin `CAPABILITIES` via env.
 *
 * When an explicit env value is present and there is no global swarm_config
 * `CAPABILITIES` row yet, write one containing the env value plus any missing
 * legacy always-on groups. The config row takes precedence at server creation
 * (see `loadGlobalConfigsIntoEnv(true)` in createServer), is visible in the
 * dashboard, and the operator can edit or delete it to take full control —
 * once a row exists this seed never touches it again.
 */
export function seedLegacyCapabilitiesConfig(): { seeded: boolean; added: string[] } {
  const envValue = process.env.CAPABILITIES;
  if (!envValue) return { seeded: false, added: [] };

  const existing = getSwarmConfigs({ scope: "global", key: "CAPABILITIES" });
  if (existing.length > 0) return { seeded: false, added: [] };

  const current = new Set(
    envValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const added = LEGACY_ALWAYS_ON_DEFAULTS.filter((c) => !current.has(c));
  if (added.length === 0) return { seeded: false, added: [] };

  const next = [...current, ...added].join(",");
  upsertSwarmConfig({
    scope: "global",
    key: "CAPABILITIES",
    value: next,
    description:
      "Auto-seeded on upgrade: explicit CAPABILITIES env predates capability gating, so previously always-registered tool groups were backfilled. Edit or delete this row to take full control of the MCP tool surface.",
  });
  process.env.CAPABILITIES = next;
  console.log(
    `[startup] CAPABILITIES backfilled with previously always-on groups: ${added.join(", ")} (seeded a global swarm_config row; edit or delete it to override)`,
  );
  return { seeded: true, added: [...added] };
}
