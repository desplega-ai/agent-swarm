import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { ensure, initialize } from "@desplega.ai/business-use";
import type { TemplateResponse } from "../../templates/schema.ts";
import {
  type Attributes,
  initOtel,
  injectTraceContext,
  isPollTracingEnabled,
  type SwarmSpan,
  startSpan,
  withSpan,
  withSpanContext,
} from "../otel.ts";
import { type BasePromptArgs, getBasePrompt } from "../prompts/base-prompt.ts";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  generateDefaultSoulMd,
  generateDefaultToolsMd,
} from "../prompts/defaults.ts";
import { renderMemoriesPrompt } from "../prompts/memories.ts";
import { configureHttpResolver, resolveTemplateAsync } from "../prompts/resolver.ts";
import { authJsonToCredentialSelection } from "../providers/codex-oauth/auth-json.js";
import { materializeCodexAuthJson } from "../providers/codex-oauth/auth-json-fs.js";
import { loadAllCodexOAuthSlots } from "../providers/codex-oauth/storage.js";
import {
  type CostData,
  createProviderAdapter,
  type ProviderEvent,
  type ProviderResult,
  type ProviderSession,
  type ProviderSessionConfig,
} from "../providers/index.ts";
import { initTelemetry, telemetry } from "../telemetry.ts";
import {
  type ProviderName,
  type ReasoningEffort,
  type RepoGuidelines,
  resolveTaskModelSelection,
} from "../types.ts";
import { getApiKey } from "../utils/api-key.ts";
import { computeBudgetBackoffMs } from "../utils/budget-backoff.ts";
import { getMcpBaseUrl } from "../utils/constants.ts";
import { getContextWindowSize } from "../utils/context-window.ts";
import { type CredentialSelection, resolveCredentialPools } from "../utils/credentials.ts";
import {
  isCodexCreditsExhaustedMessage,
  isRateLimitMessage,
  MAX_RATE_LIMIT_RESET_MS,
  parseRateLimitResetTime,
  type RateLimitWindowTelemetry,
  resolveCodexCreditsExhaustedCooldownMs,
} from "../utils/error-tracker.ts";
import { resolveHarnessProvider } from "../utils/harness-provider.ts";
import { prettyPrintLine, prettyPrintStderr } from "../utils/pretty-print.ts";
import { scrubSecrets } from "../utils/secret-scrubber.ts";
import { refreshSkillsIfChanged } from "../utils/skills-refresh.ts";
import { interpolate } from "../utils/template.ts";
import { detectVcsProvider } from "../vcs/index.ts";
import { validateJsonSchema } from "../workflows/json-schema-validator.ts";
import { buildContextPreamble, buildResumeContextPreamble } from "./context-preamble.ts";
import { awaitCredentials, BootMaxWaitExceededError, EX_CONFIG } from "./credential-wait.ts";
import {
  contentSha256,
  resolveClaudeMdPath,
  syncProfileFilesToServer,
  writeIdentityBaselines,
} from "./profile-sync.ts";
import {
  buildCredStatusReport,
  buildLatestModelReport,
  isBedrockSdkMode,
  isCredCheckDisabled,
  reportCredStatus,
  reportLatestModel,
} from "./provider-credentials.ts";
import {
  type ResumeSessionCandidate,
  type ResumeSessionResolution,
  resolveResumeSession,
} from "./resume-session.ts";
// Side-effect import: registers runner trigger/resumption templates
import "./templates.ts";

/** Throttle interval for progress updates (3 seconds). */
const PROGRESS_THROTTLE_MS = 3000;

/** Minimum spacing for explicit runner GC sweeps. */
const RUNNER_GC_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastRunnerGcAt = 0;

type GcCapableGlobal = typeof globalThis & { gc?: () => void };

function scheduleRunnerGc(reason: string): boolean {
  const gc = (globalThis as GcCapableGlobal).gc;
  if (typeof gc !== "function") return false;

  const now = Date.now();
  if (now - lastRunnerGcAt < RUNNER_GC_MIN_INTERVAL_MS) return false;
  lastRunnerGcAt = now;

  const timer = setTimeout(() => {
    const startedAt = Date.now();
    try {
      gc();
      console.log(`[runner] Explicit GC completed after ${reason} in ${Date.now() - startedAt}ms`);
    } catch (err) {
      console.warn(`[runner] Explicit GC failed after ${reason}: ${err}`);
    }
  }, 0);
  timer.unref?.();
  return true;
}

/** Save PM2 process list for persistence across container restarts */
async function savePm2State(role: string): Promise<void> {
  try {
    console.log(`[${role}] Saving PM2 process list...`);
    await Bun.$`pm2 save`.quiet();
    console.log(`[${role}] PM2 state saved`);
  } catch {
    // PM2 not available or no processes - silently ignore
  }
}

/** Fetch repo config for a task's vcsRepo (e.g., "desplega-ai/agent-swarm") */
async function fetchRepoConfig(
  apiUrl: string,
  apiKey: string,
  vcsRepo: string,
): Promise<{
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  hooks?: { enabled: boolean } | null;
  guidelines?: RepoGuidelines | null;
} | null> {
  try {
    const repoName = vcsRepo.split("/").pop() || vcsRepo;
    const resp = await fetch(`${apiUrl}/api/repos?name=${encodeURIComponent(repoName)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      repos: Array<{
        url: string;
        name: string;
        clonePath: string;
        defaultBranch: string;
        hooks?: { enabled: boolean } | null;
        guidelines?: RepoGuidelines | null;
      }>;
    };
    return data.repos.find((r) => r.url.includes(vcsRepo)) ?? data.repos[0] ?? null;
  } catch {
    return null;
  }
}

/** Read CLAUDE.md from a repo directory, returning null if not found */
async function readClaudeMd(clonePath: string, role: string): Promise<string | null> {
  const claudeMdFile = Bun.file(`${clonePath}/CLAUDE.md`);
  if (await claudeMdFile.exists()) {
    const content = await claudeMdFile.text();
    console.log(`[${role}] Read CLAUDE.md from ${clonePath}/CLAUDE.md (${content.length} chars)`);
    return content;
  }
  console.log(`[${role}] No CLAUDE.md found at ${clonePath}/CLAUDE.md`);
  return null;
}

export type SwarmAutostash = { ref: string; message: string };

async function listSwarmAutostashes(clonePath: string, role: string): Promise<SwarmAutostash[]> {
  try {
    const result =
      await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} stash list --format=%gd%x09%s`.quiet();
    return result
      .text()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("swarm-autostash"))
      .flatMap((line) => {
        const [ref, ...messageParts] = line.split("\t");
        if (!ref) return [];
        return [{ ref, message: messageParts.join("\t") || line }];
      });
  } catch (err) {
    console.warn(
      `[${role}] Could not inspect git stashes for ${clonePath}: ${scrubSecrets((err as Error).message)}`,
    );
    return [];
  }
}

/**
 * Continuation task types that must NEVER take the destructive hard-reset path,
 * even though they are not `taskType === "resume"`. Each of these ingress paths
 * creates a NEW task that CONTINUES/cooperates with existing work — often on the
 * same worker/reused clone — rather than starting genuinely fresh coding work:
 *  - "follow-up" / "reroute-decision": lead-owned continuations created by
 *    src/tasks/worker-follow-up.ts after a task completes/fails or needs
 *    re-delegation; they inherit the parent's vcsRepo/branch context via
 *    createTaskExtended's parentTaskId inheritance (src/be/db.ts).
 *  - "agentmail-reply": AgentMail follow-up on an EXISTING thread
 *    (src/agentmail/handlers.ts) — always carries `parentTaskId` pointing at
 *    the task it's continuing (as opposed to "agentmail-message", which fires
 *    only when no existing task was found for the thread).
 *  - "github-comment" / "github-review" / "gitlab-comment" / "gitlab-ci":
 *    tracker feedback on an ALREADY-OPEN PR/MR (review comments, review
 *    verdicts, CI failures) — the point is to keep working on the existing
 *    feature branch, not reset back to the default branch.
 */
const CONTINUATION_TASK_TYPES = new Set([
  "resume",
  "follow-up",
  "reroute-decision",
  "agentmail-reply",
  "github-comment",
  "github-review",
  "gitlab-comment",
  "gitlab-ci",
]);

/**
 * Task statuses under which a task may have already mutated the shared clone
 * (checked out a feature branch, left uncommitted/unpushed work) — or could
 * still be doing so concurrently, e.g. with `maxTasks > 1` on the same worker.
 * Mirrors the ACTIVE_TASK_STATUSES / getInProgressTasksByContextKey status
 * sets already used server-side (src/agentmail/handlers.ts, src/be/db.ts) for
 * the same "is this task still doing live work" question.
 */
const ACTIVE_PARENT_STATUSES = new Set<string>(["pending", "in_progress", "offered", "paused"]);

/**
 * A task is a "first kickoff" (safe to hard-reset the base branch) only when it
 * is BOTH (a) not an explicit continuation task-type and (b) not parent-linked
 * to a still-active task.
 *
 * `parentTaskId` alone is NOT a resume signal — send-task/trackers set it on
 * ~every dispatched child task (verified 395/395 real coding tasks carried one;
 * 0 were typed "resume"), so gating on its mere presence made the reset a no-op
 * in production (see git history on this function). But the *opposite*
 * over-correction — treating every non-"resume" task as a safe root kickoff —
 * is also wrong: several ingress paths create parent-linked NON-resume tasks
 * specifically to CONTINUE existing work, often on the same worker/reused
 * clone:
 *  - Slack follow-ups (src/slack/handlers.ts) wire `parentTaskId:
 *    latestTask?.id` with NO distinguishing taskType at all.
 *  - Sibling-awareness (src/tasks/sibling-awareness.ts, applied to every
 *    ingress via createTaskWithSiblingAwareness) wires `parentTaskId` to an
 *    in-progress same-agent sibling for session continuity — again with no
 *    reserved taskType.
 *  - AgentMail replies, tracker comments/reviews/CI events — see
 *    CONTINUATION_TASK_TYPES.
 * Since the first two carry no reserved taskType, a taskType denylist alone
 * cannot catch them — we ALSO check whether `parentTaskId` currently points at
 * a still-active task (ACTIVE_PARENT_STATUSES). If so, that parent/sibling may
 * hold a checked-out feature branch or unpushed/uncommitted work in the SAME
 * shared clone (especially with `maxTasks > 1`), so a hard reset there would
 * destroy it — take the non-destructive merge path instead.
 *
 * `fetchParentTaskStatus` is injected so this stays a pure, unit-testable
 * function; the real call site fetches `GET /api/tasks/{id}` (same pattern as
 * fetchProviderSessionInfo below).
 */
export async function isFirstKickoffTask(
  task?: { taskType?: string; parentTaskId?: string } | null,
  fetchParentTaskStatus?: (parentTaskId: string) => Promise<string | null | undefined>,
): Promise<boolean> {
  if (task?.taskType && CONTINUATION_TASK_TYPES.has(task.taskType)) return false;
  if (task?.parentTaskId && fetchParentTaskStatus) {
    const parentStatus = await fetchParentTaskStatus(task.parentTaskId);
    if (parentStatus && ACTIVE_PARENT_STATUSES.has(parentStatus)) return false;
  }
  return true;
}

/** Fetch a task's current status by id. Returns null on any failure (not-found, network, etc). */
async function fetchTaskStatus(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    const data = (await response.json()) as { status?: string };
    return data.status ?? null;
  } catch {
    return null;
  }
}

async function refreshExistingRepoForTask(
  repoConfig: { name: string; clonePath: string; defaultBranch: string },
  role: string,
  isFirstKickoff: boolean,
): Promise<string | null> {
  const { name, clonePath, defaultBranch } = repoConfig;
  const statusResult =
    await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} status --porcelain`.quiet();
  const statusOutput = statusResult.text().trim();
  let stashMessage: string | null = null;

  if (statusOutput !== "") {
    stashMessage = `swarm-autostash ${defaultBranch} ${new Date().toISOString()}`;
    try {
      console.log(`[${role}] Auto-stashing pending work in ${name}: ${stashMessage}`);
      await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} stash push --include-untracked -m ${stashMessage}`.quiet();
      console.log(`[${role}] Auto-stashed pending work in ${name}`);
    } catch (err) {
      const errorMsg = scrubSecrets((err as Error).message);
      console.warn(`[${role}] Could not auto-stash ${name}, skipping pull: ${errorMsg}`);
      return `The repo "${name}" at ${clonePath} has uncommitted changes, but auto-stash failed: ${errorMsg}. A git pull was skipped to avoid losing work.`;
    }
  }

  const fetchSpec = `${defaultBranch}:refs/remotes/origin/${defaultBranch}`;
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;

  try {
    await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} fetch origin ${fetchSpec}`.quiet();

    // First-kickoff guarantee (see call sites): the clone is REUSED task-to-task,
    // so a leftover feature branch from a prior task can still be checked out here.
    // On a genuine first kickoff (no parentTaskId / not a resume) we force the base
    // branch back to a clean, current state before the caller creates a work branch
    // off it — otherwise a diverged leftover branch would abort the merge below and
    // leave the repo stale (only a warning was emitted). Resumes and follow-up/child
    // tasks (which may legitimately still have that feature branch checked out with
    // in-progress work) must NEVER take this path — merge is the safe default there.
    if (isFirstKickoff) {
      console.log(`[${role}] First kickoff for ${name} — resetting to ${remoteRef}...`);
      try {
        await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} checkout ${defaultBranch}`.quiet();
      } catch {
        // Local branch may be missing (e.g. deleted by a prior task) — recreate it
        // tracking the remote instead of failing the whole refresh.
        await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} checkout -B ${defaultBranch} ${remoteRef}`.quiet();
      }
      await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} reset --hard ${remoteRef}`.quiet();
      console.log(`[${role}] Reset ${name} to ${remoteRef}`);
    } else {
      console.log(`[${role}] Refreshing ${name} from ${remoteRef}...`);
      await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} merge --no-edit --no-stat ${remoteRef}`.quiet();
      console.log(`[${role}] Refreshed ${name}`);
    }
    return null;
  } catch (err) {
    const errorMsg = scrubSecrets((err as Error).message);
    console.warn(`[${role}] Could not refresh ${name}: ${errorMsg}`);
    try {
      await Bun.$`env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX git -C ${clonePath} merge --abort`.quiet();
    } catch {
      // No merge in progress, or abort failed. The original refresh warning is
      // the actionable signal; repo setup remains best-effort.
    }
    const stashNote = stashMessage
      ? ` Pending work was preserved in git stash "${stashMessage}".`
      : "";
    return `The repo "${name}" at ${clonePath} could not be refreshed from origin/${defaultBranch}: ${errorMsg}.${stashNote}`;
  }
}

function getInstallRepoHooksScriptPath(): string {
  const imagePath = "/usr/local/bin/install-repo-hooks.sh";
  if (existsSync(imagePath)) return imagePath;
  return `${process.cwd()}/scripts/install-repo-hooks.sh`;
}

async function installRepoHooksForTask(
  repoConfig: { name: string; clonePath: string; hooks?: { enabled: boolean } | null },
  role: string,
): Promise<void> {
  if (repoConfig.hooks?.enabled !== true) return;

  try {
    const scriptPath = getInstallRepoHooksScriptPath();
    await Bun.$`bash ${scriptPath} ${repoConfig.clonePath} ${repoConfig.name}`;
    console.log(`[${role}] Installed git hooks for ${repoConfig.name}`);
  } catch (err) {
    const errorMsg = scrubSecrets((err as Error).message);
    console.warn(`[${role}] Could not install git hooks for ${repoConfig.name}: ${errorMsg}`);
  }
}

/**
 * Ensure a repo is cloned and up-to-date for a task.
 * Returns { clonePath, claudeMd, warning }.
 */
export async function ensureRepoForTask(
  repoConfig: {
    url: string;
    name: string;
    clonePath: string;
    defaultBranch: string;
    hooks?: { enabled: boolean } | null;
  },
  role: string,
  /**
   * True only for a genuine first kickoff (a brand-new task, not a resume and
   * not a follow-up/child task continuing prior work). Defaults to false —
   * when in doubt, do NOT force-reset the base branch, since the clone is
   * reused task-to-task and may hold another task's in-progress branch.
   */
  isFirstKickoff = false,
): Promise<{
  clonePath: string;
  claudeMd: string | null;
  warning: string | null;
  autoStashes: SwarmAutostash[];
}> {
  const { url, name, clonePath, defaultBranch } = repoConfig;

  try {
    const gitHeadExists = await Bun.file(`${clonePath}/.git/HEAD`).exists();

    let warning: string | null = null;

    if (!gitHeadExists) {
      console.log(`[${role}] Cloning ${name} to ${clonePath}...`);
      const provider = detectVcsProvider(url);
      if (provider === "github") {
        await Bun.$`gh repo clone ${url} ${clonePath} -- --branch ${defaultBranch} --single-branch`.quiet();
      } else if (provider === "gitlab") {
        await Bun.$`glab repo clone ${url} ${clonePath} -- --branch ${defaultBranch} --single-branch`.quiet();
      } else {
        await Bun.$`git clone --branch ${defaultBranch} --single-branch ${url} ${clonePath}`.quiet();
      }
      // Validate the clone actually created the directory
      if (!existsSync(clonePath)) {
        throw new Error(`Clone command succeeded but directory ${clonePath} does not exist`);
      }
      console.log(`[${role}] Cloned ${name}`);
    } else {
      console.log(`[${role}] Repo ${name} already cloned at ${clonePath}`);
      warning = await refreshExistingRepoForTask(
        { name, clonePath, defaultBranch },
        role,
        isFirstKickoff,
      );
    }

    await installRepoHooksForTask(repoConfig, role);

    const claudeMd = await readClaudeMd(clonePath, role);
    const autoStashes = await listSwarmAutostashes(clonePath, role);
    return { clonePath, claudeMd, warning, autoStashes };
  } catch (err) {
    const errorMsg = scrubSecrets((err as Error).message);
    console.warn(`[${role}] Error setting up repo ${name}: ${errorMsg}`);
    const warning = `Failed to clone/setup repo "${name}" at ${clonePath}: ${errorMsg}. The repo may not be available. You may need to clone it manually.`;
    // Only return clonePath if the directory actually exists (clone may have failed)
    const cloneExists = existsSync(clonePath);
    const autoStashes = cloneExists ? await listSwarmAutostashes(clonePath, role) : [];
    return { clonePath: cloneExists ? clonePath : "", claudeMd: null, warning, autoStashes };
  }
}

/** API configuration for ping/close */
export interface ApiConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
}

/** Ping the server to indicate activity and update status */
async function pingServer(config: ApiConfig, _role: string): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    await fetch(`${config.apiUrl}/ping`, {
      method: "POST",
      headers,
    });
  } catch {
    // Silently fail - server might not be running
  }
}

/** Mark agent as offline on shutdown */
async function closeAgent(config: ApiConfig, role: string): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    console.log(`[${role}] Marking agent as offline...`);
    await fetch(`${config.apiUrl}/close`, {
      method: "POST",
      headers,
    });
    console.log(`[${role}] Agent marked as offline`);
  } catch {
    // Silently fail - server might not be running
  }
}

/**
 * Fetch resolved config from the API and merge into a base env object.
 * Falls back to baseEnv on any error (network, parse, etc).
 * Credential env vars with comma-separated values get one randomly selected.
 */
interface ResolvedEnvResult {
  env: Record<string, string | undefined>;
  credentialSelections: CredentialSelection[];
  /**
   * Effective `HARNESS_PROVIDER` after layering swarm_config over the base
   * env. Callers should prefer this over `process.env.HARNESS_PROVIDER` so
   * that an operator's swarm_config row (repo > agent > global) actually
   * takes effect on the worker.
   */
  resolvedProvider: ProviderName;
}

async function fetchResolvedEnv(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  baseEnv: Record<string, string | undefined> = process.env,
  taskModel?: string,
): Promise<ResolvedEnvResult> {
  const env: Record<string, string | undefined> = { ...baseEnv };

  if (apiUrl && agentId) {
    try {
      const headers: Record<string, string> = { "X-Agent-ID": agentId };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const url = `${apiUrl}/api/config/resolved?agentId=${encodeURIComponent(agentId)}&includeSecrets=true`;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        console.warn(`[env-reload] Failed to fetch config: ${response.status}`);
      } else {
        const data = (await response.json()) as {
          configs: Array<{ key: string; value: string }>;
        };

        if (data.configs?.length) {
          for (const config of data.configs) {
            env[config.key] = config.value;
          }
          console.log(`[env-reload] Loaded ${data.configs.length} config entries from API`);
        }
      }
    } catch (error) {
      console.warn(`[env-reload] Could not fetch config, using current env: ${error}`);
    }
  }

  const resolvedProvider = resolveHarnessProvider(env, baseEnv);

  // Effective model: per-task model takes priority over the agent-level
  // MODEL_OVERRIDE from swarm_config. Passed to resolveCredentialPools so
  // the harness × model matrix can exclude incompatible credential vars
  // (e.g. OPENAI_API_KEY when an OpenRouter model is selected on opencode).
  const effectiveModel = taskModel || (env.MODEL_OVERRIDE as string | undefined) || "";

  const credentialSelections = await resolveCredentialPools(env, {
    apiUrl,
    apiKey,
    // Provider-aware selection: codex tasks should not get a
    // CLAUDE_CODE_OAUTH_TOKEN stamped on their task record (and vice
    // versa) just because both env vars happen to be set in the worker
    // container. See `PROVIDER_CREDENTIAL_VARS` in src/utils/credentials.ts.
    //
    // Use the resolved provider (swarm_config > env) so an operator can flip
    // the worker's harness from the dashboard without restarting the container.
    provider: resolvedProvider,
    model: effectiveModel,
  });

  return { env, credentialSelections, resolvedProvider };
}

async function ensureAgentFsCredentials(
  apiUrl: string,
  apiKey: string,
  agentId: string,
): Promise<void> {
  if (!apiUrl || !apiKey || !agentId || agentId === "unknown") return;

  try {
    const response = await fetch(`${apiUrl}/api/fs/agent-credentials`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(
        scrubSecrets(
          `[agent-fs] credential provisioning skipped: HTTP ${response.status}${text ? ` ${text}` : ""}`,
        ),
      );
      return;
    }
    const result = (await response.json().catch(() => ({}))) as {
      enabled?: boolean;
      created?: boolean;
    };
    if (result.enabled) {
      console.log(
        `[agent-fs] ${result.created ? "created" : "confirmed"} agent-scoped credentials`,
      );
    }
  } catch (error) {
    console.warn(scrubSecrets(`[agent-fs] credential provisioning skipped: ${error}`));
  }
}

/**
 * Keys we permit `applyResolvedEnvToProcessEnv` to mutate live.
 *
 * Anything not in this list is considered unsafe to overwrite post-boot:
 *
 * - **Boot-time identity / connectivity** (AGENT_ID, API_KEY, MCP_BASE_URL,
 *   AGENT_ROLE, MANAGED_*): mutating these mid-flight effectively makes the
 *   worker a different agent talking to a different API. Reboot, don't reload.
 * - **Credential pool members** (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
 *   OPENAI_API_KEY, etc.): `resolveCredentialPools` picks one randomly *per
 *   task* from a comma-separated pool. Persisting the picked value into
 *   process.env freezes the rotation. Re-resolution happens per spawn anyway,
 *   so we deliberately leave these alone.
 * - **Coordinated values with paired state** (HARNESS_PROVIDER): swapping
 *   the env without also swapping the adapter and rebuilding the system
 *   prompt produces an inconsistent worker. Handled by its own reconcile
 *   path that updates state.harnessProvider + adapter atomically.
 * - **Process-runtime / OS-level** (PATH, HOME, NODE_OPTIONS, HOSTNAME, …):
 *   never overwrite. Some of these are read once by libraries at boot.
 * - **Values memoized at boot** (TEMPLATE_ID, AGENT_NAME): the cached
 *   in-process value wins anyway — overwriting just creates confusion.
 *
 * For values that affect runner-loop behavior (like MAX_CONCURRENT_TASKS),
 * prefer mutating `RunnerState` directly — no round-trip through process.env.
 */
const RELOADABLE_ENV_KEYS: ReadonlySet<string> = new Set([
  "MODEL_OVERRIDE",
  "REASONING_EFFORT_OVERRIDE",
  "AGENT_FS_SHARED_ORG_ID",
  "BEDROCK_AUTH_MODE",
]);

/**
 * Apply a fresh resolved env to `process.env` for keys safe to mutate live.
 * Returns the list of keys that actually changed (useful for logging).
 */
function applyResolvedEnvToProcessEnv(freshEnv: Record<string, string | undefined>): string[] {
  const changed: string[] = [];
  for (const key of RELOADABLE_ENV_KEYS) {
    const next = freshEnv[key];
    if (next !== undefined && next !== process.env[key]) {
      process.env[key] = next;
      changed.push(key);
    }
  }
  return changed;
}

/** Compute effective max concurrent tasks from env > template default > role default. */
function resolveMaxConcurrent(
  env: Record<string, string | undefined>,
  templateMax: number | undefined,
  defaultMaxTasks: number,
): number {
  const raw = env.MAX_CONCURRENT_TASKS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return templateMax ?? defaultMaxTasks;
}

/** Tools that produce noise — skip auto-progress for these */
const SKIP_PROGRESS_TOOLS = new Set(["ToolSearch", "TodoRead", "TodoWrite"]);

/** Pretty labels for agent-swarm MCP tools. null = skip (meta/noise). */
const SWARM_TOOL_LABELS: Record<string, string | null> = {
  "store-progress": null,
  "get-task-details": "📋 Reviewing task details",
  "get-tasks": "📋 Checking task list",
  "poll-task": "📡 Polling for tasks",
  "send-task": "📤 Delegating task",
  "task-action": "⚡ Performing task action",
  "join-swarm": "🔗 Joining swarm",
  "my-agent-info": "🪪 Checking agent info",
  "get-swarm": "👥 Checking swarm status",
  "post-message": "💬 Sending message",
  "read-messages": "💬 Reading messages",
  "request-human-input": "🙋 Requesting human input",
  "cancel-task": "🚫 Cancelling task",
  "db-query": "🗃️ Querying database",
  "inject-learning": "🧠 Storing learning",
  "memory-search": "🧠 Searching memory",
  "memory-get": "🧠 Retrieving memory",
  "memory-delete": "🧠 Deleting memory",
  "update-profile": "🪪 Updating profile",
  // Users
  "manage-user": "👤 Managing user",
  "resolve-user": "👤 Resolving user",
  // Key-value store
  "kv-get": "🔑 Reading KV value",
  "kv-set": "🔑 Setting KV value",
  "kv-list": "🔑 Listing KV keys",
  "kv-delete": "🔑 Deleting KV value",
  "kv-incr": "🔑 Incrementing KV value",
  // Slack
  "slack-post": "💬 Posting to Slack",
  "slack-start-thread": "💬 Starting Slack thread",
  "slack-reply": "💬 Replying in Slack",
  "slack-read": "💬 Reading Slack",
  "slack-list-channels": "💬 Listing Slack channels",
  "slack-download-file": "📥 Downloading from Slack",
  "slack-upload-file": "📤 Uploading to Slack",
  // Tracker
  "tracker-status": "📊 Checking tracker status",
  "tracker-sync-status": "📊 Syncing tracker status",
  "tracker-link-task": "🔗 Linking task to tracker",
  "tracker-unlink": "🔗 Unlinking from tracker",
  "tracker-map-agent": "🔗 Mapping agent to tracker",
  // Workflows
  "trigger-workflow": "⚙️ Triggering workflow",
  "get-workflow": "⚙️ Checking workflow",
  "list-workflows": "⚙️ Listing workflows",
  "create-workflow": "⚙️ Creating workflow",
  "update-workflow": "⚙️ Updating workflow",
  "delete-workflow": "⚙️ Deleting workflow",
  "patch-workflow": "⚙️ Patching workflow",
  "patch-workflow-node": "⚙️ Patching workflow node",
  "get-workflow-run": "⚙️ Checking workflow run",
  "list-workflow-runs": "⚙️ Listing workflow runs",
  "cancel-workflow-run": "⚙️ Cancelling workflow run",
  "retry-workflow-run": "⚙️ Retrying workflow run",
  // Skills
  "skill-search": "🔎 Searching skills",
  "skill-install": "📦 Installing skill",
  "skill-install-remote": "📦 Installing remote skill",
  "skill-get": "📦 Getting skill details",
  "skill-list": "📦 Listing skills",
  "skill-create": "📦 Creating skill",
  "skill-update": "📦 Updating skill",
  "skill-delete": "📦 Deleting skill",
  "skill-publish": "📦 Publishing skill",
  "skill-uninstall": "📦 Uninstalling skill",
  "skill-sync-remote": "📦 Syncing remote skills",
  // Config
  "get-config": "⚙️ Reading config",
  "set-config": "⚙️ Setting config",
  "list-config": "⚙️ Listing config",
  "delete-config": "⚙️ Deleting config",
  // Schedules
  "create-schedule": "📅 Creating schedule",
  "list-schedules": "📅 Listing schedules",
  "run-schedule-now": "📅 Running schedule",
  "update-schedule": "📅 Updating schedule",
  "delete-schedule": "📅 Deleting schedule",
  // Context
  "context-diff": "📜 Viewing context diff",
  "context-history": "📜 Viewing context history",
  // Channels
  "create-channel": "📢 Creating channel",
  "list-channels": "📢 Listing channels",
  "delete-channel": "📢 Deleting channel",
  // Services
  "register-service": "🔌 Registering service",
  "list-services": "🔌 Listing services",
  "unregister-service": "🔌 Unregistering service",
  "update-service-status": "🔌 Updating service status",
  // Reusable scripts
  "script-search": "📜 Searching scripts",
  "script-run": "📜 Running script",
  "script-upsert": "📜 Saving script",
  "script-delete": "📜 Deleting script",
  "script-query-types": "📜 Reading script types",
};

/** Words that keep specific casing when humanizing tool names. */
const TOOL_NAME_ACRONYMS: Record<string, string> = {
  mcp: "MCP",
  kv: "KV",
  api: "API",
  url: "URL",
  id: "ID",
};

/**
 * Convert kebab/snake-case to sentence case, preserving known acronyms.
 * "get-task-details" → "Get task details"; "mcp-server-create" → "MCP server create".
 */
export function humanizeToolName(name: string): string {
  if (!name) return name;
  const words = name
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => TOOL_NAME_ACRONYMS[w.toLowerCase()] ?? w);
  const first = words[0];
  if (!first) return name;
  const head = TOOL_NAME_ACRONYMS[first.toLowerCase()]
    ? first
    : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...words.slice(1)].join(" ");
}

/**
 * Convert a tool call into a human-readable progress description.
 * Returns null for noisy/meta tools that should be skipped.
 */
export function toolCallToProgress(toolName: string, args: unknown): string | null {
  if (SKIP_PROGRESS_TOOLS.has(toolName)) return null;

  const a = args as Record<string, unknown>;
  const maybeMcpServer = typeof a?.server === "string" ? a.server : undefined;
  const maybeMcpTool = typeof a?.tool === "string" ? a.tool : undefined;
  const effectiveToolName =
    maybeMcpServer && maybeMcpTool ? `mcp__${maybeMcpServer}__${maybeMcpTool}` : toolName;
  if (SKIP_PROGRESS_TOOLS.has(effectiveToolName)) return null;

  // Normalize: pi-mono uses lowercase ("read"), Claude uses PascalCase ("Read")
  const normalized =
    effectiveToolName.startsWith("mcp__") || effectiveToolName.includes("_")
      ? effectiveToolName
      : effectiveToolName.charAt(0).toUpperCase() + effectiveToolName.slice(1);

  const shortPath = (p: unknown) => {
    if (typeof p !== "string") return "";
    // Show last 2 path segments for readability
    const parts = p.split("/");
    return parts.length > 2 ? parts.slice(-2).join("/") : p;
  };

  switch (normalized) {
    case "Read":
      return `📖 Reading ${shortPath(a.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `✏️ Editing ${shortPath(a.file_path)}`;
    case "Write":
      return `📝 Writing ${shortPath(a.file_path)}`;
    case "Bash":
      return a.description ? `⚡ ${a.description}` : "⚡ Running shell command";
    case "Grep":
      return `🔍 Searching for "${a.pattern}"`;
    case "Glob":
      return `📁 Finding files matching ${a.pattern}`;
    case "Agent":
    case "Task":
      return a.description ? `🤖 ${a.description}` : "🤖 Delegating sub-task";
    case "Skill":
      return `⚙️ Running /${a.skill}`;
    default: {
      // MCP tools: mcp__server__tool
      if (effectiveToolName.startsWith("mcp__")) {
        const parts = effectiveToolName.split("__");
        if (parts.length >= 3) {
          const server = parts[1];
          const tool = parts.slice(2).join("__");
          // Agent-swarm tools get pretty labels
          if (server === "agent-swarm") {
            const label = SWARM_TOOL_LABELS[tool];
            if (label === null) return null; // skip
            if (label) return label;
            return `🔌 ${humanizeToolName(tool)}`;
          }
          // Other MCP servers: "🔌 server: Humanized tool"
          return `🔌 ${server}: ${humanizeToolName(tool)}`;
        }
        return `🔌 ${effectiveToolName}`;
      }

      // Pi-mono exposes tools from the built-in swarm MCP endpoint as bare
      // names ("store-progress", "send-task", "script-run", ...), not as mcp__ names.
      // Treat those names as agent-swarm tools so activity stays readable.
      const label = SWARM_TOOL_LABELS[toolName];
      if (label === null) return null;
      if (label) return label;

      return `🔧 ${humanizeToolName(toolName)}`;
    }
  }
}

