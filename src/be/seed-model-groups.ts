/**
 * Boot seed for the four tier groups (`smol`, `regular`, `smart`, `ultra`),
 * runbooks/model-tiers.md § Model groups. Each lists the shipped
 * `<harness>-<tier>` profiles, one per harness, so on any harness the only
 * member is today's tier profile: seeding changes no task's model.
 *
 * Insert-if-missing, like `seed-model-profiles.ts`: an existing group is never
 * touched, so an edited order or description survives every boot. A tier name
 * already taken by a profile is skipped (groups and profiles share one name
 * space). Run after `seedModelProfiles`.
 */
import {
  DEFAULT_MODEL_TIER_MAP,
  MODEL_TIERS,
  type ModelTier,
  type ProviderName,
  ProviderNameSchema,
} from "../types";
import { createModelGroup } from "./db/model-groups";
import { getDbClient } from "./db/runtime";

/** Member order of a seeded group; harnesses not listed follow in schema order. */
const SEED_HARNESS_ORDER: ProviderName[] = [
  "claude",
  "claude-managed",
  "codex",
  "cursor",
  "grok",
  "amp",
  "pi",
  "opencode",
  "dsh",
  "fx",
  "devin",
];

const TIER_DESCRIPTIONS: Record<ModelTier, string> = {
  smol: "Cheap",
  regular: "The regular tier",
  smart: "The smart tier",
  ultra: "The ultra tier",
};

function seedHarnessOrder(): ProviderName[] {
  return [
    ...SEED_HARNESS_ORDER,
    ...ProviderNameSchema.options.filter((h) => !SEED_HARNESS_ORDER.includes(h)),
  ];
}

export async function seedModelGroups(): Promise<number> {
  let inserted = 0;
  for (const tier of MODEL_TIERS) {
    const existing = await getDbClient().get<{ id: string }>(
      "SELECT id FROM model_groups WHERE name = ?",
      [tier],
    );
    if (existing) continue;
    const wanted = seedHarnessOrder()
      .filter((harness) => DEFAULT_MODEL_TIER_MAP[harness]?.[tier])
      .map((harness) => `${harness}-${tier}`);
    if (wanted.length === 0) continue;
    const present = new Set(
      (
        await getDbClient().query<{ name: string }>(
          `SELECT name FROM model_profiles WHERE name IN (${wanted.map(() => "?").join(", ")})`,
          wanted,
        )
      ).map((row) => row.name),
    );
    const members = wanted.filter((name) => present.has(name));
    if (members.length === 0) continue;
    const result = await createModelGroup({
      name: tier,
      description: TIER_DESCRIPTIONS[tier],
      seededFrom: `tier:${tier}`,
      members,
    });
    if (result.ok) {
      inserted++;
    } else if (result.reason === "name-taken") {
      console.warn(`[startup] Model group "${tier}" not seeded: ${result.error}`);
    }
  }
  return inserted;
}
