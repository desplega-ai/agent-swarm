/**
 * Model group resolution (runbooks/model-tiers.md § Model groups). A group is
 * an ordered list of profiles that may span harnesses. On one agent it means
 * the first member that runs on the agent's harness and passes
 * `checkProfileForAgent` there. Send-task, claim, the pool filters and the
 * fallback hop all read the group through this module.
 */
import { getAgentById, getDbClient } from "./db";
import { checkProfileForAgent, type ProfileCheckOptions } from "./model-profile-check";

/** A member passed over, and why ("harness: runs on codex", "harness-credentials: ..."). */
export type GroupMemberSkip = { profile: string; reason: string };

export type GroupResolution =
  /** No group has this name. */
  | { kind: "missing" }
  /**
   * `member` is the first passing member, at `index` in the group order.
   * `onHarness` lists every member on the agent's harness, in order.
   */
  | {
      kind: "resolved";
      member: string;
      index: number;
      skipped: GroupMemberSkip[];
      onHarness: string[];
    }
  /** The group exists but no member runs on the agent. */
  | { kind: "none"; skipped: GroupMemberSkip[] };

/** The group's members in order, with each member's harness. Null when no group has the name. */
export async function modelGroupMemberHarnesses(
  group: string,
): Promise<{ profile: string; harness: string }[] | null> {
  const rows = await getDbClient().query<{ profile: string | null; harness: string | null }>(
    `SELECT m.profileName AS profile, p.harness AS harness
       FROM model_groups g
       LEFT JOIN model_group_members m ON m.groupId = g.id
       LEFT JOIN model_profiles p ON p.name = m.profileName
      WHERE g.name = ?
      ORDER BY m.position`,
    [group.trim()],
  );
  if (rows.length === 0) return null;
  return rows.flatMap((row) =>
    row.profile && row.harness ? [{ profile: row.profile, harness: row.harness }] : [],
  );
}

/** "check: detail" of the primary's first failing row. */
export function firstFailingCheck(
  result: NonNullable<Awaited<ReturnType<typeof checkProfileForAgent>>>,
): string {
  const row = result.profiles[0]?.checks.find((check) => check.state === "fail");
  if (!row) return "failed the profile check";
  return row.detail ? `${row.check}: ${row.detail}` : row.check;
}

/**
 * The member of `group` that `agentId` runs: the first one on the agent's
 * harness that passes `checkProfileForAgent`. Members in `skip` (profiles the
 * work already ran on) are passed over without a record; every other member
 * passed over is listed in `skipped` with its reason. `startAfter` starts the
 * walk after that member when the group still lists it (a fallback hop).
 */
export async function resolveGroupForAgent(
  group: string,
  agentId: string,
  options: Pick<ProfileCheckOptions, "vcsRepo" | "includeRepoSecrets"> & {
    skip?: ReadonlySet<string>;
    startAfter?: string;
    /** Pass over members on other harnesses without a record (a same-agent hop). */
    sameHarnessOnly?: boolean;
  } = {},
): Promise<GroupResolution> {
  const members = await modelGroupMemberHarnesses(group);
  if (!members) return { kind: "missing" };
  const agent = await getAgentById(agentId);
  const harness = agent?.harnessProvider ?? agent?.provider ?? null;
  const skipped: GroupMemberSkip[] = [];
  const from = options.startAfter
    ? members.findIndex((member) => member.profile === options.startAfter) + 1
    : 0;
  for (let index = from; index < members.length; index++) {
    const member = members[index]!;
    if (options.skip?.has(member.profile)) continue;
    if (member.harness !== harness) {
      if (options.sameHarnessOnly) continue;
      skipped.push({ profile: member.profile, reason: `harness: runs on ${member.harness}` });
      continue;
    }
    const result = await checkProfileForAgent(agentId, member.profile, {
      vcsRepo: options.vcsRepo,
      includeRepoSecrets: options.includeRepoSecrets,
      fallbacks: false,
    });
    if (result?.ok) {
      const onHarness = members.filter((m) => m.harness === harness).map((m) => m.profile);
      return { kind: "resolved", member: member.profile, index, skipped, onHarness };
    }
    skipped.push({
      profile: member.profile,
      reason: result ? firstFailingCheck(result) : "not found",
    });
  }
  return { kind: "none", skipped };
}

/** "a (reason), b (reason)" for a log line or an error. */
export function formatGroupSkips(skipped: GroupMemberSkip[]): string {
  return skipped.map((skip) => `${skip.profile} (${skip.reason})`).join(", ");
}

/** Why no member of `group` runs on the agent, for a gate or a claim failure. */
export function groupUnavailableMessage(
  group: string,
  harness: string | null | undefined,
  skipped: GroupMemberSkip[],
): string {
  const where = harness ? `this ${harness} agent` : "this agent";
  return `[model-group-unavailable] no member of "${group}" runs on ${where}${
    skipped.length > 0 ? `: ${formatGroupSkips(skipped)}` : ""
  }`;
}

/** Whether `group` has a member on `harness`. A missing group, or no harness, answers true (claim decides). */
export async function groupHasMemberOnHarness(
  group: string,
  harness: string | null | undefined,
): Promise<boolean> {
  if (!harness) return true;
  const members = await modelGroupMemberHarnesses(group);
  return !members || members.some((member) => member.harness === harness);
}