/**
 * Report task progress via the API (fire-and-forget).
 */
async function updateProgressViaAPI(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  progress: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    await fetch(`${apiUrl}/api/tasks/${taskId}/progress`, {
      method: "POST",
      headers,
      body: JSON.stringify({ progress }),
    });
  } catch {
    // Non-blocking — progress update failure is not critical
  }
}

/**
 * Ensure task is marked as completed or failed via the API.
 * This is called when a Claude process exits to ensure task status is updated,
 * regardless of whether the agent explicitly called store-progress.
 *
 * The API is idempotent - if the agent already marked the task as completed/failed,
 * this call will succeed without changing anything.
 */
/**
 * Attempt to extract structured output from a task's progress history
 * when the agent session ends without calling store-progress with valid output.
 *
 * - Claude adapter: runs a fallback extraction via `claude -p --json-schema`
 * - Pi-mono adapter: returns an error (no fallback available)
 */
export type FallbackResult =
  | { kind: "extracted"; output: string }
  | { kind: "already-has-output" }
  | { kind: "no-schema"; lastProgress?: string }
  | { kind: "schema-fail"; failReason: string }
  | { kind: "fetch-error"; error: string };

export async function handleStructuredOutputFallback(
  config: ApiConfig,
  taskId: string,
  adapterType: string,
): Promise<FallbackResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    // Fetch the task to check for outputSchema
    const taskRes = await fetch(`${config.apiUrl}/api/tasks/${taskId}`, { headers });
    if (!taskRes.ok) return { kind: "fetch-error", error: `HTTP ${taskRes.status}` };

    // Response is a flat spread of task fields + logs (see src/http/tasks.ts)
    const taskData = (await taskRes.json()) as {
      id?: string;
      task?: string;
      status?: string;
      output?: string;
      progress?: string;
      outputSchema?: Record<string, unknown>;
      logs?: Array<{ eventType: string; newValue?: string; createdAt?: string }>;
    };

    if (!taskData.outputSchema) {
      // No structured output required — extract last progress as context
      const lastProgressLog = (taskData.logs ?? [])
        .filter((l) => l.eventType === "task_progress")
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      const lastProgress = lastProgressLog?.newValue ?? taskData.progress;
      return { kind: "no-schema", lastProgress: lastProgress || undefined };
    }

    if (taskData.output) return { kind: "already-has-output" };

    if (adapterType !== "claude") {
      return {
        kind: "schema-fail",
        failReason:
          "Structured output required by outputSchema but not provided via store-progress",
      };
    }

    // Claude adapter fallback: extract structured data from progress history
    const progressLogs = (taskData.logs ?? [])
      .filter((l) => l.eventType === "task_progress")
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

    const progressEntries = progressLogs
      .map((log, i) => `${i + 1}. [${log.createdAt}] ${log.newValue}`)
      .join("\n");

    const extractionPrompt = `Extract structured data from this task's execution history.

## Task Description
${taskData.task || "(no description)"}

## Progress Updates (chronological)
${progressEntries || "(no progress recorded)"}

## Required Output Schema
${JSON.stringify(taskData.outputSchema, null, 2)}

Extract the structured data from the progress updates above. Return ONLY valid JSON matching the schema.`;

    const schemaJson = JSON.stringify(taskData.outputSchema);
    const result =
      await Bun.$`claude -p ${extractionPrompt} --json-schema ${schemaJson} --output-format json --model sonnet`
        .json()
        .catch(() => null);

    if (result && typeof result === "object") {
      return { kind: "extracted", output: JSON.stringify(result) };
    }

    return {
      kind: "schema-fail",
      failReason: "Structured output extraction fallback failed — could not produce valid JSON",
    };
  } catch (err) {
    console.warn(`[runner] Structured output fallback failed for task ${taskId}: ${err}`);
    return { kind: "fetch-error", error: String(err) };
  }
}

async function validateProviderOutputIfNeeded(
  config: ApiConfig,
  taskId: string,
  providerOutput: string,
): Promise<{ ok: true } | { ok: false; failReason: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const taskRes = await fetch(`${config.apiUrl}/api/tasks/${taskId}`, { headers });
    if (!taskRes.ok) {
      return { ok: true };
    }

    const taskData = (await taskRes.json()) as {
      outputSchema?: Record<string, unknown>;
    };
    if (!taskData.outputSchema || typeof taskData.outputSchema !== "object") {
      return { ok: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(providerOutput);
    } catch {
      return {
        ok: false,
        failReason:
          "Structured output required by outputSchema but provider output was not valid JSON",
      };
    }

    const validationErrors = validateJsonSchema(taskData.outputSchema, parsed);
    if (validationErrors.length > 0) {
      return {
        ok: false,
        failReason: `Structured output did not match outputSchema: ${validationErrors.join("; ")}`,
      };
    }
  } catch {
    return { ok: true };
  }

  return { ok: true };
}

export async function ensureTaskFinished(
  config: ApiConfig,
  role: string,
  taskId: string,
  exitCode: number,
  failureReason?: string,
  providerOutput?: string,
  /**
   * Active provider for this task. When provided, gates the structured-output
   * fallback path correctly even if `process.env.HARNESS_PROVIDER` differs
   * from the resolved swarm_config value. Falls back to env when omitted.
   */
  provider?: ProviderName,
): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  // Determine status and reason based on exit code
  // Exit code 0 = success, non-zero = failure
  let status = exitCode === 0 ? "completed" : "failed";
  const body: Record<string, string> = { status };

  if (status === "failed") {
    body.failureReason = failureReason || `Claude process exited with code ${exitCode}`;
  } else if (providerOutput) {
    const validation = await validateProviderOutputIfNeeded(config, taskId, providerOutput);
    if (validation.ok) {
      body.output = providerOutput;
    } else {
      status = "failed";
      body.status = "failed";
      body.failureReason = validation.failReason;
    }
  } else {
    // Try structured output fallback if the task has an outputSchema
    const adapterType = provider ?? process.env.HARNESS_PROVIDER ?? "claude";
    const fallback = await handleStructuredOutputFallback(config, taskId, adapterType);

    console.log(`[${role}] Task ${taskId.slice(0, 8)} fallback result: ${fallback.kind}`);

    switch (fallback.kind) {
      case "extracted":
        body.output = fallback.output;
        break;
      case "already-has-output":
        body.output = "Process completed successfully";
        break;
      case "no-schema": {
        if (fallback.lastProgress) {
          body.output = fallback.lastProgress.slice(0, 2000);
        } else {
          body.output = "Process completed successfully (no output captured)";
        }
        break;
      }
      case "schema-fail":
        status = "failed";
        body.status = "failed";
        body.failureReason = fallback.failReason;
        break;
      case "fetch-error":
        body.output = `Process completed (could not verify task state: ${fallback.error})`;
        break;
    }
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/finish`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const result = (await response.json()) as {
        alreadyFinished?: boolean;
        task?: { status?: string };
      };
      if (result.alreadyFinished) {
        console.log(
          `[${role}] Task ${taskId.slice(0, 8)} was already marked as ${result.task?.status || "finished"}`,
        );
      } else {
        console.log(
          `[${role}] Runner marked task ${taskId.slice(0, 8)} as ${status} (exit code: ${exitCode})`,
        );
      }
    } else if (response.status === 404) {
      console.log(`[${role}] Task ${taskId.slice(0, 8)} already finalized (not found), skipping`);
    } else {
      const error = await response.text();
      console.warn(
        `[${role}] Failed to finish task ${taskId.slice(0, 8)}: ${response.status} ${error}`,
      );
    }
  } catch (err) {
    console.warn(`[${role}] Error finishing task ${taskId.slice(0, 8)}: ${err}`);
  }
}

/** Report key usage to the API (fire-and-forget) */
async function reportKeyUsage(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  selection: CredentialSelection,
  taskId?: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/keys/report-usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        keyType,
        keySuffix: selection.keySuffix,
        keyIndex: selection.index,
        taskId,
      }),
    });
  } catch {
    // Non-blocking
  }
}

async function resolveCodexOAuthCredentialInfo(
  apiUrl?: string,
  apiKey?: string,
): Promise<CredentialSelection | null> {
  // Pool path: enumerate slots from the config store, pick one with rate-limit
  // awareness, materialise auth.json for the selected slot.
  if (apiUrl && apiKey) {
    try {
      const slots = await loadAllCodexOAuthSlots(apiUrl, apiKey);
      if (slots.length > 0) {
        let availableIndices: number[] | undefined;
        try {
          const resp = await fetch(
            `${apiUrl}/api/keys/available?keyType=CODEX_OAUTH&totalKeys=${slots.length}`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
          );
          if (resp.ok) {
            const data = (await resp.json()) as { availableIndices: number[] };
            availableIndices = data.availableIndices;
            if (availableIndices.length < slots.length) {
              console.log(
                `[credentials] CODEX_OAUTH: ${availableIndices.length}/${slots.length} slots available (${slots.length - availableIndices.length} rate-limited)`,
              );
            }
          }
        } catch {
          // Non-critical — fall through to random selection
        }

        const allSlotIndices = slots.map((s) => s.slot);
        let selectedSlot: number;
        if (availableIndices && availableIndices.length > 0) {
          const eligible = allSlotIndices.filter((i) => availableIndices!.includes(i));
          const pool = eligible.length > 0 ? eligible : allSlotIndices;
          selectedSlot = pool[Math.floor(Math.random() * pool.length)]!;
        } else {
          // No availability info or all rate-limited — pick randomly (best effort)
          selectedSlot = allSlotIndices[Math.floor(Math.random() * allSlotIndices.length)]!;
        }

        const slotEntry = slots.find((s) => s.slot === selectedSlot);
        if (slotEntry) {
          // Pool slots are shared across concurrent tasks: never hand the
          // spawned Codex CLI a refresh token it could rotate outside the
          // `/api/oauth/refresh-locks` lock (see `credentialsToAuthJson`).
          await materializeCodexAuthJson(selectedSlot, slotEntry.creds, {
            includeRefreshToken: false,
          });
          const authJson = {
            auth_mode: "chatgpt" as const,
            OPENAI_API_KEY: null,
            tokens: {
              id_token: slotEntry.creds.access,
              access_token: slotEntry.creds.access,
              refresh_token: slotEntry.creds.refresh,
              account_id: slotEntry.creds.accountId,
            },
            last_refresh: new Date(slotEntry.creds.expires).toISOString(),
          };
          const sel = authJsonToCredentialSelection(authJson, selectedSlot, slots.length);
          console.log(
            `[credentials] Selected CODEX_OAUTH slot ${selectedSlot + 1}/${slots.length} [...${sel.keySuffix}]`,
          );
          return sel;
        }
      }
    } catch (err) {
      console.warn(`[credentials] Codex OAuth pool selection failed (non-fatal): ${err}`);
    }
  }

  // Fallback: read existing auth.json (single-credential or pre-pool deploy)
  try {
    const home = process.env.HOME;
    if (!home) return null;

    const authFile = Bun.file(`${home}/.codex/auth.json`);
    if (!(await authFile.exists())) {
      return null;
    }

    const auth = JSON.parse(await authFile.text()) as {
      auth_mode?: string;
      tokens?: { account_id?: string };
    };

    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.account_id) {
      return null;
    }

    return authJsonToCredentialSelection(
      auth as Parameters<typeof authJsonToCredentialSelection>[0],
    );
  } catch {
    return null;
  }
}

/** Report a rate-limited key to the API (fire-and-forget) */
async function reportKeyRateLimit(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/keys/report-rate-limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        keyType,
        keySuffix,
        keyIndex,
        rateLimitedUntil,
      }),
    });
    console.log(
      `[credentials] Reported key ...${keySuffix} as rate-limited until ${rateLimitedUntil}`,
    );
  } catch {
    // Non-blocking
  }
}

async function reportKeyRateLimitWindows(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  windows: RateLimitWindowTelemetry,
): Promise<void> {
  if (Object.keys(windows).length === 0) return;
  try {
    await fetch(`${apiUrl}/api/keys/report-rate-limit-windows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        keyType,
        keySuffix,
        keyIndex,
        windows,
      }),
    });
    console.log(`[credentials] Reported rate-limit windows for key ...${keySuffix}`);
  } catch {
    // Non-blocking
  }
}

