/**
 * Whether an agent can run a model profile (runbooks/model-tiers.md § Model
 * profiles). The one judge every profile gate calls: the runtime PATCH, task
 * creation, schedules, workflows and the pooled claim format its failing rows.
 *
 * Read-only. Each check row is `pass`, `warn`, `fail` or `unverified`; only a
 * `fail` on the primary profile makes the result not ok. No secret value ever
 * reaches a row's `detail`: rows name vars and 5-character key suffixes only.
 */
import { harnessModelMismatch, isAlias, isHarnessModelJudged } from "@desplega/model-catalog";
import { can } from "../rbac";
import type {
  Agent,
  ModelProfile,
  ProfileCheckResult,
  ProfileCheckRow,
  ProfileCheckState,
} from "../types";
import { getModelAwareCredentialVars, keySuffix, splitCredentialPool } from "../utils/credentials";
import { runtimeHarnessSections } from "../utils/runtime-model-catalog";
import { vcsRepoName, vcsRepoUrlMatches } from "../utils/vcs-repo-match";
import { getAgentById, getDbClient, getResolvedConfig } from "./db";
import { getModelProfileByName } from "./db/model-profiles";
import { isKnownCatalogModel } from "./model-validation";

/** Harnesses whose credential var depends on the model prefix (`getModelAwareCredentialVars`). */
const MODEL_AWARE_CREDENTIAL_HARNESSES = new Set(["pi", "opencode", "dsh", "grok"]);

const STATE_RANK: Record<ProfileCheckState, number> = { pass: 0, unverified: 1, warn: 2, fail: 3 };

function worst(states: ProfileCheckState[]): ProfileCheckState {
  return states.reduce<ProfileCheckState>(
    (acc, state) => (STATE_RANK[state] > STATE_RANK[acc] ? state : acc),
    "pass",
  );
}

export interface ProfileCheckOptions {
  /**
   * Judge against this harness instead of the agent's current one (a runtime
   * PATCH that also switches the harness). The worker's credential report is
   * then for the old harness, so that row is `unverified`.
   */
  harness?: string | null;
  /**
   * The task's `vcsRepo`. The worker loads that repo's scoped config over the
   * agent's (repo > agent), so the check judges the same pool.
   */
  vcsRepo?: string | null;
  /** Whether the worker's config read includes secret repo rows (`readsRepoSecrets`). */
  includeRepoSecrets?: boolean;
}

/**
 * Whether a runtime-token agent's config read includes secret repo rows: only
 * with `config.read.secrets`. Other callers always get them.
 */
export function runtimeReadsRepoSecrets(agent: { id: string; isLead?: boolean }): boolean {
  return can({
    principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead ?? false },
    verb: "config.read.secrets",
    resource: { kind: "none" },
    source: "http",
  }).allow;
}

/**
 * The `swarm_repos` id `vcsRepo` names, matched as the worker's
 * `fetchRepoConfig` matches it. Null when no registered repo matches.
 */
export async function vcsRepoId(vcsRepo: string | null | undefined): Promise<string | null> {
  if (!vcsRepo?.trim()) return null;
  const repos = await getDbClient().query<{ id: string; url: string }>(
    "SELECT id, url FROM swarm_repos WHERE name = ? ORDER BY name ASC",
    [vcsRepoName(vcsRepo)],
  );
  return repos.find((r) => vcsRepoUrlMatches(r.url, vcsRepo))?.id ?? null;
}

/** Pooled credential values the worker would get, by var: exported config rows only. */
async function configPools(
  agentId: string,
  { vcsRepo, includeRepoSecrets = true }: ProfileCheckOptions,
): Promise<Map<string, string>> {
  const pools = new Map<string, string>();
  const repoId = (await vcsRepoId(vcsRepo)) ?? undefined;
  for (const row of await getResolvedConfig(agentId, repoId, { includeRepoSecrets })) {
    if (row.exportToEnv && row.value.trim()) pools.set(row.key, row.value);
  }
  return pools;
}

function harnessRow(profile: ModelProfile, harness: string | null): ProfileCheckRow {
  if (!harness) {
    return { check: "harness", state: "unverified", detail: "the agent has no harness yet" };
  }
  if (profile.harness === harness) return { check: "harness", state: "pass" };
  return {
    check: "harness",
    state: "fail",
    detail: `profile runs on the ${profile.harness} harness; the agent runs ${harness}`,
  };
}

function modelRow(profile: ModelProfile, harness: string | null): ProfileCheckRow {
  const judgeHarness = harness ?? profile.harness;
  const sections = runtimeHarnessSections();
  const mismatch = harnessModelMismatch(profile.model, judgeHarness, sections);
  if (mismatch) return { check: "model", state: "fail", detail: mismatch };
  if (!isHarnessModelJudged(judgeHarness)) {
    return {
      check: "model",
      state: "unverified",
      detail: `the model catalog does not judge ${judgeHarness} models`,
    };
  }
  if (
    profile.allowCustomModel &&
    !isAlias(profile.model) &&
    !isKnownCatalogModel(profile.model, sections)
  ) {
    return { check: "model", state: "unverified", detail: "custom model id" };
  }
  return { check: "model", state: "pass" };
}