/** Clear a stale rate-limit record after a successful task (fire-and-forget) */
async function reportKeyClearRateLimit(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
): Promise<void> {
  try {
    const resp = await fetch(`${apiUrl}/api/keys/clear-rate-limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ keyType, keySuffix }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { cleared?: boolean };
      if (data.cleared) {
        console.log(
          `[credentials] Cleared stale rate-limit for ...${keySuffix} after successful task`,
        );
      }
    }
  } catch {
    // Non-blocking
  }
}

/**
 * Supersede a task via the API (for graceful shutdown / context-limit /
 * operator-triggered). Returns `{ ok: true, resumeTaskId }` on success.
 * On 5xx / network failure returns `{ ok: false }` so the caller can fall
 * back to the legacy `pauseTaskViaAPI` (handles partial-deploy windows where
 * the API is older than the worker).
 */
async function supersedeTaskViaAPI(
  config: ApiConfig,
  role: string,
  taskId: string,
  reason: "graceful_shutdown" | "context_limits" | "manual_supersede",
): Promise<{ ok: true; resumeTaskId: string | null; kind: string } | { ok: false }> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/supersede`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason }),
    });

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        resumeTaskId?: string | null;
        kind?: string;
      } | null;
      const resumeTaskId = body?.resumeTaskId ?? null;
      const kind = body?.kind ?? "resumed";
      console.log(
        `[${role}] Task ${taskId.slice(0, 8)} superseded (kind=${kind}, resume=${
          resumeTaskId ? resumeTaskId.slice(0, 8) : "none"
        })`,
      );
      return { ok: true, resumeTaskId, kind };
    }

    // 404 / 405 — the route doesn't exist on this API server. Happens during
    // partial deploys (new worker rolled out before new API). Fall back to
    // legacy pause so the task isn't left orphaned in_progress until heartbeat
    // recovery picks it up minutes later.
    if (response.status === 404 || response.status === 405) {
      console.warn(
        `[${role}] Supersede route missing for task ${taskId.slice(0, 8)} (${response.status}); falling back to pause`,
      );
      return { ok: false };
    }

    // Other 4xx → deliberate rejection from a current API (bad request,
    // idempotent no-op, forbidden, conflict). Do NOT fall back to legacy
    // pause — the API actively rejected the supersede, retrying via pause
    // would be wrong.
    if (response.status >= 400 && response.status < 500) {
      const error = await response.text();
      console.warn(
        `[${role}] Supersede rejected for task ${taskId.slice(0, 8)}: ${response.status} ${error}`,
      );
      return { ok: true, resumeTaskId: null, kind: "rejected" };
    }

    // 5xx → fall through to legacy pause.
    const error = await response.text();
    console.warn(
      `[${role}] Supersede failed for task ${taskId.slice(0, 8)}: ${response.status} ${error}`,
    );
    return { ok: false };
  } catch (err) {
    console.warn(`[${role}] Error superseding task ${taskId.slice(0, 8)}: ${err}`);
    return { ok: false };
  }
}

/**
 * Pause a task via the API (for graceful shutdown).
 * Unlike marking as failed, paused tasks can be resumed after container restart.
 */
async function pauseTaskViaAPI(config: ApiConfig, role: string, taskId: string): Promise<boolean> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/pause`, {
      method: "POST",
      headers,
    });

    if (response.ok) {
      console.log(`[${role}] Task ${taskId.slice(0, 8)} paused for graceful shutdown`);
      return true;
    } else {
      const error = await response.text();
      console.warn(
        `[${role}] Failed to pause task ${taskId.slice(0, 8)}: ${response.status} ${error}`,
      );
      return false;
    }
  } catch (err) {
    console.warn(`[${role}] Error pausing task ${taskId.slice(0, 8)}: ${err}`);
    return false;
  }
}

/** Fetch paused tasks from API for this agent */
async function getPausedTasksFromAPI(config: ApiConfig): Promise<
  Array<{
    id: string;
    task: string;
    progress?: string;
    claudeSessionId?: string;
    provider?: ProviderName;
    providerMeta?: Record<string, unknown>;
    parentTaskId?: string;
    dir?: string;
    vcsRepo?: string;
    finishedAt?: string;
    output?: string;
    status?: string;
    contextKey?: string;
  }>
> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/paused-tasks`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to fetch paused tasks: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      tasks: Array<{
        id: string;
        task: string;
        progress?: string;
        claudeSessionId?: string;
        provider?: ProviderName;
        providerMeta?: Record<string, unknown>;
        parentTaskId?: string;
        dir?: string;
        vcsRepo?: string;
        finishedAt?: string;
        output?: string;
        status?: string;
      }>;
    };
    return data.tasks || [];
  } catch (error) {
    console.warn(`[runner] Error fetching paused tasks: ${error}`);
    return [];
  }
}

/** Resume a task via API (marks as in_progress) */
async function resumeTaskViaAPI(config: ApiConfig, taskId: string): Promise<boolean> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/resume`, {
      method: "POST",
      headers,
    });

    return response.ok;
  } catch {
    return false;
  }
}

/** Build prompt for a resumed task */
async function buildResumePrompt(
  task: { id: string; task: string; progress?: string },
  fmt: (cmd: string) => string = (cmd) => `/${cmd}`,
  options?: { hasMcp?: boolean },
): Promise<string> {
  const hasMcp = options?.hasMcp !== false;
  const completionInstructions = hasMcp
    ? '\n\nWhen done, use `store-progress` with status: "completed" and include your output.'
    : "";
  if (task.progress) {
    const result = await resolveTemplateAsync("task.resumption.with_progress", {
      work_on_task_cmd: hasMcp ? fmt("work-on-task") : "",
      task_id: hasMcp ? task.id : "",
      task_description: task.task,
      progress: task.progress,
      completion_instructions: completionInstructions,
    });
    return result.text;
  }

  const result = await resolveTemplateAsync("task.resumption.no_progress", {
    work_on_task_cmd: hasMcp ? fmt("work-on-task") : "",
    task_id: hasMcp ? task.id : "",
    task_description: task.task,
    completion_instructions: completionInstructions,
  });
  return result.text;
}

/** Setup signal handlers for graceful shutdown */
function setupShutdownHandlers(
  role: string,
  apiConfig?: ApiConfig,
  getRunnerState?: () => RunnerState | undefined,
): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[${role}] Received ${signal}, shutting down...`);

    // Wait for active tasks with timeout
    const state = getRunnerState?.();
    if (state && state.activeTasks.size > 0) {
      const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT || "30000", 10);
      console.log(
        `[${role}] Waiting for ${state.activeTasks.size} active tasks to complete (${shutdownTimeout / 1000}s timeout)...`,
      );
      const deadline = Date.now() + shutdownTimeout;

      while (state.activeTasks.size > 0 && Date.now() < deadline) {
        await checkCompletedProcesses(state, role, apiConfig);
        if (state.activeTasks.size > 0) {
          await Bun.sleep(500);
        }
      }

      // Force kill remaining tasks and supersede them so a fresh "resume"
      // follow-up can pick up the work on any worker. Fallback chain:
      //   1. supersedeTaskViaAPI (primary)
      //   2. pauseTaskViaAPI (legacy — preserves graceful behavior during
      //      partial-deploy windows where the API server is older than the
      //      worker)
      //   3. ensureTaskFinished (mark as failed — last resort)
      if (state.activeTasks.size > 0) {
        console.log(
          `[${role}] Superseding ${state.activeTasks.size} remaining task(s) for resume after restart...`,
        );
        for (const [taskId, task] of state.activeTasks) {
          console.log(`[${role}] Superseding task ${taskId.slice(0, 8)}`);
          task.session.abort("graceful_shutdown").catch(() => {});
          if (apiConfig) {
            const supersede = await supersedeTaskViaAPI(
              apiConfig,
              role,
              taskId,
              "graceful_shutdown",
            );
            if (supersede.ok) {
              continue;
            }
            // 5xx / network failure → try legacy pause for partial-deploy windows.
            const paused = await pauseTaskViaAPI(apiConfig, role, taskId);
            if (!paused) {
              console.warn(
                `[${role}] Both supersede and pause failed for task ${taskId.slice(0, 8)}, marking as failed instead`,
              );
              await ensureTaskFinished(
                apiConfig,
                role,
                taskId,
                1,
                undefined,
                undefined,
                state.harnessProvider,
              );
            }
          }
        }
      }
    }

    if (apiConfig) {
      telemetry.session("ended", {
        agentId: apiConfig.agentId,
        durationMs: state ? Date.now() - state.startedAt : undefined,
        tasksProcessed: state?.tasksProcessed ?? 0,
      });
      await closeAgent(apiConfig, role);
    }
    await savePm2State(role);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Configuration for a runner role (worker or lead) */
export interface RunnerConfig {
  /** Role name for logging, e.g., "worker" or "lead" */
  role: string;
  /** Default prompt if none provided */
  defaultPrompt: string;
  /** Metadata type for log files, e.g., "worker_metadata" */
  metadataType: string;
  /** Optional capabilities of the agent */
  capabilities?: string[];
}

export interface RunnerOptions {
  prompt?: string;
  yolo?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  logsDir?: string;
  additionalArgs?: string[];
}

/** Running task state for parallel execution */
interface RunningTask {
  taskId: string;
  session: ProviderSession;
  logFile: string;
  startTime: Date;
  promise: Promise<ProviderResult>;
  /** The trigger type that caused this task to be spawned */
  triggerType?: string;
  /** Set when the promise resolves, enabling non-blocking completion checks */
  result: ProviderResult | null;
  /** Deferred cursor updates for channel_activity triggers — committed after success */
  cursorUpdates?: Array<{ channelId: string; ts: string }>;
  /** Resolved working directory for VCS detection */
  workingDir?: string;
  /** Credential tracking: which key was used for this task */
  credentialInfo?: {
    keyType: string;
    keySuffix: string;
    keyIndex: number;
  };
  /**
   * Harness provider this session was actually spawned/resumed on, snapshotted
   * at spawn time. The runner lets in-flight sessions finish on their original
   * adapter after a live provider swap, so the session-end profile sync must
   * decide based on THIS value — not the mutable global `state.harnessProvider`.
   */
  harnessProvider: ProviderName;
  /**
   * Whether this session ran in a local `/workspace` environment, snapshotted
   * from `adapter.traits.hasLocalEnvironment` at spawn time. Gates the
   * session-end FS → DB profile sync per finished session (a session that
   * started local must still sync even if the worker was swapped to a remote
   * provider before it completed, and vice versa).
   */
  hasLocalEnvironment: boolean;
  /** Harness variant captured on session_init (e.g. "stock") */
  harnessVariant?: string;
  /** Harness metadata captured on session_init (currently includes provider package version) */
  harnessVariantMeta?: Record<string, unknown>;
  /** Resolved model used for the provider session, when configured */
  model?: string;
}

/** Runner state for tracking concurrent tasks */
interface RunnerState {
  activeTasks: Map<string, RunningTask>;
  maxConcurrent: number;
  startedAt: number;
  tasksProcessed: number;
  /**
   * Effective harness provider for this worker boot session — resolved
   * from `swarm_config` (overlay) > `process.env.HARNESS_PROVIDER` > "claude".
   * Used by error / cleanup paths so the structured-output fallback runs the
   * right adapter even when env disagrees with swarm_config. Section 4
   * (per-task live re-resolution) will mutate this between tasks.
   */
  harnessProvider: ProviderName;
  /**
   * Effective Codex credits-exhausted cooldown (ms), resolved from `swarm_config`
   * (key `CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS`) > default 2h constant, clamped to
   * [5m, 7d]. Reconciled live by `applySwarmConfigDrift` — read at the cooldown
   * application site so a fresh value applies to the next credits-exhausted failure.
   */
  codexCreditsExhaustedCooldownMs: number;
}

/** Buffer for session logs */
interface LogBuffer {
  lines: string[];
  lastFlush: number;
  partialLine: string; // Accumulates incomplete line across chunks
}

/** Configuration for log streaming */
const LOG_BUFFER_SIZE = 50; // Flush after this many lines
const LOG_FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds

/** Push buffered logs to the API */
async function flushLogBuffer(
  buffer: LogBuffer,
  opts: {
    apiUrl: string;
    apiKey: string;
    agentId: string;
    sessionId: string;
    iteration: number;
    taskId?: string;
    cli?: string;
  },
): Promise<void> {
  if (buffer.lines.length === 0) return;

  // Snapshot and clear buffer immediately to prevent duplicate flushes
  // (fire-and-forget callers would otherwise race on the same buffer)
  const lines = buffer.lines;
  buffer.lines = [];
  buffer.lastFlush = Date.now();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  try {
    const response = await fetch(`${opts.apiUrl}/api/session-logs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: opts.sessionId,
        iteration: opts.iteration,
        taskId: opts.taskId,
        cli: opts.cli || "claude",
        lines,
      }),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to push logs: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error pushing logs: ${error}`);
  }
}

/** Save session cost data to the API */
async function saveCostData(cost: CostData, apiUrl: string, apiKey: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": cost.agentId,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(`${apiUrl}/api/session-costs`, {
      method: "POST",
      headers,
      body: JSON.stringify(cost),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to save cost data: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error saving cost data: ${error}`);
  }
}

/** Save Claude session ID for a task (fire-and-forget) */
async function saveProviderSessionId(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  claudeSessionId: string,
  provider?: ProviderName,
  providerMeta?: Record<string, unknown>,
  model?: string,
  harnessVariant?: string,
  harnessVariantMeta?: Record<string, unknown>,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body: Record<string, unknown> = { claudeSessionId };
  if (provider !== undefined) body.provider = provider;
  if (providerMeta !== undefined) body.providerMeta = providerMeta;
  if (model !== undefined && model !== "") body.model = model;
  if (harnessVariant !== undefined) body.harnessVariant = harnessVariant;
  if (harnessVariantMeta !== undefined) body.harnessVariantMeta = harnessVariantMeta;
  await fetch(`${apiUrl}/api/tasks/${taskId}/session`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

/** Cache of tasks that already have VCS linked — prevents repeated gh pr list calls */
const vcsDetectedTasks = new Set<string>();

/** Throttle timestamps for periodic VCS checks per task */
const vcsCheckTimestamps = new Map<string, number>();
const VCS_CHECK_INTERVAL = 60_000; // 60 seconds

/**
 * Detect if the task's working directory has an open PR for the current branch.
 * If found, report VCS info to the API so webhook events can link back to this task.
 */
async function detectVcsForTask(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  workingDir: string,
): Promise<void> {
  try {
    // 1. Check if inside a git repo
    const isGit = await Bun.$`git -C ${workingDir} rev-parse --is-inside-work-tree`.quiet().text();
    if (isGit.trim() !== "true") return;

    // 2. Get current branch
    const branch = (await Bun.$`git -C ${workingDir} branch --show-current`.quiet().text()).trim();
    if (!branch || branch === "main" || branch === "master") return;

    // 3. Get remote URL to determine provider and repo
    const remoteUrl = (
      await Bun.$`git -C ${workingDir} remote get-url origin`.quiet().text()
    ).trim();

    // 4. Detect provider and check for PR/MR
    let vcsProvider: "github" | "gitlab";
    let prJson: string;

    if (remoteUrl.includes("github.com") || remoteUrl.includes("github")) {
      vcsProvider = "github";
      prJson = (
        await Bun.$`gh pr list --head ${branch} --json number,url --limit 1`.quiet().text()
      ).trim();
    } else if (remoteUrl.includes("gitlab")) {
      vcsProvider = "gitlab";
      prJson = (
        await Bun.$`glab mr list --source-branch ${branch} --json iid,web_url --per-page 1`
          .quiet()
          .text()
      ).trim();
    } else {
      return; // Unknown provider
    }

    // 5. Parse result
    const prs = JSON.parse(prJson);
    if (!Array.isArray(prs) || prs.length === 0) return;

    const pr = prs[0];
    const vcsNumber = pr.number ?? pr.iid;
    const vcsUrl = pr.url ?? pr.web_url;
    if (!vcsNumber || !vcsUrl) return;

    // 6. Extract repo from remote URL
    const repoMatch = remoteUrl.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (!repoMatch) return;
    const vcsRepo = repoMatch[1];

    // 7. Report to API
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    await fetch(`${apiUrl}/api/tasks/${taskId}/vcs`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ vcsProvider, vcsRepo, vcsNumber, vcsUrl }),
    });

    vcsDetectedTasks.add(taskId);
    console.log(
      `[VCS] Linked task ${taskId.slice(0, 8)} to ${vcsProvider} ${vcsRepo}#${vcsNumber}`,
    );
  } catch {
    // Fire-and-forget — detection failure should never block task execution
  }
}

/** Save provider session ID on the active session (for pool tasks where realTaskId is unknown) */
async function saveProviderSessionIdOnActiveSession(
  apiUrl: string,
  apiKey: string,
  effectiveTaskId: string,
  providerSessionId: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  await fetch(`${apiUrl}/api/active-sessions/provider-session/${effectiveTaskId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ providerSessionId }),
  });
}

interface ProviderSessionInfo {
  sessionId: string | null;
  provider?: ProviderName;
  providerMeta?: Record<string, unknown>;
}

/** Fetch provider session metadata for a task (for resume continuity). */
async function fetchProviderSessionInfo(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<ProviderSessionInfo | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      claudeSessionId?: string;
      provider?: ProviderName;
      providerMeta?: Record<string, unknown>;
    };
    return {
      sessionId: data.claudeSessionId || null,
      provider: data.provider,
      providerMeta: data.providerMeta,
    };
  } catch {
    return null;
  }
}

function logResumeResolution(role: string, resolution: ResumeSessionResolution): void {
  for (const skipped of resolution.skipped) {
    console.warn(
      `[${role}] Skipping ${skipped.source} session resume ${skipped.sessionId.slice(0, 8)}: ${skipped.reason}`,
    );
  }

  if (resolution.resumeSessionId) {
    const source = resolution.source === "parent" ? "parent session" : "task's own session";
    console.log(`[${role}] Resuming ${source} ${resolution.resumeSessionId.slice(0, 8)}`);
  }
}

/** Register an active session with the API (fire-and-forget) */
async function registerActiveSession(
  config: ApiConfig,
  session: {
    taskId: string;
    triggerType: string;
    taskDescription?: string;
    runnerSessionId?: string;
  },
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    await fetch(`${config.apiUrl}/api/active-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agentId: config.agentId,
        taskId: session.taskId,
        triggerType: session.triggerType,
        taskDescription: session.taskDescription,
        runnerSessionId: session.runnerSessionId,
      }),
    });
  } catch {
    // Non-blocking — session tracking is best-effort
  }
}

/** Remove an active session by taskId (fire-and-forget) */
async function removeActiveSession(config: ApiConfig, taskId: string): Promise<void> {
  const headers: Record<string, string> = { "X-Agent-ID": config.agentId };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    await fetch(`${config.apiUrl}/api/active-sessions/by-task/${taskId}`, {
      method: "DELETE",
      headers,
    });
  } catch {
    // Non-blocking
  }
}

/** Clean up all active sessions for this agent (on startup) */
async function cleanupActiveSessions(config: ApiConfig): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    await fetch(`${config.apiUrl}/api/active-sessions/cleanup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: config.agentId }),
    });
  } catch {
    // Non-blocking
  }
}

/** Reset orphaned in-progress tasks for this agent back to pending dispatch. */
async function recoverOrphanedInProgressTasks(config: ApiConfig): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    const response = await fetch(`${config.apiUrl}/api/active-sessions/recover-orphaned-tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: config.agentId, minAgeSeconds: 60 }),
    });
    if (!response.ok) {
      console.warn(`[runner] Failed to recover orphaned tasks: ${response.status}`);
      return 0;
    }
    const data = (await response.json()) as { recovered?: number };
    return data.recovered ?? 0;
  } catch (error) {
    console.warn(`[runner] Error recovering orphaned tasks: ${error}`);
    return 0;
  }
}

/** Trigger a heartbeat sweep via the API (lead startup self-check) */
async function triggerHeartbeatSweep(config: ApiConfig): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": config.agentId,
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const resp = await fetch(`${config.apiUrl}/api/heartbeat/sweep`, {
      method: "POST",
      headers,
    });
    return resp.ok;
  } catch (err) {
    console.warn(`[runner] Failed to trigger heartbeat sweep: ${(err as Error).message}`);
    return false;
  }
}

/** Trigger types returned by the poll API */
interface Trigger {
  type:
    | "task_assigned"
    | "task_offered"
    | "unread_mentions"
    | "pool_tasks_available"
    | "channel_activity"
    | "budget_refused";
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
  tasks?: Array<{
    id: string;
    agentId?: string;
    task: string;
    status: string;
    output?: string;
    failureReason?: string;
    slackChannelId?: string;
  }>;
  messages?: Array<{
    id: string;
    content: string;
    channelId?: string;
    channelName?: string;
    ts?: string;
    user?: string;
    text?: string;
  }>;
  cursorUpdates?: Array<{ channelId: string; ts: string }>; // Deferred cursor commits for channel_activity
  requestedBy?: { name: string; email?: string; role?: string; notes?: string };
  // Phase 4 — budget_refused fields. The server emits this envelope from
  // /api/poll and MCP task-action accept when an admission gate refuses to
  // let the agent claim a task. Worker reads cause + reset/spend/budget for
  // structured logging and back-off; never reaches buildPromptForTrigger.
  cause?: "agent" | "global";
  agentSpend?: number;
  agentBudget?: number;
  globalSpend?: number;
  globalBudget?: number;
  resetAt?: string; // ISO 8601, next UTC midnight
}

/** Options for polling */
interface PollOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  pollInterval: number;
  pollTimeout: number;
  since?: string; // Optional: for filtering finished tasks
}

type RequesterProfile = NonNullable<Trigger["requestedBy"]>;

export async function buildRequesterProfilePrompt(
  requestedBy: RequesterProfile | undefined,
): Promise<string> {
  if (!requestedBy?.role && !requestedBy?.notes) return "";

  const notes = requestedBy.notes?.trim();
  const notesSection = notes
    ? `\nTheir stated notes for how you should respond and act:\n${notes}`
    : "";
  const result = await resolveTemplateAsync("task.requester.profile", {
    requester_name: requestedBy.name,
    requester_role_suffix: requestedBy.role ? ` (${requestedBy.role})` : "",
    requester_notes_section: notesSection,
  });

  return result.skipped ? "" : result.text.trim();
}

/** Register agent via HTTP API */
async function registerAgent(opts: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  name: string;
  isLead: boolean;
  role?: string;
  capabilities?: string[];
  maxTasks?: number;
  /**
   * Resolved harness provider (swarm_config > env > "claude"). Sent as both
   * the legacy `provider` field and the canonical `harness_provider` column.
   * Defaults to `process.env.HARNESS_PROVIDER || "claude"` for callers that
   * haven't migrated to passing it explicitly.
   */
  harnessProvider?: ProviderName;
}): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  const provider: ProviderName =
    opts.harnessProvider ?? ((process.env.HARNESS_PROVIDER || "claude") as ProviderName);

  // Phase 1.5 (cloud-personalization): also push the canonical
  // `harness_provider` field so the API can persist it in its own column
  // (`agents.harness_provider`). Always send the resolved provider value
  // (defaulting to "claude" when HARNESS_PROVIDER is unset) so agents that
  // don't explicitly set the env var still self-report instead of leaving
  // the column NULL — matches how `provider` already defaults above.
  const harnessProvider: ProviderName = provider;

  const response = await fetch(`${opts.apiUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: opts.name,
      isLead: opts.isLead,
      role: opts.role,
      capabilities: opts.capabilities,
      maxTasks: opts.maxTasks,
      provider,
      harness_provider: harnessProvider,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register agent: ${response.status} ${error}`);
  }
}

/** Poll for triggers via HTTP API */
async function pollForTrigger(opts: PollOptions): Promise<Trigger | null> {
  if (!isPollTracingEnabled()) {
    return pollForTriggerOnce(opts);
  }
  return withSpan(
    "worker.poll",
    async (span) => {
      const trigger = await pollForTriggerOnce(opts);
      span.setAttribute("agentswarm.poll.result", trigger ? trigger.type : "empty");
      return trigger;
    },
    {
      "agent.id": opts.agentId,
      "agentswarm.worker.poll_timeout_ms": opts.pollTimeout,
      "agentswarm.worker.poll_interval_ms": opts.pollInterval,
    },
  );
}

async function pollForTriggerOnce(opts: PollOptions): Promise<Trigger | null> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  injectTraceContext(headers);

  while (Date.now() - startTime < opts.pollTimeout) {
    try {
      // Build URL with optional since parameter
      let url = `${opts.apiUrl}/api/poll`;
      if (opts.since) {
        url += `?since=${encodeURIComponent(opts.since)}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        console.warn(`[runner] Poll request failed: ${response.status}`);
        await Bun.sleep(opts.pollInterval);
        continue;
      }

      const data = (await response.json()) as { trigger: Trigger | null };
      if (data.trigger) {
        return data.trigger;
      }
    } catch (error) {
      console.warn(`[runner] Poll request error: ${error}`);
    }

    await Bun.sleep(opts.pollInterval);
  }

  return null; // Timeout reached, no trigger found
}

/**
 * Build a ready-to-run fetch recipe for each task attachment, so the agent
 * can download the bytes in one call via the provider-agnostic
 * `/api/fs/tasks/{taskId}/files/{attachmentId}/raw` route — instead of having
 * to discover the file's storage provider/org/drive itself (e.g. guessing at
 * the `agent-fs` CLI with no org context). MCP_BASE_URL/API_KEY/AGENT_ID are
 * already present in every worker container's env.
 */
export function buildAttachmentsSection(
  taskId: string | undefined,
  attachmentsRaw: unknown,
): string {
  if (!taskId || !Array.isArray(attachmentsRaw) || attachmentsRaw.length === 0) return "";

  const lines = attachmentsRaw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => {
      const id = typeof a.id === "string" ? a.id : undefined;
      const name = typeof a.name === "string" ? a.name : id;
      if (!id || !name) return null;
      const details = [
        typeof a.mimeType === "string" ? a.mimeType : null,
        typeof a.sizeBytes === "number" ? `${a.sizeBytes} bytes` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const url = `$MCP_BASE_URL/api/fs/tasks/${taskId}/files/${id}/raw`;
      const cmd = `curl -s -H "Authorization: Bearer \${AGENT_SWARM_API_KEY:-$API_KEY}" -H "X-Agent-ID: $AGENT_ID" "${url}" -o /tmp/${name}`;
      return `- ${name}${details ? ` (${details})` : ""}: \`${cmd}\``;
    })
    .filter((line): line is string => line !== null);

  if (lines.length === 0) return "";

  return `\n\n📎 Attachment(s) — fetch directly, no need to discover the storage path yourself:\n${lines.join("\n")}`;
}

/** Build prompt based on trigger type */
async function buildPromptForTrigger(
  trigger: Trigger,
  defaultPrompt: string,
  fmt: (cmd: string) => string = (cmd) => `/${cmd}`,
  options?: { hasMcp?: boolean },
): Promise<string> {
  const hasMcp = options?.hasMcp !== false;
  switch (trigger.type) {
    case "task_assigned": {
      // Use the work-on-task command with task ID and description
      const taskDesc =
        trigger.task && typeof trigger.task === "object" && "task" in trigger.task
          ? (trigger.task as { task: string }).task
          : null;
      const taskDescSection = taskDesc ? `\n\nTask: "${taskDesc}"` : "";

      // Build output instructions — use outputSchema if present, otherwise generic.
      // Skip store-progress references for providers without MCP (e.g. Devin).
      const taskObj = trigger.task as Record<string, unknown> | undefined;
      let outputInstructions: string;
      if (!hasMcp) {
        outputInstructions = "";
      } else if (taskObj?.outputSchema && typeof taskObj.outputSchema === "object") {
        outputInstructions = `\n\n**Required Output Format**: When completing this task, you MUST call store-progress with output that is valid JSON conforming to this schema:\n\`\`\`json\n${JSON.stringify(taskObj.outputSchema, null, 2)}\n\`\`\`\nCall store-progress with status "completed" and your JSON output. If your output doesn't match the schema, the tool call will fail and you should fix and retry.`;
      } else {
        outputInstructions =
          '\n\nWhen done, use `store-progress` with status: "completed" and include your output.';
      }

      // Include requesting user info if available from the poll trigger
      const requestedBy = trigger.requestedBy;
      const requestedBySection = requestedBy
        ? `\n\nRequested by: ${requestedBy.name}${requestedBy.email ? ` (${requestedBy.email})` : ""}`
        : "";

      const attachmentsSection = buildAttachmentsSection(trigger.taskId, taskObj?.attachments);

      const result = await resolveTemplateAsync("task.trigger.assigned", {
        work_on_task_cmd: hasMcp ? fmt("work-on-task") : "",
        task_id: hasMcp ? trigger.taskId : "",
        task_desc_section: taskDescSection + requestedBySection,
        attachments_section: attachmentsSection,
        output_instructions: outputInstructions,
      });
      return result.text;
    }

    case "task_offered": {
      // Use the review-offered-task command with context
      const taskDesc =
        trigger.task && typeof trigger.task === "object" && "task" in trigger.task
          ? (trigger.task as { task: string }).task
          : null;
      const taskDescSection = taskDesc ? `\n\nA task has been offered to you:\n"${taskDesc}"` : "";
      const result = await resolveTemplateAsync("task.trigger.offered", {
        review_offered_task_cmd: hasMcp ? fmt("review-offered-task") : "",
        task_id: hasMcp ? trigger.taskId : "",
        task_desc_section: taskDescSection,
      });
      return result.text;
    }

    // NOTE: unread_mentions, pool_tasks_available, and channel_activity triggers
    // reference MCP tools (read-messages, get-tasks, task-action, slack-reply, etc.)
    // and are not currently fired for providers without MCP (e.g. Devin).
    case "unread_mentions": {
      const result = await resolveTemplateAsync("task.trigger.unread_mentions", {
        mention_count: trigger.count || "unread",
      });
      return result.text;
    }

    case "pool_tasks_available": {
      const result = await resolveTemplateAsync("task.trigger.pool_available", {
        task_count: trigger.count,
      });
      return result.text;
    }

    case "channel_activity": {
      const msgs = (trigger.messages || []) as Array<{
        channelId?: string;
        channelName?: string;
        ts?: string;
        user?: string;
        text?: string;
      }>;
      if (msgs.length === 0) {
        return "New Slack channel activity detected but no message details available. Use `slack-read` to check recent messages.";
      }

      let messagesDetail = "";
      for (const msg of msgs) {
        const channel = msg.channelName ? `#${msg.channelName}` : msg.channelId || "unknown";
        messagesDetail += `- **${channel}** (user: ${msg.user || "unknown"}): ${msg.text?.slice(0, 200) || "(no text)"}\n`;
      }

      const result = await resolveTemplateAsync("task.trigger.channel_activity", {
        message_count: trigger.count || msgs.length,
        messages_detail: messagesDetail,
      });
      return result.text;
    }

    case "budget_refused": {
      // DEFENSIVE: refusals are normally handled in the poll loop *before*
      // reaching buildPromptForTrigger (the loop short-circuits on
      // `trigger.type === "budget_refused"` to apply back-off + continue).
      // This branch exists purely to keep the switch exhaustive in TypeScript
      // and as future-refactor protection. It should never run in tested
      // paths. Returning the default prompt is the safe no-op behavior.
      const payload = JSON.stringify({
        type: trigger.type,
        cause: trigger.cause,
        agentSpend: trigger.agentSpend,
        agentBudget: trigger.agentBudget,
        globalSpend: trigger.globalSpend,
        globalBudget: trigger.globalBudget,
        resetAt: trigger.resetAt,
      });
      console.warn(
        `[runner] buildPromptForTrigger received budget_refused (defensive branch — should be handled in poll loop): ${scrubSecrets(payload)}`,
      );
      return defaultPrompt;
    }

    default:
      return defaultPrompt;
  }
}