function harnessCredentialsRow(
  agent: Agent,
  profile: ModelProfile,
  harness: string | null,
  agentHarness: string | null,
  pools: Map<string, string>,
): ProfileCheckRow {
  const report = agent.credStatus ?? null;
  const missing = [...new Set([...(report?.missing ?? []), ...(agent.credentialMissing ?? [])])];
  if (harness && agentHarness && harness !== agentHarness) {
    return {
      check: "harness-credentials",
      state: "unverified",
      detail: `the worker's credential report is for ${agentHarness}, not ${harness}`,
    };
  }
  if (report?.ready === false || (!report && missing.length > 0)) {
    return {
      check: "harness-credentials",
      state: "fail",
      detail: missing.length > 0 ? `missing ${missing.join(", ")}` : "worker reports not ready",
    };
  }
  if (!report) {
    return {
      check: "harness-credentials",
      state: "unverified",
      detail: "worker has not reported",
    };
  }
  // The key this model needs may differ from the one the worker checked
  // (helmcode/<id> on pi needs HELMCODE_API_KEY). The worker's container env
  // may still supply it, so absent from config is unverified, not fail.
  const judgeHarness = harness ?? profile.harness;
  if (MODEL_AWARE_CREDENTIAL_HARNESSES.has(judgeHarness)) {
    const vars = getModelAwareCredentialVars(judgeHarness, profile.model);
    const named = vars.join(" or ");
    if (!vars.some((v) => pools.has(v))) {
      return {
        check: "harness-credentials",
        state: "unverified",
        detail: `${profile.model} needs ${named}; not in the agent's config, so only the worker env can supply it`,
      };
    }
    return {
      check: "harness-credentials",
      state: "pass",
      detail: `${profile.model} uses ${named}`,
    };
  }
  return { check: "harness-credentials", state: "pass" };
}

/** Whether `api_key_status` has seen any of `suffixes` for `keyType`, at agent or global scope. */
async function keyStatusHasSuffix(
  agentId: string,
  keyType: string,
  suffixes: string[],
): Promise<boolean> {
  const row = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM api_key_status
      WHERE keyType = ?
        AND keySuffix IN (${suffixes.map(() => "?").join(", ")})
        AND ((scope = 'agent' AND scopeId = ?) OR scope = 'global')`,
    [keyType, ...suffixes, agentId],
  );
  return (row?.n ?? 0) > 0;
}

async function credentialAllowlistRow(
  agentId: string,
  allowlist: Record<string, string[]>,
  pools: Map<string, string>,
): Promise<ProfileCheckRow> {
  const states: ProfileCheckState[] = [];
  const details: string[] = [];
  for (const [envVar, wanted] of Object.entries(allowlist)) {
    const pool = pools.get(envVar);
    if (pool === undefined) {
      // Not in config: the worker env supplies it. Fall back to the key usage
      // the workers have reported.
      if (await keyStatusHasSuffix(agentId, envVar, wanted)) {
        states.push("pass");
      } else {
        states.push("unverified");
        details.push(`${envVar} is not in the agent's config and no worker reported a listed key`);
      }
      continue;
    }
    const have = new Set(splitCredentialPool(pool).map(keySuffix));
    const absent = wanted.filter((suffix) => !have.has(suffix));
    if (absent.length === wanted.length) {
      states.push("fail");
      details.push(`no ${envVar} key matches the allowlist (wanted ${wanted.join(", ")})`);
    } else if (absent.length > 0) {
      states.push("warn");
      details.push(`${envVar} has no key ending ${absent.join(", ")}`);
    } else {
      states.push("pass");
    }
  }
  return {
    check: "credential-allowlist",
    state: worst(states),
    ...(details.length > 0 ? { detail: details.join("; ") } : {}),
  };
}

/**
 * Judge whether `agentId` can run `profileName`. Null when the agent or the
 * profile does not exist. PR 2 has no fallbacks, so `profiles` holds the
 * primary only.
 */
export async function checkProfileForAgent(
  agentId: string,
  profileName: string,
  options: ProfileCheckOptions = {},
): Promise<ProfileCheckResult | null> {
  const [agent, profile] = await Promise.all([
    getAgentById(agentId),
    getModelProfileByName(profileName),
  ]);
  if (!agent || !profile) return null;
  const agentHarness = agent.harnessProvider ?? agent.provider ?? null;
  const harness = options.harness === undefined ? agentHarness : options.harness;
  const pools = await configPools(agentId, options);

  const checks: ProfileCheckRow[] = [
    harnessRow(profile, harness),
    modelRow(profile, harness),
    harnessCredentialsRow(agent, profile, harness, agentHarness, pools),
  ];
  if (profile.credentials) {
    checks.push(await credentialAllowlistRow(agentId, profile.credentials, pools));
  }
  const ok = !checks.some((row) => row.state === "fail");
  return { agentId, ok, profiles: [{ name: profile.name, ok, checks }] };
}

/** One line per failing row of the primary profile, for a gate's error message. */
export function formatProfileCheckFailures(result: ProfileCheckResult): string {
  const primary = result.profiles[0];
  if (!primary) return "";
  return primary.checks
    .filter((row) => row.state === "fail")
    .map(
      (row) =>
        `Model profile "${primary.name}" fails ${row.check}${row.detail ? `: ${row.detail}` : ""}`,
    )
    .join("\n");
}