/** Search agent memories relevant to a task description via the API */
async function fetchRelevantMemories(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  taskDescription: string,
  taskId?: string,
  contextKey?: string,
): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // Memory rater v1.5: server uses this header to log `memory_retrieval`
    // rows so server-side raters (ImplicitCitationRater) can score the
    // memories they surface against this task's session_logs at completion.
    // Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §2
    if (taskId) headers["X-Source-Task-ID"] = taskId;
    if (contextKey) headers["X-Context-Key"] = contextKey;

    const response = await fetch(`${apiUrl}/api/memory/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: taskDescription, limit: 5, intent: "pre-task memory recall" }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      results: Array<{ id: string; name: string; content: string; similarity: number }>;
    };

    return renderMemoriesPrompt(data.results || []);
  } catch {
    // Non-blocking — don't fail task start because of memory search
    return null;
  }
}

/** Spawn a provider session without blocking - returns immediately with tracking info */
/**
 * Extract a key field from tool arguments for event tracking.
 * Returns a single-entry record with the most identifying arg for the tool.
 */
function extractToolKey(toolName: string, args: unknown): Record<string, string | undefined> {
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
      return { filePath: a.file_path as string | undefined };
    case "Bash":
      return { description: a.description as string | undefined };
    case "Grep":
      return { pattern: a.pattern as string | undefined };
    case "Glob":
      return { pattern: a.pattern as string | undefined };
    case "Skill":
      return { skillName: a.skill as string | undefined };
    case "Agent":
      return { description: a.description as string | undefined };
    default:
      return {};
  }
}

const OTEL_PREVIEW_LIMIT = 500;

function telemetryPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized) return undefined;
    const scrubbed = scrubSecrets(serialized);
    return scrubbed.length > OTEL_PREVIEW_LIMIT
      ? `${scrubbed.slice(0, OTEL_PREVIEW_LIMIT)}...`
      : scrubbed;
  } catch {
    return "[unserializable]";
  }
}

type ToolTelemetry = {
  kind: "mcp" | "harness" | "skill" | "agent" | "shell" | "file" | "unknown";
  name: string;
  normalizedName: string;
  mcpServer?: string;
  mcpTool?: string;
};

function classifyTool(toolName: string, args: unknown): ToolTelemetry {
  const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  if (toolName.startsWith("mcp__")) {
    const [, server, ...toolParts] = toolName.split("__");
    const mcpTool = toolParts.join("__") || undefined;
    return {
      kind: "mcp",
      name: toolName,
      normalizedName: server && mcpTool ? `${server}.${mcpTool}` : toolName,
      mcpServer: server,
      mcpTool,
    };
  }

  if (typeof argRecord.server === "string" && typeof argRecord.tool === "string") {
    return {
      kind: "mcp",
      name: toolName,
      normalizedName: `${argRecord.server}.${argRecord.tool}`,
      mcpServer: argRecord.server,
      mcpTool: argRecord.tool,
    };
  }

  if (toolName.includes(":")) {
    const [server, ...toolParts] = toolName.split(":");
    const mcpTool = toolParts.join(":") || undefined;
    return {
      kind: "mcp",
      name: toolName,
      normalizedName: server && mcpTool ? `${server}.${mcpTool}` : toolName,
      mcpServer: server,
      mcpTool,
    };
  }

  switch (toolName) {
    case "Bash":
    case "bash":
    case "command_execution":
      return { kind: "shell", name: toolName, normalizedName: toolName };
    case "Read":
    case "Edit":
    case "Write":
    case "Delete":
    case "Grep":
    case "Glob":
    case "file_change":
      return { kind: "file", name: toolName, normalizedName: toolName };
    case "Skill":
      return { kind: "skill", name: toolName, normalizedName: toolName };
    case "Agent":
      return { kind: "agent", name: toolName, normalizedName: toolName };
    default:
      return { kind: "harness", name: toolName, normalizedName: toolName };
  }
}

function providerEventAttributes(event: ProviderEvent): Attributes {
  switch (event.type) {
    case "session_init":
      return {
        "agentswarm.provider.session_id": event.sessionId,
        "agentswarm.provider.name": event.provider,
        "agentswarm.provider.meta_preview": telemetryPreview(event.providerMeta),
      };
    case "message":
      return {
        "gen_ai.message.role": event.role,
        "gen_ai.message.content_preview": telemetryPreview(event.content),
      };
    case "tool_start":
    case "tool_end": {
      const tool = classifyTool(
        event.toolName,
        event.type === "tool_start" ? event.args : undefined,
      );
      return {
        "agentswarm.tool.name": tool.name,
        "agentswarm.tool.normalized_name": tool.normalizedName,
        "agentswarm.tool.kind": tool.kind,
        "agentswarm.tool.call_id": event.toolCallId,
        "mcp.server.name": tool.mcpServer,
        "mcp.tool.name": tool.mcpTool,
      };
    }
    case "result":
      return {
        "agentswarm.session.outcome": event.isError ? "error" : "ok",
        "agentswarm.error.category": event.errorCategory,
        "gen_ai.response.model": event.cost.model,
        "gen_ai.usage.input_tokens": event.cost.inputTokens ?? 0,
        "gen_ai.usage.output_tokens": event.cost.outputTokens ?? 0,
        "agentswarm.cost.total_usd": event.cost.totalCostUsd ?? 0,
      };
    case "error":
      return {
        "agentswarm.error.category": event.category,
        "exception.message": telemetryPreview(event.message),
      };
    case "progress":
      return { "agentswarm.progress.message": telemetryPreview(event.message) };
    case "context_usage":
      return {
        "agentswarm.context.used_tokens": event.contextUsedTokens ?? undefined,
        "agentswarm.context.total_tokens": event.contextTotalTokens ?? undefined,
        "agentswarm.context.percent": event.contextPercent ?? undefined,
        "gen_ai.usage.output_tokens": event.outputTokens ?? undefined,
      };
    case "compaction":
      return {
        "agentswarm.compaction.trigger": event.compactTrigger,
        "agentswarm.compaction.pre_tokens": event.preCompactTokens,
        "agentswarm.context.total_tokens": event.contextTotalTokens,
      };
    case "custom":
      return {
        "agentswarm.provider.event_name": event.name,
        "agentswarm.provider.event_data_preview": telemetryPreview(event.data),
      };
    case "raw_log":
    case "raw_stderr":
      return {};
  }
}

function normalizeSessionErrorCategory(category: string | undefined): string {
  switch (category) {
    case "rate_limit":
    case "api_error":
    case "context_overflow":
    case "timeout":
    case "provider_error":
      return category;
    default:
      return "unknown";
  }
}

/**
 * Entry shape for the `activeToolSpans` map maintained by `runWithSession`.
 * Exported for unit tests that exercise `implicitCloseActiveToolSpans`.
 */
export type ActiveToolSpanEntry = {
  span: SwarmSpan;
  startedAt: number;
};

/**
 * Closes any still-open tool spans (both `worker.tool` and `worker.mcp.tool`)
 * in `activeToolSpans` at the assistant-message boundary, tagging them with
 * `agentswarm.tool.implicit_close=true` and removing them from the map.
 *
 * The Claude SDK adapter doesn't emit per-tool completion events for any
 * tool kind, MCP or harness-side — so the assistant-message boundary serves
 * as an implicit `tool_end` for everything. Spans closed here are still
 * successful (code 1, OK); the boundary is just a signal that the prior
 * tool turn is done.
 *
 * Returns the number of spans closed (handy for tests / metrics).
 */
export function implicitCloseActiveToolSpans(
  activeToolSpans: Map<string, ActiveToolSpanEntry>,
  now: number = Date.now(),
): number {
  let closed = 0;
  for (const [toolCallId, active] of activeToolSpans) {
    active.span.setAttributes({
      "agentswarm.tool.duration_ms": now - active.startedAt,
      "agentswarm.tool.implicit_close": true,
      "agentswarm.tool.call_id": toolCallId,
    });
    active.span.setStatus({ code: 1 });
    active.span.end();
    activeToolSpans.delete(toolCallId);
    closed++;
  }
  return closed;
}

async function spawnProviderProcess(
  adapter: Awaited<ReturnType<typeof createProviderAdapter>>,
  opts: {
    prompt: string;
    logFile: string;
    systemPrompt?: string;
    additionalArgs?: string[];
    role: string;
    apiUrl: string;
    apiKey: string;
    agentId: string;
    runnerSessionId: string;
    iteration: number;
    taskId?: string;
    model?: string;
    modelTier?: string;
    effort?: ReasoningEffort;
    resumeSessionId?: string;
    harnessProvider: ProviderName;
    cwd?: string;
    vcsRepo?: string;
    contextKey?: string;
  },
  logDir: string,
  isYolo: boolean,
): Promise<RunningTask> {
  // Real task ID from DB (may be undefined for pool_tasks_available triggers)
  const realTaskId = opts.taskId;
  // Correlation ID for logs/display — always defined
  const effectiveTaskId = realTaskId || crypto.randomUUID();

  // Resolve env first so we can use MODEL_OVERRIDE from config.
  // Pass opts.model (per-task model) so the credential picker can apply
  // the harness × model matrix (e.g. exclude OPENAI_API_KEY for OpenRouter models).
  const { env: freshEnv, credentialSelections } = await fetchResolvedEnv(
    opts.apiUrl,
    opts.apiKey,
    opts.agentId,
    process.env,
    opts.model,
  );

  // Report which key was selected for this task (fire-and-forget)
  if (credentialSelections.length > 0 && realTaskId) {
    for (const sel of credentialSelections) {
      reportKeyUsage(opts.apiUrl, opts.apiKey, sel.keyType, sel, realTaskId).catch(() => {});
    }
  }

  // Propagate agent-fs config to process.env so getBasePrompt() can read them
  // (fetchResolvedEnv returns a new object, doesn't update process.env)
  if (freshEnv.AGENT_FS_SHARED_ORG_ID) {
    process.env.AGENT_FS_SHARED_ORG_ID = freshEnv.AGENT_FS_SHARED_ORG_ID as string;
  }

  const configModel = (freshEnv.MODEL_OVERRIDE as string | undefined) || "";
  // Reasoning/effort resolves independently of model/modelTier — no
  // resolveTaskModelSelection()-equivalent exists or is wanted for this axis
  // (see Phase 3 of the reasoning-effort plan). Precedence: task field →
  // REASONING_EFFORT_OVERRIDE → undefined.
  const reasoningEffortOverride =
    opts.effort || (freshEnv.REASONING_EFFORT_OVERRIDE as ReasoningEffort | undefined) || undefined;
  const taskModelSelection = resolveTaskModelSelection({
    model: opts.model,
    modelTier: opts.modelTier,
    harnessProvider: opts.harnessProvider,
    env: freshEnv,
  });
  const taskModel = taskModelSelection.model || "";
  const model = taskModel || configModel || "";

  // Resolve Codex OAuth pool slot BEFORE building ProviderSessionConfig so we
  // can pass codexSlot through and the adapter writes token refreshes back to
  // the correct slot key (codex_oauth_<slot>) instead of defaulting to slot 0.
  //
  // Always resolve for codex (not just when credentialSelections is empty) so
  // that if the OPENAI_API_KEY credential is rate-limited we can fail over to
  // a CODEX_OAUTH slot — even though the keyType differs.
  let oauthSelection: CredentialSelection | undefined;
  if (adapter.name === "codex") {
    oauthSelection = (await resolveCodexOAuthCredentialInfo(opts.apiUrl, opts.apiKey)) ?? undefined;
    const oauthIsPrimary =
      credentialSelections.length === 0 ||
      (credentialSelections[0]?.isRateLimitFallback &&
        oauthSelection &&
        !oauthSelection.isRateLimitFallback);
    if (oauthSelection && realTaskId && oauthIsPrimary) {
      reportKeyUsage(
        opts.apiUrl,
        opts.apiKey,
        oauthSelection.keyType,
        oauthSelection,
        realTaskId,
      ).catch(() => {});
    }
  }

  const config: ProviderSessionConfig = {
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt || "",
    model,
    role: opts.role,
    agentId: opts.agentId,
    taskId: effectiveTaskId,
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    cwd: opts.cwd || process.cwd(),
    vcsRepo: opts.vcsRepo,
    logFile: opts.logFile,
    additionalArgs: opts.additionalArgs,
    resumeSessionId: opts.resumeSessionId,
    iteration: opts.iteration,
    env: freshEnv as Record<string, string>,
    // Propagate the selected OAuth slot so the adapter refreshes back to the
    // correct pool key. Undefined for non-codex providers and single-cred deploys.
    codexSlot: oauthSelection?.index,
    contextKey: opts.contextKey,
    reasoningEffort: reasoningEffortOverride,
  };

  // Create the long-lived `worker.session` span up front so the provider
  // session — and the harness subprocess it spawns — is created within its
  // trace context. This makes `worker.session.create` a child of
  // `worker.session` instead of a separate root span, and gives the
  // claude-adapter an active span to derive `TRACEPARENT` from when
  // `SWARM_ENABLE_CLAUDE_CODE_OTEL` is on, so Claude Code's spans nest under
  // our trace. `agentswarm.provider.session_id` is stamped once the provider
  // session exists (below) and refreshed on the `session_init` event.
  const sessionSpan = startSpan("worker.session", {
    "agent.id": opts.agentId,
    "agentswarm.task.id": effectiveTaskId,
    "agentswarm.task.real_id": realTaskId,
    "agentswarm.agent.role": opts.role,
    "agentswarm.harness_provider": opts.harnessProvider,
    "agentswarm.session.cwd": config.cwd,
    "agentswarm.session.vcs_repo": opts.vcsRepo,
    "gen_ai.request.model": model || undefined,
  });

  const session = await withSpanContext(sessionSpan, () =>
    withSpan(
      "worker.session.create",
      async (span) => {
        const createdSession = await adapter.createSession(config);
        span.setAttribute("agentswarm.provider.session_id", createdSession.sessionId || "pending");
        return createdSession;
      },
      {
        "agent.id": opts.agentId,
        "agentswarm.task.id": effectiveTaskId,
        "agentswarm.task.real_id": realTaskId,
        "agentswarm.agent.role": opts.role,
        "agentswarm.harness_provider": opts.harnessProvider,
        "gen_ai.request.model": model || undefined,
        "agentswarm.session.cwd": config.cwd,
        "agentswarm.session.vcs_repo": opts.vcsRepo,
        "agentswarm.session.additional_args_count": opts.additionalArgs?.length ?? 0,
      },
    ),
  );
  const initialModelReport = buildLatestModelReport({
    model,
    taskModel,
    configModel,
    taskId: realTaskId,
    harnessProvider: opts.harnessProvider,
    // Resolved (pre-adapter) level. Phase 4 will introduce
    // `ProviderResult.appliedReasoningEffort`, confirmed by the adapter; until
    // then both the initial and post-result reports use this same
    // runner-resolved value.
    reasoningEffort: reasoningEffortOverride,
  });
  if (initialModelReport) {
    reportLatestModel(opts.apiUrl, opts.apiKey, opts.agentId, initialModelReport).catch((err) =>
      console.warn(`[runner] Failed to report latest model: ${err}`),
    );
  }

  // Set up log streaming
  const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now(), partialLine: "" };
  const shouldStream = opts.apiUrl && opts.runnerSessionId && opts.iteration;

  // Event buffer (flushes to API periodically)
  interface BufferedEvent {
    category: string;
    event: string;
    status?: string;
    source: string;
    agentId?: string;
    taskId?: string;
    sessionId?: string;
    parentEventId?: string;
    numericValue?: number;
    durationMs?: number;
    data?: Record<string, unknown>;
  }

  const eventBuffer: BufferedEvent[] = [];
  const EVENT_FLUSH_INTERVAL_MS = 5000;
  const EVENT_BUFFER_MAX = 50;

  function bufferEvent(evt: BufferedEvent) {
    eventBuffer.push(evt);
    if (eventBuffer.length >= EVENT_BUFFER_MAX) {
      flushEvents();
    }
  }

  async function flushEvents() {
    if (eventBuffer.length === 0) return;
    const batch = eventBuffer.splice(0);
    try {
      await fetch(`${opts.apiUrl}/api/events/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          "X-Agent-ID": opts.agentId,
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // Non-blocking — event loss is acceptable
    }
  }

  const eventFlushTimer = setInterval(flushEvents, EVENT_FLUSH_INTERVAL_MS);
  const sessionStartTime = Date.now();
  let providerSessionId = session.sessionId;
  let pendingHarnessVariant: string | undefined;
  let pendingHarnessVariantMeta: Record<string, unknown> | undefined;
  let runningTaskForSessionInit: RunningTask | undefined;
  const activeToolSpans = new Map<
    string,
    {
      span: SwarmSpan;
      startedAt: number;
    }
  >();
  // sessionSpan was created above (before provider-session creation). Stamp the
  // provider session ID now that it exists; it's refreshed on `session_init`.
  if (providerSessionId) {
    sessionSpan.setAttribute("agentswarm.provider.session_id", providerSessionId);
  }

  // Auto-progress throttle: don't update more than once per 3 seconds
  let lastProgressTime = 0;

  // Context usage throttle: max 1 snapshot per 30 seconds
  let lastContextPostTime = 0;
  const CONTEXT_THROTTLE_MS = 30_000;

  // Phase 10: accumulate per-turn output tokens across the session so progress
  // snapshots carry a real `cumulativeOutputTokens` (was 0 until completion).
  let cumulativeProgressOutputTokens = 0;

  function bufferSessionLogLine(content: string) {
    if (!shouldStream) return;
    logBuffer.lines.push(content);
    const shouldFlush =
      logBuffer.lines.length >= LOG_BUFFER_SIZE ||
      Date.now() - logBuffer.lastFlush >= LOG_FLUSH_INTERVAL_MS;
    if (shouldFlush) {
      flushLogBuffer(logBuffer, {
        apiUrl: opts.apiUrl,
        apiKey: opts.apiKey,
        agentId: opts.agentId,
        sessionId: opts.runnerSessionId,
        iteration: opts.iteration,
        taskId: effectiveTaskId,
        cli: adapter.name,
      }).catch(() => {});
    }
  }

  session.onEvent((event) =>
    withSpanContext(sessionSpan, () => {
      sessionSpan.addEvent(`provider.${event.type}`, providerEventAttributes(event));
      switch (event.type) {
        case "session_init":
          providerSessionId = event.sessionId;
          pendingHarnessVariant = event.harnessVariant;
          pendingHarnessVariantMeta = event.harnessVariantMeta;
          if (runningTaskForSessionInit) {
            runningTaskForSessionInit.harnessVariant = event.harnessVariant;
            runningTaskForSessionInit.harnessVariantMeta = event.harnessVariantMeta;
          }
          sessionSpan.setAttributes({
            "agentswarm.provider.session_id": providerSessionId,
            "agentswarm.provider.name": event.provider,
            "agentswarm.provider.meta_preview": telemetryPreview(event.providerMeta),
          });
          if (realTaskId) {
            saveProviderSessionId(
              opts.apiUrl,
              opts.apiKey,
              realTaskId,
              event.sessionId,
              event.provider,
              event.providerMeta,
              model,
              event.harnessVariant,
              event.harnessVariantMeta,
            ).catch((err) => console.warn(`[runner] Failed to save session ID: ${err}`));
          } else {
            // Pool task: save provider session ID on active session so it can be
            // propagated to the real task when the agent claims one
            saveProviderSessionIdOnActiveSession(
              opts.apiUrl,
              opts.apiKey,
              effectiveTaskId,
              event.sessionId,
            ).catch((err) =>
              console.warn(`[runner] Failed to save provider session on active session: ${err}`),
            );
          }

          // Structured session-start log for observability (covers all providers)
          {
            const variant = event.harnessVariant ?? "unknown";
            const version =
              (event.harnessVariantMeta as Record<string, unknown> | undefined)?.version ??
              "unknown";
            console.log(
              `[${opts.role}] [harness] provider=${event.provider ?? opts.harnessProvider} variant=${variant} version=${version} model=${model || "default"}`,
            );
          }

          // Buffer session start event
          bufferEvent({
            category: "session",
            event: "session.start",
            source: "worker",
            agentId: opts.agentId,
            taskId: effectiveTaskId,
            sessionId: event.sessionId,
          });
          break;
        case "message": {
          // Assistant-message boundary acts as an implicit tool_end for ALL
          // still-open tool spans (both `worker.tool` and `worker.mcp.tool`).
          // The Claude SDK adapter doesn't emit per-tool completion events for
          // any tool kind, so without this their spans would only close at
          // session shutdown via `closeActiveToolSpans` and report wall-clock
          // duration from tool_start to session end.
          if (event.role === "assistant") {
            implicitCloseActiveToolSpans(activeToolSpans);
          }
          break;
        }
        case "tool_start": {
          const tool = classifyTool(event.toolName, event.args);
          const toolSpan = startSpan(tool.kind === "mcp" ? "worker.mcp.tool" : "worker.tool", {
            "agent.id": opts.agentId,
            "agentswarm.task.id": effectiveTaskId,
            "agentswarm.task.real_id": realTaskId,
            "agentswarm.agent.role": opts.role,
            "agentswarm.harness_provider": opts.harnessProvider,
            "agentswarm.provider.session_id": providerSessionId,
            "agentswarm.tool.name": tool.name,
            "agentswarm.tool.normalized_name": tool.normalizedName,
            "agentswarm.tool.kind": tool.kind,
            "agentswarm.tool.call_id": event.toolCallId,
            "mcp.server.name": tool.mcpServer,
            "mcp.tool.name": tool.mcpTool,
            "agentswarm.tool.args_preview": telemetryPreview(event.args),
          });
          activeToolSpans.set(event.toolCallId, {
            span: toolSpan,
            startedAt: Date.now(),
          });

          // Auto-progress: report tool activity as task progress (throttled)
          const now = Date.now();
          if (effectiveTaskId && opts.apiUrl && now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
            const progress = toolCallToProgress(event.toolName, event.args);
            if (progress) {
              lastProgressTime = now;
              updateProgressViaAPI(opts.apiUrl, opts.apiKey, effectiveTaskId, progress).catch(
                () => {},
              );
            }
          }

          // Buffer tool event
          bufferEvent({
            category: "tool",
            event: "tool.start",
            source: "worker",
            agentId: opts.agentId,
            taskId: effectiveTaskId,
            sessionId: opts.runnerSessionId,
            data: {
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              ...extractToolKey(event.toolName, event.args),
              clientTimestamp: new Date().toISOString(),
            },
          });

          // Also emit skill event when tool is Skill
          if (event.toolName === "Skill") {
            const args = event.args as Record<string, unknown>;
            bufferEvent({
              category: "skill",
              event: "skill.invoke",
              source: "worker",
              agentId: opts.agentId,
              taskId: effectiveTaskId,
              sessionId: opts.runnerSessionId,
              data: {
                skillName: args.skill as string,
                clientTimestamp: new Date().toISOString(),
              },
            });
          }
          break;
        }
        case "tool_end": {
          const active = activeToolSpans.get(event.toolCallId);
          const now = Date.now();
          if (active) {
            active.span.setAttributes({
              "agentswarm.tool.duration_ms": now - active.startedAt,
              "agentswarm.tool.result_preview": telemetryPreview(event.result),
            });
            active.span.setStatus({ code: 1 });
            active.span.end();
            activeToolSpans.delete(event.toolCallId);
          } else {
            const tool = classifyTool(event.toolName, undefined);
            const span = startSpan(tool.kind === "mcp" ? "worker.mcp.tool" : "worker.tool", {
              "agent.id": opts.agentId,
              "agentswarm.task.id": effectiveTaskId,
              "agentswarm.task.real_id": realTaskId,
              "agentswarm.agent.role": opts.role,
              "agentswarm.harness_provider": opts.harnessProvider,
              "agentswarm.provider.session_id": providerSessionId,
              "agentswarm.tool.name": tool.name,
              "agentswarm.tool.normalized_name": tool.normalizedName,
              "agentswarm.tool.kind": tool.kind,
              "agentswarm.tool.call_id": event.toolCallId,
              "mcp.server.name": tool.mcpServer,
              "mcp.tool.name": tool.mcpTool,
              "agentswarm.tool.result_preview": telemetryPreview(event.result),
              "agentswarm.tool.missing_start": true,
            });
            span.end();
          }
          break;
        }
        case "result":
          {
            // Mid-session snapshot — fires on each streamed "result" event,
            // necessarily before `ProviderResult.appliedReasoningEffort` exists
            // (that's only available once `waitForCompletion()` resolves).
            // Uses the pre-adapter runner-resolved value; corrected by the
            // final adapter-confirmed report below once the session completes.
            const latestModel = buildLatestModelReport({
              model: event.cost.model,
              taskModel: opts.model,
              configModel,
              taskId: realTaskId,
              harnessProvider: opts.harnessProvider,
              reasoningEffort: reasoningEffortOverride,
            });
            if (latestModel) {
              reportLatestModel(opts.apiUrl, opts.apiKey, opts.agentId, latestModel).catch((err) =>
                console.warn(`[runner] Failed to report latest model: ${err}`),
              );
            }
          }
          // Cost save is handled in waitForCompletion().then() to ensure
          // it completes before the process exits (fire-and-forget here
          // races with container shutdown).

          // Buffer session end event
          bufferEvent({
            category: "session",
            event: "session.end",
            source: "worker",
            agentId: opts.agentId,
            taskId: effectiveTaskId,
            sessionId: opts.runnerSessionId,
            status: event.isError ? "error" : "ok",
            durationMs: Date.now() - sessionStartTime,
            data: {
              model: event.cost.model,
              totalCostUsd: event.cost.totalCostUsd,
              inputTokens: event.cost.inputTokens,
              outputTokens: event.cost.outputTokens,
            },
          });
          break;
        case "error":
          sessionSpan.setStatus({
            code: 2,
            message: event.message,
          });
          break;
        case "context_usage": {
          const now2 = Date.now();
          if (now2 - lastContextPostTime >= CONTEXT_THROTTLE_MS) {
            lastContextPostTime = now2;
            // Phase 10: track cumulative output tokens on the worker side and
            // forward them on every progress snapshot. Previously these were
            // 0 until the `completion` snapshot at session end, so the
            // dashboard's "tokens consumed" line was a flat zero throughout.
            cumulativeProgressOutputTokens += event.outputTokens ?? 0;
            // For inputs we don't get a per-turn delta on the `context_usage`
            // event (the unified formula bakes it into contextUsedTokens), so
            // we report the latest contextUsedTokens as the running input proxy.
            // The DB column is `cumulativeInputTokens` but the semantic on
            // progress rows is "running used-tokens" — both inputs and outputs
            // contribute, exact decomposition lives on the cost row.
            fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Agent-ID": opts.agentId,
                Authorization: `Bearer ${opts.apiKey}`,
              },
              body: JSON.stringify({
                eventType: "progress",
                sessionId: opts.runnerSessionId,
                contextUsedTokens: event.contextUsedTokens,
                contextTotalTokens: event.contextTotalTokens,
                contextPercent: event.contextPercent,
                cumulativeInputTokens: event.contextUsedTokens,
                cumulativeOutputTokens: cumulativeProgressOutputTokens,
                contextFormula: event.contextFormula,
              }),
            }).catch(() => {});
          }
          break;
        }
        case "compaction": {
          // Always record compaction events (no throttle)
          telemetry.compaction("triggered", {
            compactTrigger: event.compactTrigger,
            preCompactTokens: event.preCompactTokens,
            contextTotalTokens: event.contextTotalTokens,
          });
          fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Agent-ID": opts.agentId,
              Authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify({
              eventType: "compaction",
              sessionId: opts.runnerSessionId,
              preCompactTokens: event.preCompactTokens,
              compactTrigger: event.compactTrigger,
              contextTotalTokens: event.contextTotalTokens,
            }),
          }).catch(() => {});
          break;
        }
        case "raw_log":
          prettyPrintLine(event.content, opts.role);
          bufferSessionLogLine(event.content);
          break;
        case "raw_stderr":
          prettyPrintStderr(event.content, opts.role);
          bufferSessionLogLine(
            JSON.stringify({
              type: "stderr",
              content: event.content,
              timestamp: new Date().toISOString(),
            }),
          );
          break;

        case "progress": {
          if (effectiveTaskId && opts.apiUrl) {
            const now = Date.now();
            if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
              lastProgressTime = now;
              updateProgressViaAPI(opts.apiUrl, opts.apiKey, effectiveTaskId, event.message).catch(
                () => {},
              );
            }
          }
          break;
        }
      }
    }),
  );

  function closeActiveToolSpans(status: "ok" | "error", message?: string) {
    for (const [toolCallId, active] of activeToolSpans) {
      active.span.setAttributes({
        "agentswarm.tool.duration_ms": Date.now() - active.startedAt,
        "agentswarm.tool.unclosed": true,
        "agentswarm.tool.call_id": toolCallId,
      });
      if (status === "error") {
        active.span.setStatus({ code: 2, message: message || "session ended before tool_end" });
      }
      active.span.end();
      activeToolSpans.delete(toolCallId);
    }
  }

  // Create promise that handles completion
  const promise: Promise<ProviderResult> = session
    .waitForCompletion()
    .then((result) =>
      withSpanContext(sessionSpan, async () => {
        // Stop event flush timer and do a final flush
        clearInterval(eventFlushTimer);
        await flushEvents();

        // Final log flush
        if (shouldStream && logBuffer.lines.length > 0) {
          await flushLogBuffer(logBuffer, {
            apiUrl: opts.apiUrl,
            apiKey: opts.apiKey,
            agentId: opts.agentId,
            sessionId: opts.runnerSessionId,
            iteration: opts.iteration,
            taskId: effectiveTaskId,
            cli: adapter.name,
          });
        }

        // Error logging for non-zero exit
        if (result.exitCode !== 0) {
          const errorLog = {
            timestamp: new Date().toISOString(),
            iteration: opts.iteration,
            exitCode: result.exitCode,
            taskId: effectiveTaskId,
            error: true,
          };

          const errorsFile = `${logDir}/errors.jsonl`;
          const errorsFileRef = Bun.file(errorsFile);
          const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
          await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

          if (!isYolo) {
            console.error(
              `[${opts.role}] Task ${effectiveTaskId.slice(0, 8)} exited with code ${result.exitCode}.`,
            );
          } else {
            console.warn(
              `[${opts.role}] Task ${effectiveTaskId.slice(0, 8)} exited with code ${result.exitCode}. YOLO mode - continuing...`,
            );
          }
        }

        // Save cost data (awaited to ensure it completes before container exits)
        if (result.cost) {
          sessionSpan.setAttributes({
            "gen_ai.response.model": result.cost.model,
            "gen_ai.usage.input_tokens": result.cost.inputTokens ?? 0,
            "gen_ai.usage.output_tokens": result.cost.outputTokens ?? 0,
            "agentswarm.cost.total_usd": result.cost.totalCostUsd ?? 0,
          });
          telemetry.session("cost", {
            agentId: opts.agentId,
            model: result.cost.model,
            provider: result.cost.provider ?? opts.harnessProvider,
            inputTokens: result.cost.inputTokens ?? 0,
            outputTokens: result.cost.outputTokens ?? 0,
            cacheReadTokens: result.cost.cacheReadTokens,
            cacheWriteTokens: result.cost.cacheWriteTokens,
            reasoningOutputTokens: result.cost.reasoningOutputTokens,
            thinkingTokens: result.cost.thinkingTokens,
            totalCostUsd: result.cost.totalCostUsd,
            durationMs: result.cost.durationMs,
            numTurns: result.cost.numTurns,
            isError: result.cost.isError,
          });
          try {
            await saveCostData(
              { ...result.cost, taskId: realTaskId, sessionId: opts.runnerSessionId },
              opts.apiUrl,
              opts.apiKey,
            );
          } catch (err) {
            console.warn(`[runner] Failed to save cost: ${err}`);
          }
        }

        // Post completion context usage snapshot
        if (result.cost && realTaskId) {
          fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Agent-ID": opts.agentId,
              Authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify({
              eventType: "completion",
              sessionId: opts.runnerSessionId,
              cumulativeInputTokens: result.cost.inputTokens ?? 0,
              cumulativeOutputTokens: result.cost.outputTokens ?? 0,
              contextTotalTokens: getContextWindowSize(result.cost.model || "default"),
            }),
          }).catch(() => {});
        }

        // Final latest-model report using the adapter-confirmed
        // `appliedReasoningEffort` (Phase 4) — corrects the mid-session
        // `case "result":` event report above, which necessarily used the
        // pre-adapter runner-resolved value. Differs only in the
        // harness/model-switch edge case where a stale REASONING_EFFORT_OVERRIDE
        // no longer applies (see Phase 3's `applyReasoningEffort()` noop note).
        if (result.cost?.model) {
          const finalModelReport = buildLatestModelReport({
            model: result.cost.model,
            taskModel: opts.model,
            configModel,
            taskId: realTaskId,
            harnessProvider: opts.harnessProvider,
            reasoningEffort: result.appliedReasoningEffort ?? undefined,
          });
          if (finalModelReport) {
            reportLatestModel(opts.apiUrl, opts.apiKey, opts.agentId, finalModelReport).catch(
              (err) => console.warn(`[runner] Failed to report final latest model: ${err}`),
            );
          }
        }

        sessionSpan.setAttributes({
          "agentswarm.session.duration_ms": Date.now() - sessionStartTime,
          "agentswarm.session.exit_code": result.exitCode,
          "agentswarm.session.outcome": result.exitCode === 0 ? "ok" : "error",
        });
        if (result.exitCode !== 0) {
          sessionSpan.setStatus({
            code: 2,
            message: result.failureReason || `Provider exited with ${result.exitCode}`,
          });
        }
        closeActiveToolSpans(result.exitCode === 0 ? "ok" : "error", result.failureReason);
        sessionSpan.end();
        scheduleRunnerGc("session completion");

        return result;
      }),
    )
    .catch((error) =>
      withSpanContext(sessionSpan, () => {
        clearInterval(eventFlushTimer);
        sessionSpan.recordException(error);
        sessionSpan.setStatus({
          code: 2,
          message: error instanceof Error ? error.message : String(error),
        });
        closeActiveToolSpans("error", error instanceof Error ? error.message : String(error));
        sessionSpan.end();
        scheduleRunnerGc("session error");
        throw error;
      }),
    );

  // Build credential info for rate limit tracking.
  // For codex: when OPENAI_API_KEY is rate-limited but CODEX_OAUTH has
  // available slots (or vice versa), prefer the healthy credential.
  let primarySelection: CredentialSelection | undefined;
  const firstCred = credentialSelections[0];
  if (firstCred && oauthSelection) {
    if (firstCred.isRateLimitFallback && !oauthSelection.isRateLimitFallback) {
      primarySelection = oauthSelection;
      console.log(
        `[credentials] Cross-keyType failover: ${firstCred.keyType} all rate-limited, using ${oauthSelection.keyType} [...${oauthSelection.keySuffix}]`,
      );
    } else {
      primarySelection = firstCred;
    }
  } else {
    primarySelection = firstCred ?? oauthSelection;
  }
  const credentialInfo = primarySelection
    ? {
        keyType: primarySelection.keyType,
        keySuffix: primarySelection.keySuffix,
        keyIndex: primarySelection.index,
      }
    : undefined;

  const runningTask: RunningTask = {
    taskId: effectiveTaskId,
    session,
    logFile: opts.logFile,
    startTime: new Date(),
    promise,
    result: null,
    credentialInfo,
    // Snapshot the provider + local-env trait of the adapter this session is
    // spawned on, so the session-end sync decision survives a live provider
    // swap that mutates the global RunnerState (review finding 2).
    harnessProvider: opts.harnessProvider,
    hasLocalEnvironment: adapter.traits.hasLocalEnvironment,
    model: model || undefined,
  };
  runningTaskForSessionInit = runningTask;
  if (pendingHarnessVariant !== undefined) {
    runningTask.harnessVariant = pendingHarnessVariant;
  }
  if (pendingHarnessVariantMeta !== undefined) {
    runningTask.harnessVariantMeta = pendingHarnessVariantMeta;
  }

  // Non-blocking completion tracking
  promise
    .then((r) => {
      runningTask.result = r;
    })
    .catch(() => {
      runningTask.result = { exitCode: 1, isError: true };
    });

  return runningTask;
}

/** Check for completed processes and remove them from active tasks */
async function checkCompletedProcesses(
  state: RunnerState,
  role: string,
  apiConfig?: ApiConfig,
  cancelledSignaled?: Set<string>,
): Promise<void> {
  const completedTasks: Array<{
    taskId: string;
    result: ProviderResult;
    triggerType?: string;
    cursorUpdates?: Array<{ channelId: string; ts: string }>;
    workingDir?: string;
    credentialInfo?: RunningTask["credentialInfo"];
    harnessProvider: ProviderName;
    hasLocalEnvironment: boolean;
    harnessVariant?: string;
    harnessVariantMeta?: Record<string, unknown>;
    model?: string;
    durationMs: number;
  }> = [];

  for (const [taskId, task] of state.activeTasks) {
    // Non-blocking check: result is set by a .then() callback when the promise resolves
    if (task.result !== null) {
      console.log(
        `[${role}] Task ${taskId.slice(0, 8)} completed with exit code ${task.result.exitCode} (trigger: ${task.triggerType || "unknown"})`,
      );
      completedTasks.push({
        taskId,
        result: task.result,
        triggerType: task.triggerType,
        cursorUpdates: task.cursorUpdates,
        workingDir: task.workingDir,
        credentialInfo: task.credentialInfo,
        harnessProvider: task.harnessProvider,
        hasLocalEnvironment: task.hasLocalEnvironment,
        harnessVariant: task.harnessVariant,
        harnessVariantMeta: task.harnessVariantMeta,
        model: task.model,
        durationMs: Date.now() - task.startTime.getTime(),
      });
    }
  }

  // Remove completed tasks from the map and ensure they're marked as finished
  for (const {
    taskId,
    result,
    cursorUpdates,
    workingDir,
    credentialInfo,
    harnessProvider,
    harnessVariant,
    harnessVariantMeta,
    model,
    durationMs,
  } of completedTasks) {
    state.activeTasks.delete(taskId);
    vcsDetectedTasks.delete(taskId);
    vcsCheckTimestamps.delete(taskId);
    cancelledSignaled?.delete(taskId);

    if (apiConfig) {
      removeActiveSession(apiConfig, taskId);
    }

    // Detect VCS before finishing — last chance to link a PR
    if (apiConfig && workingDir && !vcsDetectedTasks.has(taskId)) {
      await detectVcsForTask(apiConfig.apiUrl, apiConfig.apiKey, taskId, workingDir);
    }

    // Call the finish API to ensure task status is updated
    // This is idempotent - if the agent already marked it, this is a no-op
    if (apiConfig) {
      let failureReason: string | undefined;
      if (result.exitCode !== 0 && result.failureReason) {
        failureReason = result.failureReason;
        console.log(`[${role}] Detected error for task ${taskId.slice(0, 8)}: ${failureReason}`);
      }

      // If rate-limited and we know which key was used, report it.
      // Codex adapter prefixes failure reasons with `[rate-limit]` /
      // `[usage-limit]` (see codex-adapter.formatTerminalError); Claude
      // surfaces "rate limit" / "hit your limit" via SessionErrorTracker.
      //
      // The gate must also fire on a bare structured rate_limit_event: a
      // `status: "rejected"` event sets result.rateLimitResetAt but does NOT
      // set hasErrors(), so failureReason can be empty even though the key is
      // exhausted. Gating on rateLimitResetAt != null ensures the structured
      // event alone still triggers the cooldown.
      if (
        credentialInfo &&
        (result.rateLimitResetAt != null ||
          (failureReason != null && isRateLimitMessage(failureReason)))
      ) {
        // Three-tier reset-time resolver (most to least precise):
        // Tier 1: structured rate_limit_event from Claude CLI (resetsAt epoch sec)
        // Tier 2: regex on the error message (e.g. "resets 3pm (UTC)")
        // Tier 3: 5-min hard fallback — only when both structured and regex fail
        // Tiers 1 & 2 are clamped to [now+60s, now+7d] (weekly limits reset ~2 days out).
        const clampResetTime = (isoString: string): string => {
          const nowMs = Date.now();
          const minMs = nowMs + 60_000;
          const maxMs = nowMs + MAX_RATE_LIMIT_RESET_MS;
          const candidateMs = new Date(isoString).getTime();
          return new Date(Math.min(Math.max(candidateMs, minMs), maxMs)).toISOString();
        };

        let rateLimitedUntil: string;
        if (result.rateLimitResetAt) {
          rateLimitedUntil = clampResetTime(result.rateLimitResetAt);
          console.log(`[credentials] Rate limit reset from rate_limit_event: ${rateLimitedUntil}`);
        } else if (failureReason != null) {
          const parsedResetTime = parseRateLimitResetTime(failureReason);
          if (parsedResetTime) {
            rateLimitedUntil = clampResetTime(parsedResetTime);
            console.log(
              `[credentials] Parsed rate limit reset time from error: ${rateLimitedUntil}`,
            );
          } else if (isCodexCreditsExhaustedMessage(failureReason)) {
            const cooldownMs = state.codexCreditsExhaustedCooldownMs;
            rateLimitedUntil = new Date(Date.now() + cooldownMs).toISOString();
            console.log(
              `[credentials] Codex credits exhausted — applying cooldown (${cooldownMs}ms): ${rateLimitedUntil}`,
            );
          } else {
            rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          }
        } else {
          rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        }
        reportKeyRateLimit(
          apiConfig.apiUrl,
          apiConfig.apiKey,
          credentialInfo.keyType,
          credentialInfo.keySuffix,
          credentialInfo.keyIndex,
          rateLimitedUntil,
        ).catch(() => {});
      }

      if (credentialInfo && result.rateLimitWindows) {
        reportKeyRateLimitWindows(
          apiConfig.apiUrl,
          apiConfig.apiKey,
          credentialInfo.keyType,
          credentialInfo.keySuffix,
          credentialInfo.keyIndex,
          result.rateLimitWindows,
        ).catch(() => {});
      }
      await ensureTaskFinished(
        apiConfig,
        role,
        taskId,
        result.exitCode,
        failureReason,
        result.output,
        harnessProvider,
      );

      telemetry.taskEvent("session_completed", {
        taskId,
        agentId: apiConfig.agentId,
        provider: result.cost?.provider ?? harnessProvider,
        model: result.cost?.model ?? model,
        harnessVariant,
        harnessVersion:
          typeof harnessVariantMeta?.version === "string" ||
          typeof harnessVariantMeta?.version === "number"
            ? String(harnessVariantMeta.version)
            : undefined,
        exitCode: result.exitCode,
        isError: result.exitCode !== 0,
        durationMs,
      });
      if (result.exitCode !== 0 || result.isError) {
        telemetry.session("failure", {
          agentId: apiConfig.agentId,
          errorCategory: normalizeSessionErrorCategory(result.errorCategory),
          provider: result.cost?.provider ?? harnessProvider,
          model: result.cost?.model ?? model,
          durationMs: result.cost?.durationMs ?? durationMs,
          wasRateLimited: result.rateLimitResetAt != null,
        });
      }
      state.tasksProcessed += 1;

      if (result.exitCode === 0 && credentialInfo) {
        reportKeyClearRateLimit(
          apiConfig.apiUrl,
          apiConfig.apiKey,
          credentialInfo.keyType,
          credentialInfo.keySuffix,
        ).catch(() => {});
      }

      ensure({
        id: "worker_process_finished",
        flow: "task",
        runId: taskId,
        depIds: ["worker_process_spawned"],
        data: {
          taskId,
          agentId: apiConfig.agentId,
          role,
          exitCode: result.exitCode,
          success: result.exitCode === 0,
          failureReason,
        },
        validator: (data) => data.exitCode === 0,
        // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
        filter: ({}, ctx) => ctx.deps.length > 0,
        conditions: [{ timeout_ms: 3_600_000 }], // 1 hour: process runtime
      });

      // Commit channel activity cursors after successful processing
      // If the task failed, cursors stay uncommitted so messages are re-seen on next poll
      if (cursorUpdates && cursorUpdates.length > 0 && result.exitCode === 0) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiConfig.apiKey) headers.Authorization = `Bearer ${apiConfig.apiKey}`;
          await fetch(`${apiConfig.apiUrl}/api/channel-activity/commit-cursors`, {
            method: "POST",
            headers,
            body: JSON.stringify({ cursorUpdates }),
          });
          console.log(
            `[${role}] Committed ${cursorUpdates.length} channel activity cursor(s) for task ${taskId.slice(0, 8)}`,
          );
        } catch (err) {
          console.warn(`[${role}] Failed to commit channel activity cursors: ${err}`);
        }
      }
    }
  }

  // Harness-agnostic FS → DB profile sync at session end.
  //
  // The Claude plugin Stop hook and the pi extension sync SOUL/IDENTITY/TOOLS/
  // CLAUDE.md + start-up.sh on their own, but codex/opencode have no such path
  // and pi's can silently not-fire (2026-06-01 regression). Running the sync
  // here — at the single point where every completed harness session converges
  // (including crashes, since the process resolved with an exit code) — makes
  // persistence reliable for ALL local-environment harnesses without
  // per-adapter code. Idempotent: the profile route only writes a new context
  // version when the content hash changes, so pi's double-sync and claude's
  // redundant POST collapse to a no-op. NON-FATAL — never blocks completion;
  // failures are logged (scrubbed) inside the helper.
  //
  // The local-env gate is per FINISHED session, snapshotted at spawn time —
  // NOT the mutable global `state.hasLocalEnvironment`. The runner lets
  // in-flight sessions finish on their original adapter after a live provider
  // swap, so reading the global would (a) skip a session that started local
  // when the worker has since flipped to a remote provider, and (b) sync stale
  // local files after a remote session finishes once the worker flipped local.
  // We sync when ANY finished session in this batch ran locally, and pick the
  // CLAUDE.md source from those sessions' providers (review finding 2 + 1).
  const localCompleted = completedTasks.filter((t) => t.hasLocalEnvironment);
  if (apiConfig && localCompleted.length > 0) {
    await syncProfileFilesToServer({
      agentId: apiConfig.agentId,
      apiUrl: apiConfig.apiUrl,
      apiKey: apiConfig.apiKey,
      changeSource: "session_sync",
      claudeMdPath: resolveClaudeMdPath(localCompleted.map((t) => t.harnessProvider)),
    }).catch((err) => {
      console.warn(`[${role}] ${scrubSecrets(`Profile sync failed: ${err}`)}`);
    });
  }
}

const TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchTemplate(
  templateId: string,
  registryUrl: string,
  cacheDir: string,
): Promise<TemplateResponse | null> {
  const safeId = templateId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cachePath = `${cacheDir}/${safeId}.json`;

  // Check local cache
  try {
    const info = await stat(cachePath);
    if (Date.now() - info.mtimeMs < TEMPLATE_CACHE_TTL_MS) {
      const cached = await readFile(cachePath, "utf-8");
      return JSON.parse(cached) as TemplateResponse;
    }
  } catch {
    // No cache or expired, continue to fetch
  }

  // Fetch from registry
  try {
    const resp = await fetch(`${registryUrl}/api/templates/${templateId}`);
    if (!resp.ok) {
      console.warn(`[template] Registry returned ${resp.status} for ${templateId}`);
      // Fall back to expired cache if available
      try {
        const cached = await readFile(cachePath, "utf-8");
        console.log(`[template] Using expired cache for ${templateId}`);
        return JSON.parse(cached) as TemplateResponse;
      } catch {
        return null;
      }
    }

    const template = (await resp.json()) as TemplateResponse;

    // Cache the response
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify(template), "utf-8");
    } catch {
      console.warn(`[template] Could not cache template to ${cachePath}`);
    }

    return template;
  } catch (err) {
    console.warn(`[template] Failed to fetch from registry: ${err}`);
    // Fall back to expired cache
    try {
      const cached = await readFile(cachePath, "utf-8");
      console.log(`[template] Using expired cache for ${templateId}`);
      return JSON.parse(cached) as TemplateResponse;
    } catch {
      return null;
    }
  }
}

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const { defaultPrompt, metadataType } = config;
  let role = config.role;

  // Initialize Business-Use SDK for worker-side instrumentation
  initialize();
  await initOtel(role);

  const sessionId = process.env.SESSION_ID || crypto.randomUUID().slice(0, 8);
  const baseLogDir = opts.logsDir || process.env.LOG_DIR || "/logs";
  const logDir = `${baseLogDir}/${sessionId}`;

  await mkdir(logDir, { recursive: true });

  const prompt = opts.prompt || defaultPrompt;
  const isYolo = opts.yolo || process.env.YOLO === "true";

  // Get agent identity and swarm URL for base prompt
  const agentId = process.env.AGENT_ID || "unknown";

  const apiUrl = getMcpBaseUrl();
  const swarmUrl = process.env.SWARM_URL || "localhost";
  const apiKey = getApiKey();

  // Resolve the boot harness provider from swarm_config (repo > agent > global,
  // overlaid on top of `process.env`). This is what selects the adapter for
  // this worker's lifetime. On a fresh worker (agentId="unknown") only global
  // swarm_config applies; once registered, an operator writing an agent-scoped
  // HARNESS_PROVIDER row takes effect on the next reconciliation cycle (Section 4)
  // or worker restart.
  //
  // Failures (network, API down, malformed value) fall back to env then "claude"
  // so a swarm_config outage cannot wedge boot.
  let bootProvider: ProviderName;
  let bootModel = process.env.MODEL_OVERRIDE || "";
  // Codex credits-exhausted cooldown is sourced solely from the global swarm_config
  // (key `CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS`). Initialize to the default constant
  // for the case where it is unset, then apply the swarm_config value below; on a
  // boot-fetch failure it stays at the default. Reconciled live thereafter by
  // `applySwarmConfigDrift`.
  let bootCooldownMs = resolveCodexCreditsExhaustedCooldownMs(undefined);
  try {
    await ensureAgentFsCredentials(apiUrl, apiKey, agentId);
    const bootEnv = await fetchResolvedEnv(apiUrl, apiKey, agentId);
    bootProvider = bootEnv.resolvedProvider;
    bootModel = (bootEnv.env.MODEL_OVERRIDE as string | undefined) || bootModel;
    bootCooldownMs = resolveCodexCreditsExhaustedCooldownMs(
      bootEnv.env.CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
    );
  } catch (err) {
    console.warn(
      `[runner] fetchResolvedEnv failed at boot, falling back to env for provider and the default cooldown: ${err}`,
    );
    bootProvider = resolveHarnessProvider({}, process.env);
  }
  console.log(`[runner] Resolved HARNESS_PROVIDER: ${bootProvider}`);

  // Create provider adapter using the resolved value. `let` so the poll-loop
  // reconciliation block (Section 4) can swap it live when an operator changes
  // HARNESS_PROVIDER in swarm_config — call sites read the current binding.
  let adapter = await createProviderAdapter(bootProvider);

  // Configure HTTP-based template resolution (workers resolve via API, not local DB)
  if (apiKey) {
    configureHttpResolver(apiUrl, apiKey);
  }

  // Initialize anonymized telemetry (opt-out via ANONYMIZED_TELEMETRY=false).
  // Workers use HTTP-based config access (cannot import DB directly).
  // IMPORTANT: workers must NOT pass `generateIfMissing` — the api-server is
  // the sole authority for `telemetry_installation_id`. If the API hasn't
  // persisted one yet (network blip, fresh boot, API down), the worker simply
  // skips telemetry instead of minting a fresh `install_<hex>` ID per
  // restart, which floods prod metrics with phantom installs.
  {
    const telemetryApiKey = apiKey || undefined;
    await initTelemetry(
      "worker",
      async (key) => {
        if (!telemetryApiKey) return undefined;
        try {
          const resp = await fetch(`${apiUrl}/api/config?scope=global&includeSecrets=true`, {
            headers: { Authorization: `Bearer ${telemetryApiKey}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (!resp.ok) return undefined;
          const data = (await resp.json()) as { configs: { key: string; value: string }[] };
          return data.configs.find((c) => c.key === key)?.value;
        } catch {
          return undefined;
        }
      },
      async (key, value) => {
        if (!telemetryApiKey) return;
        try {
          await fetch(`${apiUrl}/api/config`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${telemetryApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ scope: "global", key, value }),
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // Silently ignore — telemetry is best-effort
        }
      },
    );
  }
  telemetry.session("started", {
    agentId,
    harnessProvider: bootProvider,
    model: bootModel || undefined,
    role,
  });

  let capabilities = config.capabilities;

  // Agent identity fields — populated after registration by fetching full profile
  let agentSoulMd: string | undefined;
  let agentIdentityMd: string | undefined;
  let agentSetupScript: string | undefined;
  let agentToolsMd: string | undefined;
  let agentClaudeMd: string | undefined;
  let agentHeartbeatMd: string | undefined;
  let agentProfileName: string | undefined;
  let agentDescription: string | undefined;
  let agentSkillsSummary: { name: string; description: string }[] | undefined;
  let agentMcpServersSummary: string | undefined;

  // Per-task repo context — set when processing a task with githubRepo
  let currentRepoContext: BasePromptArgs["repoContext"] | undefined;
  // Slack context for current task (gates Slack instructions in prompt)
  let currentTaskSlackContext: BasePromptArgs["slackContext"] | undefined;

  // Generate base prompt (identity fields injected after profile fetch below).
  // Traits are read fresh on each call so a live adapter swap (Section 4)
  // produces a prompt matching the new provider's capabilities.
  const buildSystemPrompt = async () => {
    const { traits } = adapter;
    return getBasePrompt({
      role,
      agentId,
      swarmUrl,
      capabilities,
      traits,
      provider: adapter.name as ProviderName,
      name: agentProfileName,
      description: agentDescription,
      ...(traits.hasLocalEnvironment && {
        soulMd: agentSoulMd,
        identityMd: agentIdentityMd,
        toolsMd: agentToolsMd,
        claudeMd: agentClaudeMd,
      }),
      repoContext: currentRepoContext,
      slackContext: currentTaskSlackContext,
      ...(traits.hasMcp && {
        skillsSummary: agentSkillsSummary,
        mcpServersSummary: agentMcpServersSummary,
      }),
    });
  };

  let basePrompt = await buildSystemPrompt();

  // Resolve additional system prompt: CLI flag > env var
  let additionalSystemPrompt: string | undefined;
  const systemPromptText = opts.systemPrompt || process.env.SYSTEM_PROMPT;
  const systemPromptFilePath = opts.systemPromptFile || process.env.SYSTEM_PROMPT_FILE;

  if (systemPromptText) {
    additionalSystemPrompt = systemPromptText;
    console.log(
      `[${role}] Using additional system prompt from ${opts.systemPrompt ? "CLI flag" : "env var"}`,
    );
  } else if (systemPromptFilePath) {
    try {
      const file = Bun.file(systemPromptFilePath);
      if (!(await file.exists())) {
        console.error(`[${role}] ERROR: System prompt file not found: ${systemPromptFilePath}`);
        process.exit(1);
      }
      additionalSystemPrompt = await file.text();
      console.log(`[${role}] Loaded additional system prompt from file: ${systemPromptFilePath}`);
      console.log(
        `[${role}] Additional system prompt length: ${additionalSystemPrompt.length} characters`,
      );
    } catch (error) {
      console.error(`[${role}] ERROR: Failed to read system prompt file: ${systemPromptFilePath}`);
      console.error(error);
      process.exit(1);
    }
  }

  // Combine base prompt with any additional system prompt
  // Note: resolvedSystemPrompt is rebuilt after profile fetch when identity is available
  let resolvedSystemPrompt = additionalSystemPrompt
    ? `${basePrompt}\n\n${additionalSystemPrompt}`
    : basePrompt;

  console.log(`[${role}] Starting ${role}`);
  console.log(`[${role}] Agent ID: ${agentId}`);
  console.log(`[${role}] Session ID: ${sessionId}`);
  console.log(`[${role}] Log directory: ${logDir}`);
  console.log(`[${role}] YOLO mode: ${isYolo ? "enabled" : "disabled"}`);
  console.log(`[${role}] Prompt: ${prompt}`);
  console.log(`[${role}] API URL: ${apiUrl}`);
  console.log(`[${role}] Swarm URL: ${apiUrl}`);
  console.log(`[${role}] Base prompt: included (${basePrompt.length} chars)`);
  console.log(
    `[${role}] Additional system prompt: ${additionalSystemPrompt ? "provided" : "none"}`,
  );
  console.log(`[${role}] Total system prompt length: ${resolvedSystemPrompt.length} chars`);

  // Constants for polling
  const PollIntervalMs = 2000; // 2 seconds between polls
  const PollTimeoutMs = 60000; // 1 minute timeout before retrying

  let iteration = 0;

  // Fetch template early (before registration) so defaults can be applied
  const templateId = process.env.TEMPLATE_ID;
  const registryUrl = process.env.TEMPLATE_REGISTRY_URL || "https://templates.agent-swarm.dev";
  let cachedTemplate: TemplateResponse | null = null;

  if (templateId) {
    try {
      cachedTemplate = await fetchTemplate(templateId, registryUrl, "/workspace/.template-cache");
      if (cachedTemplate) {
        console.log(`[${role}] Fetched template: ${templateId}`);

        // Apply agentDefaults as fallbacks (env/config takes precedence)
        const defaults = cachedTemplate.config.agentDefaults;
        if (config.role === "worker" && defaults.role) {
          role = defaults.role;
        }
        if (!capabilities?.length && defaults.capabilities?.length) {
          capabilities = defaults.capabilities;
        }
      }
    } catch (err) {
      console.warn(`[${role}] Failed to fetch template ${templateId}: ${err}`);
    }
  }

  // Runner-level polling mode with parallel execution support
  const isLeadFromConfig = config.role === "lead";
  const isLead = isLeadFromConfig || (cachedTemplate?.config.agentDefaults?.isLead ?? false);
  const defaultMaxTasks = isLead ? 2 : 1;
  const templateMaxTasks = cachedTemplate?.config.agentDefaults?.maxTasks;
  const maxConcurrent = resolveMaxConcurrent(process.env, templateMaxTasks, defaultMaxTasks);
  console.log(`[${role}] Mode: runner-level polling`);
  console.log(`[${role}] Max concurrent tasks: ${maxConcurrent}`);

  // Initialize runner state for parallel execution
  const state: RunnerState = {
    activeTasks: new Map(),
    maxConcurrent,
    startedAt: Date.now(),
    tasksProcessed: 0,
    harnessProvider: bootProvider,
    codexCreditsExhaustedCooldownMs: bootCooldownMs,
  };

  // Track tasks already signaled for cancellation to avoid repeated SIGTERM
  const cancelledSignaled = new Set<string>();

  // Migration 055 — cache the harness_provider value used when we last
  // built a `cred_status` snapshot. Re-runs the post-task check only when
  // the resolved provider changes. Section 4 of the swarm_config-overrides-
  // HARNESS_PROVIDER work makes this dynamic: state.harnessProvider is
  // reconciled below from `swarm_config`, so an operator's change reaches
  // here without a worker restart.
  let cachedCredHarnessProvider: string | null = null;

  // Throttle for live HARNESS_PROVIDER reconciliation. Each reconciliation
  // calls `fetchResolvedEnv` which also re-resolves credential pools — we
  // don't want that on every 2s poll. 10s gives operator changes a near-
  // immediate effect from a UX perspective without hammering the API.
  let lastHarnessReconcileAt = 0;
  const HARNESS_RECONCILE_INTERVAL_MS = 10_000;

  // Throttle for the periodic Bedrock model-enumeration refresh. The credential
  // report below only re-runs on a harness_provider change (boot + provider
  // swap), so enabling Bedrock access after boot would otherwise never reach the
  // picker. This timer re-runs the enumeration on a fixed interval, decoupled
  // from the harness-change gate, so the UI stays accurate. 5 minutes keeps it
  // cheap (one bounded AWS enumeration per tick) while still surfacing newly
  // granted access within a few minutes.
  let lastBedrockRefreshAt = 0;
  const BEDROCK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  // Create API config for ping/close
  const apiConfig: ApiConfig = { apiUrl, apiKey, agentId };

  // Setup graceful shutdown handlers with API config and runner state access
  setupShutdownHandlers(role, apiConfig, () => state);

  // Register agent before starting
  const agentName =
    process.env.AGENT_NAME ||
    cachedTemplate?.config.displayName ||
    `${role}-${agentId.slice(0, 8)}`;

  /**
   * Reconcile RunnerState + process.env against a freshly resolved swarm
   * config snapshot. Single source of truth for live config drift; used
   * both during the credential-wait (so operator flips reach the predicate
   * mid-loop) and from the post-boot periodic reconciler.
   *
   * Returns whether anything agent-visible (provider, maxConcurrent)
   * changed — callers use this to decide whether to re-register.
   */
  const applySwarmConfigDrift = async (
    freshEnv: Record<string, string | undefined>,
    resolvedProvider: ProviderName,
  ): Promise<{ agentVisibleChanged: boolean }> => {
    let agentVisibleChanged = false;

    // (1) Harness provider — swap adapter + rebuild prompt atomically.
    if (resolvedProvider !== state.harnessProvider) {
      const previous = state.harnessProvider;
      console.log(`[${role}] [harness] Reconciling adapter: ${previous} → ${resolvedProvider}`);
      try {
        adapter = await createProviderAdapter(resolvedProvider);
        state.harnessProvider = resolvedProvider;
        basePrompt = await buildSystemPrompt();
        resolvedSystemPrompt = additionalSystemPrompt
          ? `${basePrompt}\n\n${additionalSystemPrompt}`
          : basePrompt;
        cachedCredHarnessProvider = null;
        agentVisibleChanged = true;
        console.log(
          `[${role}] [harness] Swapped to ${resolvedProvider} (basePrompt rebuilt: ${basePrompt.length} chars)`,
        );
      } catch (err) {
        console.warn(
          `[${role}] [harness] Failed to swap to ${resolvedProvider} (staying on ${previous}): ${err}`,
        );
      }
    }

    // (2) Max concurrency — operator can tune from the dashboard live.
    // Note: shrinking below activeTasks.size won't kill in-flight tasks; new
    // spawns are simply gated until in-flight drain back under the new cap.
    const nextMax = resolveMaxConcurrent(freshEnv, templateMaxTasks, defaultMaxTasks);
    if (nextMax !== state.maxConcurrent) {
      console.log(`[${role}] [config] maxConcurrent: ${state.maxConcurrent} → ${nextMax}`);
      state.maxConcurrent = nextMax;
      agentVisibleChanged = true;
    }

    // (2b) Codex credits-exhausted cooldown — operator-tunable live. Not
    // agent-visible (doesn't change provider/maxConcurrent → no re-register).
    const nextCooldown = resolveCodexCreditsExhaustedCooldownMs(
      freshEnv.CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS,
    );
    if (nextCooldown !== state.codexCreditsExhaustedCooldownMs) {
      console.log(
        `[${role}] [config] codexCreditsExhaustedCooldownMs: ${state.codexCreditsExhaustedCooldownMs} → ${nextCooldown}`,
      );
      state.codexCreditsExhaustedCooldownMs = nextCooldown;
    }

    // (3) Apply the small allowlist of safe-to-mutate env keys to process.env.
    const changedKeys = applyResolvedEnvToProcessEnv(freshEnv);
    if (changedKeys.length > 0) {
      console.log(`[${role}] [env-reload] Updated process.env: ${changedKeys.join(", ")}`);
    }

    return { agentVisibleChanged };
  };

  /** Push the current live state back to the API so the dashboard reflects it. */
  const reregisterAgent = async () => {
    try {
      await registerAgent({
        apiUrl,
        apiKey,
        agentId,
        name: agentName,
        role,
        isLead,
        capabilities,
        maxTasks: state.maxConcurrent,
        harnessProvider: state.harnessProvider,
      });
    } catch (err) {
      console.warn(`[${role}] [config] Re-register failed (non-fatal): ${err}`);
    }
  };
  try {
    await registerAgent({
      apiUrl,
      apiKey,
      agentId,
      name: agentName,
      role,
      isLead,
      capabilities,
      maxTasks: maxConcurrent,
      harnessProvider: bootProvider,
    });
    console.log(`[${role}] Registered as "${agentName}" (ID: ${agentId})`);
  } catch (error) {
    console.error(`[${role}] Failed to register: ${error}`);
    process.exit(1);
  }

  // Block until harness credentials are present in env. This loop replaces
  // the old bash-level fail-fast in `docker-entrypoint.sh` — the worker is
  // already registered (visible to the dashboard) and self-heals once
  // creds appear in `swarm_config`. See plans/2026-05-06-worker-credential-safe-loop.md.
  //
  // CRED_CHECK_DISABLE=1 opts out entirely: the worker trusts the operator
  // and starts polling immediately, with a NULL `cred_status` row that the
  // dashboard surfaces as "unreported."
  cachedCredHarnessProvider = state.harnessProvider;
  if (isCredCheckDisabled(process.env)) {
    console.log(`[${role}] CRED_CHECK_DISABLE=1, skipping credential checks`);
  } else {
    try {
      await awaitCredentials({
        provider: state.harnessProvider,
        // Re-read each tick so an operator's HARNESS_PROVIDER flip during
        // the wait pivots the credential predicate (and onwards).
        getProvider: () => state.harnessProvider,
        refreshEnv: async () => {
          const { env, resolvedProvider } = await fetchResolvedEnv(apiUrl, apiKey, agentId);
          // Apply drift inside the wait so adapter/prompt/state stay in
          // sync if the operator flips HARNESS_PROVIDER mid-loop. The
          // helper is idempotent when nothing changed.
          const { agentVisibleChanged } = await applySwarmConfigDrift(env, resolvedProvider);
          if (agentVisibleChanged) {
            // Fire-and-forget — dashboard reflects the live values, the
            // wait loop doesn't block on it.
            reregisterAgent().catch(() => {});
          }
          return env;
        },
        onTick: (status) => {
          // Best-effort status report — the dispatcher uses it to route
          // around blocked agents. Failures are non-fatal (the wait loop
          // already swallows onTick exceptions). We do NOT include
          // `cred_status` here — the live test runs once the worker is
          // ready (below), and intermediate ticks are presence-only.
          fetch(`${apiUrl}/api/agents/${encodeURIComponent(agentId)}/credential-status`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Agent-ID": agentId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ready: status.ready, missing: status.missing }),
          }).catch(() => {
            // Swallowed — Phase 2 wait loop logs every tick anyway.
          });
        },
      });
    } catch (err) {
      if (err instanceof BootMaxWaitExceededError) {
        console.error(`[${role}] ${err.message}`);
        process.exit(EX_CONFIG);
      }
      throw err;
    }

    // Migration 055: build the full snapshot (presence + live test) once
    // creds are ready and POST it to the agent row. Status endpoint reads
    // this instead of running predicates server-side. Always uses the
    // *current* state.harnessProvider in case it flipped during the wait.
    try {
      const snapshot = await buildCredStatusReport(state.harnessProvider, process.env, {}, "boot");
      await reportCredStatus(apiUrl, apiKey, agentId, snapshot);
    } catch (err) {
      // Non-fatal — worker proceeds even if reporting fails.
      console.warn(`[${role}] cred_status boot report failed (non-fatal): ${err}`);
    }
  }

  // Clean up any stale active sessions from previous runs (crash recovery)
  await cleanupActiveSessions(apiConfig);
  console.log(`[${role}] Cleaned up stale active sessions`);
  const startupRecoveredOrphans = await recoverOrphanedInProgressTasks(apiConfig);
  if (startupRecoveredOrphans > 0) {
    console.log(
      `[${role}] Recovered ${startupRecoveredOrphans} orphaned in-progress task(s) to pending`,
    );
  }

  // Fetch full agent profile to get soul/identity content
  try {
    const resp = await fetch(`${apiUrl}/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
    });
    if (resp.ok) {
      const profile = (await resp.json()) as {
        soulMd?: string;
        identityMd?: string;
        claudeMd?: string;
        setupScript?: string;
        toolsMd?: string;
        heartbeatMd?: string;
        name?: string;
        description?: string;
      };
      agentSoulMd = profile.soulMd;
      agentIdentityMd = profile.identityMd;
      agentSetupScript = profile.setupScript;
      agentToolsMd = profile.toolsMd;
      agentClaudeMd = profile.claudeMd;
      agentHeartbeatMd = profile.heartbeatMd;
      agentProfileName = profile.name;
      agentDescription = profile.description;

      // Generate default templates if missing (runner registers via POST /api/agents
      // which doesn't generate templates like join-swarm does)
      if (
        !agentSoulMd ||
        !agentIdentityMd ||
        !agentToolsMd ||
        !agentClaudeMd ||
        !agentHeartbeatMd
      ) {
        // Use already-fetched template (from pre-registration step)
        if (cachedTemplate) {
          const ctx = {
            agent: {
              name: agentProfileName || agentName,
              role: role,
              description: agentDescription || "",
              capabilities: (capabilities || []).join(", "),
            },
          };
          if (!agentSoulMd) agentSoulMd = interpolate(cachedTemplate.files.soulMd, ctx).result;
          if (!agentIdentityMd)
            agentIdentityMd = interpolate(cachedTemplate.files.identityMd, ctx).result;
          if (!agentToolsMd) agentToolsMd = interpolate(cachedTemplate.files.toolsMd, ctx).result;
          if (!agentClaudeMd)
            agentClaudeMd = interpolate(cachedTemplate.files.claudeMd, ctx).result;
          if (!agentSetupScript)
            agentSetupScript = interpolate(cachedTemplate.files.setupScript, ctx).result;
          if (!agentHeartbeatMd)
            agentHeartbeatMd = interpolate(cachedTemplate.files.heartbeatMd, ctx).result;
          console.log(`[${role}] Applied template: ${templateId}`);
        }

        // Fallback to generic defaults for any still-missing fields
        const agentInfo = {
          name: agentProfileName || agentName,
          role: role,
          description: agentDescription,
          capabilities: config.capabilities,
        };
        if (!agentSoulMd) agentSoulMd = generateDefaultSoulMd(agentInfo);
        if (!agentIdentityMd) agentIdentityMd = generateDefaultIdentityMd(agentInfo);
        if (!agentToolsMd) agentToolsMd = generateDefaultToolsMd(agentInfo);
        if (!agentClaudeMd) agentClaudeMd = generateDefaultClaudeMd(agentInfo);

        // Push generated templates to server
        try {
          const profileUpdate: Record<string, string> = {};
          if (!profile.soulMd) profileUpdate.soulMd = agentSoulMd;
          if (!profile.identityMd) profileUpdate.identityMd = agentIdentityMd;
          if (!profile.toolsMd) profileUpdate.toolsMd = agentToolsMd;
          if (!profile.claudeMd && agentClaudeMd) profileUpdate.claudeMd = agentClaudeMd;
          if (!profile.setupScript && agentSetupScript)
            profileUpdate.setupScript = agentSetupScript;
          if (!profile.heartbeatMd && agentHeartbeatMd)
            profileUpdate.heartbeatMd = agentHeartbeatMd;

          await fetch(`${apiUrl}/api/agents/${agentId}/profile`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Agent-ID": agentId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(profileUpdate),
          });
          console.log(`[${role}] Generated and saved default identity templates`);
        } catch {
          console.warn(`[${role}] Could not save generated templates to server`);
        }
      }

      // Fetch installed MCP servers for system prompt
      try {
        const mcpServersResp = await fetch(`${apiUrl}/api/agents/${agentId}/mcp-servers`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "X-Agent-ID": agentId,
          },
        });
        if (mcpServersResp.ok) {
          const mcpServersData = (await mcpServersResp.json()) as {
            servers: {
              name: string;
              transport: string;
              description: string | null;
              isActive: boolean;
              isEnabled: boolean;
            }[];
          };
          const activeMcpServers = mcpServersData.servers.filter((s) => s.isActive && s.isEnabled);
          if (activeMcpServers.length > 0) {
            agentMcpServersSummary = activeMcpServers
              .map((s) => `- **${s.name}** (${s.transport}): ${s.description || "No description"}`)
              .join("\n");
            console.log(
              `[${role}] Loaded ${activeMcpServers.length} MCP servers for system prompt`,
            );
          }
        }
      } catch {
        // Non-fatal — MCP servers are optional
      }

      // Rebuild system prompt with identity
      basePrompt = await buildSystemPrompt();
      resolvedSystemPrompt = additionalSystemPrompt
        ? `${basePrompt}\n\n${additionalSystemPrompt}`
        : basePrompt;
      console.log(
        `[${role}] Loaded agent identity (soul: ${agentSoulMd ? "yes" : "no"}, identity: ${agentIdentityMd ? "yes" : "no"}, tools: ${agentToolsMd ? "yes" : "no"}, claude: ${agentClaudeMd ? "yes" : "no"})`,
      );
      console.log(`[${role}] Updated system prompt length: ${resolvedSystemPrompt.length} chars`);
    }
  } catch {
    console.warn(`[${role}] Could not fetch agent profile for identity — proceeding without`);
  }

  // Write SOUL.md and IDENTITY.md to workspace before spawning Claude
  const SOUL_MD_PATH = "/workspace/SOUL.md";
  const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";

  if (agentSoulMd) {
    try {
      await Bun.write(SOUL_MD_PATH, agentSoulMd);
      console.log(`[${role}] Wrote SOUL.md to workspace`);
    } catch (err) {
      console.warn(`[${role}] Could not write SOUL.md: ${(err as Error).message}`);
    }
  }
  if (agentIdentityMd) {
    try {
      await Bun.write(IDENTITY_MD_PATH, agentIdentityMd);
      console.log(`[${role}] Wrote IDENTITY.md to workspace`);
    } catch (err) {
      console.warn(`[${role}] Could not write IDENTITY.md: ${(err as Error).message}`);
    }
  }

  // Write setup script to workspace (agent can edit during session)
  // Only create if it doesn't exist — the entrypoint already composed/prepended it at container start
  if (agentSetupScript) {
    try {
      if (!(await Bun.file("/workspace/start-up.sh").exists())) {
        await Bun.write("/workspace/start-up.sh", `#!/bin/bash\n${agentSetupScript}\n`);
        console.log(`[${role}] Wrote start-up.sh to workspace`);
      }
    } catch (err) {
      console.warn(`[${role}] Could not write start-up.sh: ${(err as Error).message}`);
    }
  }

  // Write TOOLS.md to workspace (agent can edit during session)
  if (agentToolsMd) {
    try {
      await Bun.write("/workspace/TOOLS.md", agentToolsMd);
      console.log(`[${role}] Wrote TOOLS.md to workspace`);
    } catch (err) {
      console.warn(`[${role}] Could not write TOOLS.md: ${(err as Error).message}`);
    }
  }

  // Write HEARTBEAT.md to workspace (lead's periodic checklist)
  if (agentHeartbeatMd) {
    try {
      await Bun.write("/workspace/HEARTBEAT.md", agentHeartbeatMd);
      console.log(`[${role}] Wrote HEARTBEAT.md to workspace`);
    } catch (err) {
      console.warn(`[${role}] Could not write HEARTBEAT.md: ${(err as Error).message}`);
    }
  }

  // Write CLAUDE.md to workspace (agent-level instructions)
  if (agentClaudeMd) {
    try {
      await Bun.write("/workspace/CLAUDE.md", agentClaudeMd);
      console.log(`[${role}] Wrote CLAUDE.md to workspace`);
    } catch (err) {
      console.warn(`[${role}] Could not write CLAUDE.md: ${(err as Error).message}`);
    }
  }

  // Record baseline hashes of identity files as written from DB. Session-end
  // sync compares current file content against these baselines: unchanged files
  // are skipped, which prevents clobbering DB-side edits made by Lead via
  // update-profile during the running session.
  try {
    const baselines: Record<string, string> = {};
    if (agentSoulMd) baselines.soulMd = contentSha256(agentSoulMd);
    if (agentIdentityMd) baselines.identityMd = contentSha256(agentIdentityMd);
    if (agentToolsMd) baselines.toolsMd = contentSha256(agentToolsMd);
    if (agentHeartbeatMd) baselines.heartbeatMd = contentSha256(agentHeartbeatMd);
    if (agentClaudeMd) baselines.claudeMd = contentSha256(agentClaudeMd);
    await writeIdentityBaselines(baselines);
    console.log(`[${role}] Recorded identity file baselines for session-end sync`);
  } catch {
    // Non-fatal — worst case, session-end sync proceeds as before (blind overwrite)
  }

  // ========== Boot-time skill load (signature-gated, replaces the standalone
  // skill-fetch + FS sync blocks). The polling loop below calls the same
  // helper per task to hot-reload skills mid-flight. Skipped for
  // `claude-managed` (cloud sandbox owns skill delivery).
  const lastSkillHash: { current: string | null } = { current: null };
  if (state.harnessProvider !== "claude-managed") {
    console.log(`[${role}] Syncing skills to filesystem...`);
    const skillResult = await refreshSkillsIfChanged(
      { apiUrl, swarmUrl, apiKey, agentId, role },
      lastSkillHash,
    );
    if (skillResult.changed && skillResult.summary) {
      agentSkillsSummary = skillResult.summary;
      if (agentSkillsSummary.length > 0) {
        console.log(`[${role}] Loaded ${agentSkillsSummary.length} skills for system prompt`);
      }
      // Rebuild base prompt now that we have skills.
      basePrompt = await buildSystemPrompt();
      resolvedSystemPrompt = additionalSystemPrompt
        ? `${basePrompt}\n\n${additionalSystemPrompt}`
        : basePrompt;
    }
  } else {
    console.log(
      `[${role}] Skipping skill sync (claude-managed reads skills from agent definition)`,
    );
  }

  // ========== Resume paused tasks with PRIORITY ==========
  // LEGACY SAFETY NET — kept for tasks that were paused by older worker
  // builds during partial-deploy windows (when the API server already
  // accepted /pause but the new worker has rolled out /supersede). New
  // graceful-shutdown writes go through the supersede path (see
  // supersedeTaskViaAPI + the SIGTERM handler) and create a fresh
  // "resume" follow-up task instead of mutating the original. Cleanup of
  // this entire block is tracked in the "Legacy paused-task cleanup"
  // follow-up plan — remove once no new `paused` tasks have been created
  // for one full quarter.
  try {
    console.log(`[${role}] Checking for paused tasks to resume...`);
    const pausedTasks = await getPausedTasksFromAPI(apiConfig);

    if (pausedTasks.length > 0) {
      console.log(`[${role}] Found ${pausedTasks.length} paused task(s) to resume`);

      for (const task of pausedTasks) {
        // Defensive: skip tasks that already have completion data (zombie prevention)
        if (task.finishedAt || task.output) {
          console.warn(
            `[${role}] Skipping zombie task ${task.id.slice(0, 8)} — already has completion data (finishedAt: ${!!task.finishedAt}, output: ${!!task.output})`,
          );
          continue;
        }

        // Wait if at capacity (though unlikely on fresh startup)
        while (state.activeTasks.size >= state.maxConcurrent) {
          await checkCompletedProcesses(state, role, apiConfig, cancelledSignaled);
          await Bun.sleep(1000);
        }

        console.log(
          `[${role}] Resuming paused task ${task.id.slice(0, 8)}: "${task.task.slice(0, 50)}..."`,
        );

        // Resume the task via API (marks as in_progress)
        const resumed = await resumeTaskViaAPI(apiConfig, task.id);
        if (!resumed) {
          console.warn(`[${role}] Failed to resume task ${task.id.slice(0, 8)} via API, skipping`);
          continue;
        }

        // Build prompt with resume context + memory injection
        let resumePrompt = await buildResumePrompt(task, adapter.formatCommand.bind(adapter), {
          hasMcp: adapter.traits.hasMcp,
        });

        // Inject relevant memories for resumed tasks
        const resumeMemoryContext = await fetchRelevantMemories(
          apiUrl,
          apiKey,
          agentId,
          task.task,
          task.id,
          (task as { contextKey?: string }).contextKey,
        );
        if (resumeMemoryContext) {
          resumePrompt += resumeMemoryContext;
          console.log(`[${role}] Injected relevant memories into resumed task prompt`);
        }

        // Universal context preamble: inject for all providers when task is a follow-up.
        // Gives non-resumable providers (opencode/pi/devin) prior-task context; also
        // acts as a bounded safety net for resumable ones (claude/codex).
        if (task.parentTaskId && apiUrl) {
          const contextPreamble = await buildContextPreamble(apiUrl, apiKey, task.parentTaskId);
          if (contextPreamble) {
            resumePrompt = contextPreamble + resumePrompt;
            console.log(
              `[${role}] Injected context preamble into resumed follow-up task prompt (parent: ${task.parentTaskId.slice(0, 8)})`,
            );
          }
        }

        // Resolve provider-aware resume: prefer own session, then parent.
        const resumeCandidates: ResumeSessionCandidate[] = [
          {
            source: "task",
            taskId: task.id,
            sessionId: task.claudeSessionId,
            provider: task.provider,
            providerMeta: task.providerMeta,
          },
        ];
        if (task.parentTaskId) {
          const parentSession = await fetchProviderSessionInfo(apiUrl, apiKey, task.parentTaskId);
          if (parentSession?.sessionId) {
            resumeCandidates.push({
              source: "parent",
              taskId: task.parentTaskId,
              sessionId: parentSession.sessionId,
              provider: parentSession.provider,
              providerMeta: parentSession.providerMeta,
            });
          }
        }
        const resumeResolution = resolveResumeSession(state.harnessProvider, resumeCandidates);
        logResumeResolution(role, resumeResolution);

        // Spawn Claude process for resumed task
        iteration++;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const logFile = `${logDir}/${timestamp}-resume-${task.id.slice(0, 8)}.jsonl`;

        console.log(`\n[${role}] === Resuming paused task (iteration ${iteration}) ===`);
        console.log(`[${role}] Logging to: ${logFile}`);
        console.log(`[${role}] Prompt: ${resumePrompt.slice(0, 100)}...`);

        const metadata = {
          type: metadataType,
          sessionId,
          iteration,
          timestamp: new Date().toISOString(),
          prompt: resumePrompt,
          trigger: "task_resumed",
          resumedTaskId: task.id,
          yolo: isYolo,
        };
        await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

        // Resolve cwd for resumed task (mirrors normal task path: task.dir > vcsRepo clonePath)
        let resumeCwd: string | undefined;
        if (task.dir) {
          try {
            if (existsSync(task.dir) && statSync(task.dir).isDirectory()) {
              resumeCwd = task.dir;
            } else {
              console.warn(
                `[${role}] Resume task dir "${task.dir}" does not exist or is not a directory, falling back to default cwd`,
              );
            }
          } catch {
            console.warn(
              `[${role}] Failed to check resume task dir "${task.dir}", falling back to default cwd`,
            );
          }
        }

        if (!resumeCwd && task.vcsRepo && apiUrl) {
          const repoConfig = await fetchRepoConfig(apiUrl, apiKey, task.vcsRepo);
          const effectiveConfig = repoConfig ?? {
            url: task.vcsRepo,
            name: task.vcsRepo.split("/").pop() || task.vcsRepo,
            clonePath: `/workspace/personal/repos/${task.vcsRepo.split("/").pop() || task.vcsRepo}`,
            defaultBranch: "main",
          };
          // This is the paused-task-resume-after-restart path — never a first
          // kickoff, so never force-reset the base branch here.
          const repoContext = await ensureRepoForTask(effectiveConfig, role, false);
          if (repoContext?.clonePath) {
            resumeCwd = repoContext.clonePath;
          }
        }

        // Per-task runner session ID so session logs are scoped to this task
        const resumeRunnerSessionId = crypto.randomUUID();

        let runningTask: RunningTask;
        try {
          runningTask = await spawnProviderProcess(
            adapter,
            {
              prompt: resumePrompt,
              logFile,
              systemPrompt: resolvedSystemPrompt,
              additionalArgs: opts.additionalArgs,
              // Native resume deprecated: always undefined. Follow-up continuity flows through
              // the context preamble injected above (see context-preamble.ts).
              // resumeResolution is still computed for observability via logResumeResolution.
              resumeSessionId: undefined,
              role,
              apiUrl,
              apiKey,
              agentId,
              runnerSessionId: resumeRunnerSessionId,
              iteration,
              taskId: task.id,
              model: (task as { model?: string }).model,
              modelTier: (task as { modelTier?: string }).modelTier,
              effort: (task as { effort?: ReasoningEffort }).effort,
              harnessProvider: state.harnessProvider,
              cwd: resumeCwd,
              vcsRepo: task.vcsRepo,
              contextKey: (task as { contextKey?: string }).contextKey,
            },
            logDir,
            isYolo,
          );
        } catch (spawnErr) {
          const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          console.error(
            `[${role}] Failed to spawn process for resumed task ${task.id.slice(0, 8)}: ${errMsg}`,
          );
          await ensureTaskFinished(
            apiConfig,
            role,
            task.id,
            1,
            `Spawn failed: ${errMsg}`,
            undefined,
            state.harnessProvider,
          );
          continue;
        }

        state.activeTasks.set(task.id, runningTask);
        registerActiveSession(apiConfig, {
          taskId: task.id,
          triggerType: "task_resumed",
          taskDescription: task.task?.slice(0, 200),
          runnerSessionId: resumeRunnerSessionId,
        });
        console.log(
          `[${role}] Resumed task ${task.id.slice(0, 8)} (${state.activeTasks.size}/${state.maxConcurrent} active)`,
        );
      }

      console.log(`[${role}] All paused tasks resumed. Entering normal polling...`);
    } else {
      console.log(`[${role}] No paused tasks found. Entering normal polling...`);
    }
  } catch (error) {
    console.error(`[${role}] Error checking/resuming paused tasks: ${error}`);
    // Continue to normal polling even if resume fails
  }
  // ========== END: Resume paused tasks ==========

  // ========== Lead startup self-check ==========
  if (isLead) {
    console.log(`[${role}] Running startup heartbeat sweep...`);
    const swept = await triggerHeartbeatSweep(apiConfig);
    if (swept) {
      console.log(`[${role}] Startup heartbeat sweep completed`);
    } else {
      console.warn(`[${role}] Startup heartbeat sweep failed (non-fatal)`);
    }
  }

  // Phase 4 — exponential back-off state for `budget_refused` triggers.
  // Resets to 0 on any non-refused outcome. Lives outside the loop so
  // state persists across iterations.
  let consecutiveBudgetRefusals = 0;

  // Throttle orphan recovery so it runs periodically while the worker is idle or under capacity.
  let lastOrphanRecoveryAt = 0;
  const ORPHAN_RECOVERY_INTERVAL_MS = 60_000;

  while (true) {
    // Ping server on each iteration to keep status updated
    await pingServer(apiConfig, role);

    // Check for completed processes first and ensure tasks are marked as finished
    await checkCompletedProcesses(state, role, apiConfig, cancelledSignaled);

    // Live HARNESS_PROVIDER reconciliation. Re-fetches `swarm_config` (overlaid
    // on env) and swaps the adapter if the resolved provider changed —
    // typically because an operator PATCH'd /api/agents/:id/harness-provider
    // (which writes a swarm_config row) or upserted a config row directly.
    //
    // Safety: in-flight sessions hold their own `ProviderSession` references
    // and continue on the old adapter unaffected. New spawns (below) read
    // the current `adapter` binding and pick up the swap. `basePrompt` is
    // rebuilt because traits (and therefore prompt content) may differ across
    // providers.
    if (Date.now() - lastHarnessReconcileAt > HARNESS_RECONCILE_INTERVAL_MS) {
      lastHarnessReconcileAt = Date.now();
      try {
        const { env: freshEnv, resolvedProvider } = await fetchResolvedEnv(apiUrl, apiKey, agentId);
        const { agentVisibleChanged } = await applySwarmConfigDrift(freshEnv, resolvedProvider);
        if (agentVisibleChanged) {
          // Re-register so the agents row + dashboard reflect the live
          // harness_provider / maxTasks. Idempotent: only writes columns
          // that actually changed (see src/http/agents.ts).
          await reregisterAgent();
        }
      } catch (err) {
        console.warn(`[${role}] [harness] Reconcile fetch failed (non-fatal): ${err}`);
      }
    }

    // Migration 055 — post-task credential refresh, cache-keyed on the
    // *resolved* harness_provider. Re-runs the snapshot when the provider
    // changes (boot, or after a live swap above) so the dashboard shows
    // up-to-date credential status for the active adapter.
    if (!isCredCheckDisabled(process.env)) {
      const currentHarness = state.harnessProvider;
      if (currentHarness !== cachedCredHarnessProvider) {
        cachedCredHarnessProvider = currentHarness;
        buildCredStatusReport(currentHarness, process.env, {}, "post_task")
          .then((snap) => reportCredStatus(apiUrl, apiKey, agentId, snap))
          .catch((err) =>
            console.warn(`[${role}] cred_status post_task report failed (non-fatal): ${err}`),
          );
      } else if (
        currentHarness === "pi" &&
        isBedrockSdkMode(process.env) &&
        Date.now() - lastBedrockRefreshAt > BEDROCK_REFRESH_INTERVAL_MS
      ) {
        // Bedrock enumeration drifts independently of the harness_provider:
        // access granted (or revoked) in the AWS console after boot won't flip
        // the provider, so the harness-change gate above never fires. Re-run the
        // enumeration on the throttled interval so the picker reflects the live
        // account state. One bounded AWS round-trip per tick.
        lastBedrockRefreshAt = Date.now();
        buildCredStatusReport(currentHarness, process.env, {}, "post_task")
          .then((snap) => reportCredStatus(apiUrl, apiKey, agentId, snap))
          .catch((err) =>
            console.warn(`[${role}] bedrock enumeration refresh failed (non-fatal): ${err}`),
          );
      }
    }

    // Periodic VCS detection for running tasks (fire-and-forget, throttled per task)
    const now = Date.now();
    for (const [taskId, task] of state.activeTasks) {
      if (vcsDetectedTasks.has(taskId)) continue;
      const lastCheck = vcsCheckTimestamps.get(taskId) ?? 0;
      if (now - lastCheck < VCS_CHECK_INTERVAL) continue;
      if (!task.workingDir) continue;

      vcsCheckTimestamps.set(taskId, now);
      detectVcsForTask(apiUrl, apiKey, taskId, task.workingDir);
    }

    // Check for cancelled tasks and signal their subprocesses
    if (state.activeTasks.size > 0) {
      for (const [taskId, task] of state.activeTasks) {
        if (cancelledSignaled.has(taskId)) continue; // Already sent SIGTERM
        try {
          const cancelResp = await fetch(
            `${apiUrl}/cancelled-tasks?taskId=${encodeURIComponent(taskId)}`,
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "X-Agent-ID": agentId,
              },
            },
          );
          if (cancelResp.ok) {
            const cancelData = (await cancelResp.json()) as {
              cancelled: Array<{ id: string }>;
            };
            if (cancelData.cancelled?.some((t) => t.id === taskId)) {
              console.log(
                `[${role}] Task ${taskId.slice(0, 8)} was cancelled — sending SIGTERM to subprocess`,
              );
              task.session.abort("cancelled").catch(() => {});
              cancelledSignaled.add(taskId);
            }
          }
        } catch {
          // Non-blocking — cancellation check is best-effort
        }
      }
    }

    // Only poll if we have capacity
    if (state.activeTasks.size < state.maxConcurrent) {
      if (Date.now() - lastOrphanRecoveryAt > ORPHAN_RECOVERY_INTERVAL_MS) {
        lastOrphanRecoveryAt = Date.now();
        const recoveredOrphans = await recoverOrphanedInProgressTasks(apiConfig);
        if (recoveredOrphans > 0) {
          console.log(
            `[${role}] Recovered ${recoveredOrphans} orphaned in-progress task(s) to pending`,
          );
        }
      }

      console.log(
        `[${role}] Polling for triggers (${state.activeTasks.size}/${state.maxConcurrent} active)...`,
      );

      // Use shorter timeout if tasks are running (to check completion more often)
      const effectiveTimeout = state.activeTasks.size > 0 ? 5000 : PollTimeoutMs;

      const trigger = await pollForTrigger({
        apiUrl,
        apiKey,
        agentId,
        pollInterval: PollIntervalMs,
        pollTimeout: effectiveTimeout,
      });

      if (trigger) {
        // Phase 4 — server refused to admit a claim because the agent or
        // global budget is exhausted. Log a structured payload (scrubbed
        // at egress per project convention) and back off exponentially.
        // We deliberately `continue` BEFORE the empty-poll counter logic
        // below — refusals are not empty polls.
        if (trigger.type === "budget_refused") {
          consecutiveBudgetRefusals++;
          const backoffMs = computeBudgetBackoffMs(consecutiveBudgetRefusals, PollIntervalMs);
          const refusalPayload = JSON.stringify({
            event: "budget_refused",
            cause: trigger.cause,
            agentSpend: trigger.agentSpend,
            agentBudget: trigger.agentBudget,
            globalSpend: trigger.globalSpend,
            globalBudget: trigger.globalBudget,
            resetAt: trigger.resetAt,
            consecutiveRefusals: consecutiveBudgetRefusals,
            backoffMs,
          });
          console.log(
            `[${role}] budget_refused — backing off ${backoffMs}ms: ${scrubSecrets(refusalPayload)}`,
          );
          await Bun.sleep(backoffMs);
          continue;
        }

        // Any other non-null trigger means we're being admitted normally —
        // reset the back-off so the next refusal starts at base interval.
        consecutiveBudgetRefusals = 0;

        console.log(`[${role}] Trigger received: ${trigger.type}`);

        if (
          trigger.taskId &&
          (trigger.type === "task_assigned" || trigger.type === "task_offered")
        ) {
          ensure({
            id: "worker_received",
            flow: "task",
            runId: trigger.taskId,
            depIds: ["started"],
            data: {
              taskId: trigger.taskId,
              agentId,
              triggerType: trigger.type,
              role,
            },
            // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
            filter: ({}, ctx) => ctx.deps.length > 0,
            conditions: [{ timeout_ms: 60_000 }], // 1 min: immediate after poll
          });
        }

        // Build prompt based on trigger
        let triggerPrompt = await buildPromptForTrigger(
          trigger,
          prompt,
          adapter.formatCommand.bind(adapter),
          { hasMcp: adapter.traits.hasMcp },
        );

        // Enrich prompt with relevant memories from past sessions
        if (trigger.type === "task_assigned" || trigger.type === "task_offered") {
          const task =
            trigger.task && typeof trigger.task === "object" && "task" in trigger.task
              ? (trigger.task as { task: string; id?: string; contextKey?: string })
              : null;
          if (task?.task) {
            const memoryContext = await fetchRelevantMemories(
              apiUrl,
              apiKey,
              agentId,
              task.task,
              task.id,
              task.contextKey,
            );
            if (memoryContext) {
              triggerPrompt += memoryContext;
              console.log(`[${role}] Injected relevant memories into task prompt`);
            }
          }
        }

        // Universal context preamble: inject for all providers when task is a follow-up.
        // Gives non-resumable providers (opencode/pi/devin) prior-task context; also
        // acts as a bounded safety net for resumable ones (claude/codex).
        // For taskType="resume" (created by supersedeTaskViaAPI), use the
        // larger resume preamble that includes a session-log tool-call summary.
        const taskObj = trigger.task as { parentTaskId?: string; taskType?: string } | undefined;
        if (taskObj?.parentTaskId && apiUrl) {
          const isResumeTask = taskObj.taskType === "resume";
          const contextPreamble = isResumeTask
            ? await buildResumeContextPreamble(apiUrl, apiKey, taskObj.parentTaskId)
            : await buildContextPreamble(apiUrl, apiKey, taskObj.parentTaskId);
          if (contextPreamble) {
            triggerPrompt = contextPreamble + triggerPrompt;
            console.log(
              `[${role}] Injected ${isResumeTask ? "resume" : "context"} preamble for ${
                isResumeTask ? "resume" : "follow-up"
              } task (parent: ${taskObj.parentTaskId.slice(0, 8)})`,
            );
          }
        }

        // Resolve provider-aware resume for child tasks with parentTaskId.
        let resumeSessionId: string | undefined;
        if (taskObj?.parentTaskId) {
          const parentSession = await fetchProviderSessionInfo(
            apiUrl,
            apiKey,
            taskObj.parentTaskId,
          );
          if (parentSession?.sessionId) {
            const resumeResolution = resolveResumeSession(state.harnessProvider, [
              {
                source: "parent",
                taskId: taskObj.parentTaskId,
                sessionId: parentSession.sessionId,
                provider: parentSession.provider,
                providerMeta: parentSession.providerMeta,
              },
            ]);
            logResumeResolution(role, resumeResolution);
            // Native resume deprecated: keep `resumeSessionId` undefined so a fresh
            // session is spawned. Follow-up continuity flows via the context preamble
            // injected above (see context-preamble.ts).
          } else {
            console.log(`[${role}] Child task — parent session ID not found, starting fresh`);
          }
        }

        // Extract model from task data for per-task model selection
        const taskModel = (trigger.task as { model?: string } | undefined)?.model;
        const taskModelTier = (trigger.task as { modelTier?: string } | undefined)?.modelTier;
        const taskEffort = (trigger.task as { effort?: ReasoningEffort } | undefined)?.effort;
        const taskContextKey = (trigger.task as { contextKey?: string } | undefined)?.contextKey;

        // Detect Slack context for conditional prompt sections
        const taskSlackChannelId = (trigger.task as { slackChannelId?: string } | undefined)
          ?.slackChannelId;
        const taskSlackThreadTs = (trigger.task as { slackThreadTs?: string } | undefined)
          ?.slackThreadTs;
        currentTaskSlackContext = taskSlackChannelId
          ? { channelId: taskSlackChannelId, threadTs: taskSlackThreadTs }
          : undefined;

        // Handle repo context for tasks with vcsRepo (GitHub/GitLab)
        const taskVcsRepo = (trigger.task as { vcsRepo?: string } | undefined)?.vcsRepo;
        if (taskVcsRepo && apiUrl) {
          const repoConfig = await fetchRepoConfig(apiUrl, apiKey, taskVcsRepo);
          // Fall back to convention-based config if repo is not registered
          const effectiveConfig = repoConfig ?? {
            url: taskVcsRepo,
            name: taskVcsRepo.split("/").pop() || taskVcsRepo,
            clonePath: `/workspace/personal/repos/${taskVcsRepo.split("/").pop() || taskVcsRepo}`,
            defaultBranch: "main",
          };
          // First kickoff = a genuinely new root task: not a continuation
          // task-type, and not parent-linked to a still-active task (Slack
          // follow-ups / sibling-awareness wire parentTaskId with no
          // reserved taskType). See isFirstKickoffTask() for the full
          // reasoning and CONTINUATION_TASK_TYPES for the denylist.
          const isFirstKickoff = await isFirstKickoffTask(taskObj, (parentTaskId) =>
            fetchTaskStatus(apiUrl, apiKey, parentTaskId),
          );
          const repoResult = await ensureRepoForTask(effectiveConfig, role, isFirstKickoff);
          currentRepoContext = {
            ...repoResult,
            guidelines: repoConfig?.guidelines ?? null,
          };
        } else {
          currentRepoContext = undefined;
        }

        // Resolve effective working directory (priority: task.dir > repoContext.clonePath > process.cwd())
        const taskDir = (trigger.task as { dir?: string } | undefined)?.dir;
        let effectiveCwd: string | undefined;

        if (taskDir) {
          try {
            if (existsSync(taskDir) && statSync(taskDir).isDirectory()) {
              effectiveCwd = taskDir;
            } else {
              console.warn(
                `[${role}] Task dir "${taskDir}" does not exist or is not a directory, falling back to default cwd`,
              );
            }
          } catch {
            console.warn(
              `[${role}] Failed to check task dir "${taskDir}", falling back to default cwd`,
            );
          }
        }

        if (!effectiveCwd && currentRepoContext?.clonePath) {
          effectiveCwd = currentRepoContext.clonePath;
        }

        // Annotate prompt with working directory context
        if (effectiveCwd && effectiveCwd !== process.cwd()) {
          triggerPrompt += `\n\n---\n**Working Directory**: You are starting in \`${effectiveCwd}\`. `;
          if (taskDir) {
            triggerPrompt += "This was explicitly set on the task.";
          } else if (currentRepoContext?.clonePath) {
            triggerPrompt += "This is the repository clone path for this task's VCS repo.";
          }
          triggerPrompt +=
            " You can still access any path on the filesystem — this is just your starting directory.";
        }

        // Warn in system prompt when task dir was specified but doesn't exist
        let cwdWarning = "";
        if (taskDir && !effectiveCwd) {
          cwdWarning = `\n\nNote: The task requested working directory "${taskDir}" but it does not exist. Falling back to default directory.`;
        }

        // Per-task skill hot-reload. Reuses the boot-time helper; signature
        // probe short-circuits when nothing changed. Skipped for
        // `claude-managed`. Read state.harnessProvider live so an adapter
        // swap mid-loop honors the new provider.
        if (state.harnessProvider !== "claude-managed") {
          const skillResult = await refreshSkillsIfChanged(
            { apiUrl, swarmUrl, apiKey, agentId, role },
            lastSkillHash,
          );
          if (skillResult.changed && skillResult.summary) {
            agentSkillsSummary = skillResult.summary;
            console.log(
              `[${role}] Skills changed — refreshing system prompt (${agentSkillsSummary.length} skills)`,
            );
          }
        }

        // Rebuild system prompt with per-task repo context
        const taskBasePrompt = await buildSystemPrompt();
        const requesterProfilePrompt = await buildRequesterProfilePrompt(trigger.requestedBy);
        const taskPromptParts = [taskBasePrompt, requesterProfilePrompt, additionalSystemPrompt]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");
        const taskSystemPrompt = taskPromptParts + cwdWarning;

        iteration++;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const taskIdSlice = trigger.taskId?.slice(0, 8) || "notask";
        const logFile = `${logDir}/${timestamp}-${taskIdSlice}.jsonl`;

        console.log(`\n[${role}] === Iteration ${iteration} ===`);
        console.log(`[${role}] Logging to: ${logFile}`);
        console.log(`[${role}] Prompt: ${triggerPrompt.slice(0, 100)}...`);
        if (effectiveCwd) {
          console.log(`[${role}] Working directory: ${effectiveCwd}`);
        }

        const metadata = {
          type: metadataType,
          sessionId,
          iteration,
          timestamp: new Date().toISOString(),
          prompt: triggerPrompt,
          trigger: trigger.type,
          yolo: isYolo,
        };
        await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

        // Per-task runner session ID so session logs are scoped to this task
        const taskRunnerSessionId = crypto.randomUUID();

        // Spawn without blocking (await to set up session, but process runs async)
        let runningTask: RunningTask;
        try {
          runningTask = await spawnProviderProcess(
            adapter,
            {
              prompt: triggerPrompt,
              logFile,
              systemPrompt: taskSystemPrompt,
              additionalArgs: opts.additionalArgs,
              resumeSessionId,
              role,
              apiUrl,
              apiKey,
              agentId,
              runnerSessionId: taskRunnerSessionId,
              iteration,
              taskId: trigger.taskId,
              model: taskModel,
              modelTier: taskModelTier,
              effort: taskEffort,
              harnessProvider: state.harnessProvider,
              cwd: effectiveCwd,
              vcsRepo: taskVcsRepo,
              contextKey: taskContextKey,
            },
            logDir,
            isYolo,
          );
        } catch (spawnErr) {
          const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          console.error(
            `[${role}] Failed to spawn process for task ${trigger.taskId?.slice(0, 8) || "unknown"}: ${errMsg}`,
          );
          if (trigger.taskId) {
            await ensureTaskFinished(
              apiConfig,
              role,
              trigger.taskId,
              1,
              `Spawn failed: ${errMsg}`,
              undefined,
              state.harnessProvider,
            );
          }
          continue;
        }

        ensure({
          id: "worker_process_spawned",
          flow: "task",
          runId: runningTask.taskId,
          depIds: ["worker_received"],
          data: {
            taskId: runningTask.taskId,
            agentId,
            role,
            model: taskModel,
          },
          // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
          filter: ({}, ctx) => ctx.deps.length > 0,
          conditions: [{ timeout_ms: 60_000 }], // 1 min: process startup
        });

        // Attach trigger metadata for logging
        runningTask.triggerType = trigger.type;
        runningTask.workingDir = effectiveCwd;

        // Attach deferred cursor updates for channel_activity triggers
        if (trigger.type === "channel_activity" && trigger.cursorUpdates) {
          runningTask.cursorUpdates = trigger.cursorUpdates as Array<{
            channelId: string;
            ts: string;
          }>;
        }

        state.activeTasks.set(runningTask.taskId, runningTask);

        // Register active session for concurrency awareness
        const taskDesc =
          trigger.task && typeof trigger.task === "object" && "task" in trigger.task
            ? String((trigger.task as { task: string }).task).slice(0, 200)
            : undefined;
        registerActiveSession(apiConfig, {
          taskId: runningTask.taskId,
          triggerType: trigger.type,
          taskDescription: taskDesc,
          runnerSessionId: taskRunnerSessionId,
        });

        console.log(
          `[${role}] Started task ${runningTask.taskId.slice(0, 8)} (${state.activeTasks.size}/${state.maxConcurrent} active, trigger: ${trigger.type})`,
        );
      }
    } else {
      console.log(
        `[${role}] At capacity (${state.activeTasks.size}/${state.maxConcurrent}), waiting for completion...`,
      );
      await Bun.sleep(1000);
    }
  }
}
