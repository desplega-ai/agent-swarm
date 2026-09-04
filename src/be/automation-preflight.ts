import type { AutomationIntegrationId, ScheduledTask, Workflow } from "@/types";
import { getDbClient } from "./db";
import { getOAuthApp, getOAuthTokens } from "./db-queries/oauth";

export type AutomationKind = "schedule" | "workflow";
export type AutomationState = "running" | "needs_setup";
export type AutomationIntegrationState = "unverified" | "configured" | "verified";

export interface AutomationSetupStates {
  slack: AutomationIntegrationState;
  github: AutomationIntegrationState;
  linear: AutomationIntegrationState;
  jira: AutomationIntegrationState;
  gsc: AutomationIntegrationState;
  agentmail: AutomationIntegrationState;
  agentfs: AutomationIntegrationState;
}

export interface AutomationPreflightInput {
  id: string;
  name: string;
  kind: AutomationKind;
  params?: Record<string, unknown>;
  requiredParams?: string[];
  requires?: AutomationIntegrationId[];
}

export interface AutomationPreflightResult {
  id: string;
  name: string;
  kind: AutomationKind;
  state: AutomationState;
  missing: {
    params: string[];
    integrations: AutomationIntegrationId[];
  };
  fixes: Array<
    | { type: "param"; key: string; url: string }
    | { type: "integration"; key: AutomationIntegrationId; url: string }
  >;
  fixUrl: string;
  failureReason?: string;
}

type AutomationPreflightRow = {
  id: string;
  name: string;
  kind: AutomationKind;
  params: string;
  requiredParams: string;
  requires: string;
};

const NEEDS_SETUP_PREFIX = "needs_setup:";

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const GITHUB_REPOSITORY_SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\.git)?$/;
const SAFE_SHELL_DATA = /^[A-Za-z0-9._~%/:@ -]+$/;
const DNS_NAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_GIT_REF = /^(?!-)(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+$/;
const SAFE_TAG_PATTERN = /^(?!-)(?!.*(?:\.\.|\/\/))[A-Za-z0-9._*?/-]+$/;
const SAFE_RELATIVE_PATH = /^(?![-/])(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SAFE_REPORT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

function isSafeRepository(value: string): boolean {
  if (!SAFE_SHELL_DATA.test(value) || value.trim() !== value || value.includes(" ")) return false;
  const slug = value
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\/$/, "");
  return GITHUB_REPOSITORY_SLUG.test(slug);
}

function isSafeGscProperty(value: string): boolean {
  if (!SAFE_SHELL_DATA.test(value) || value.trim() !== value) return false;
  return value.split(" ").every((property) => {
    if (!property) return false;
    if (property.startsWith("sc-domain:")) return DNS_NAME.test(property.slice(10));
    if (DNS_NAME.test(property)) return true;
    try {
      const url = new URL(property);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        DNS_NAME.test(url.hostname)
      );
    } catch {
      return false;
    }
  });
}

const PARAM_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  REPO_URL: (value) => typeof value === "string" && isSafeRepository(value),
  GSC_PROPERTY: (value) => typeof value === "string" && isSafeGscProperty(value),
  BRANCH: (value) => typeof value === "string" && SAFE_GIT_REF.test(value),
  SCOPE_PATH: (value) => typeof value === "string" && SAFE_RELATIVE_PATH.test(value),
  REPORT_NAME: (value) =>
    typeof value === "string" && value.trim() === value && SAFE_REPORT_NAME.test(value),
  TAG_PATTERN: (value) => typeof value === "string" && SAFE_TAG_PATTERN.test(value),
  AGENT_FS_ORG_ID: (value) => typeof value === "string" && SAFE_EXTERNAL_ID.test(value),
  ORG_ID: (value) => typeof value === "string" && SAFE_EXTERNAL_ID.test(value),
};

/** Validate every install parameter consumed by the seeded automation templates. */
function isUsableParam(key: string, value: unknown): boolean {
  if (!hasValue(value)) return false;
  return PARAM_VALIDATORS[key]?.(value) ?? true;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function automationUrl(input: AutomationPreflightInput): string {
  return input.kind === "schedule" ? `/schedules/${input.id}` : `/workflows/${input.id}`;
}

const INTEGRATION_FIX_URL: Record<AutomationIntegrationId, string> = {
  slack: "/settings/integrations/slack",
  github: "/settings/integrations/github",
  linear: "/settings/integrations/linear",
  jira: "/settings/integrations/jira",
  agentmail: "/settings/integrations/agentmail",
  gsc: "/settings/integrations/gsc",
  agentfs: "/settings/integrations/agentfs",
};

// Requiring one of these bindings is the persisted signal that the v4 matrix
// classifies an automation's first failure as integration-first. Other rows
// keep parameter-first behavior, including alerts-triage's channel picker.
const INTEGRATION_FIRST_REQUIREMENTS = new Set<AutomationIntegrationId>([
  "gsc",
  "linear",
  "agentmail",
]);

export function automationIntegrationFixUrl(id: AutomationIntegrationId): string {
  return INTEGRATION_FIX_URL[id];
}

export function isNeedsSetupFailure(reason: string | null | undefined): reason is string {
  return reason?.startsWith(NEEDS_SETUP_PREFIX) ?? false;
}

export function preflightAutomation(
  input: AutomationPreflightInput,
  setup: AutomationSetupStates,
): AutomationPreflightResult {
  const params = input.params ?? {};
  const guardedParams = Object.keys(params).filter((key) => key in PARAM_VALIDATORS);
  const missingParams = uniqueSorted(
    [...(input.requiredParams ?? []), ...guardedParams].filter(
      (key) => !isUsableParam(key, params[key]),
    ),
  );
  const missingIntegrations = uniqueSorted(
    (input.requires ?? []).filter((id) => setup[id] === "unverified"),
  );
  const missing = { params: missingParams, integrations: missingIntegrations };
  const baseUrl = automationUrl(input);
  const fixes: AutomationPreflightResult["fixes"] = [
    ...missingParams.map((key) => ({
      type: "param" as const,
      key,
      url: `${baseUrl}?param=${encodeURIComponent(key)}`,
    })),
    ...missingIntegrations.map((key) => ({
      type: "integration" as const,
      key,
      url: automationIntegrationFixUrl(key),
    })),
  ];

  if (missingParams.length === 0 && missingIntegrations.length === 0) {
    return {
      id: input.id,
      name: input.name,
      kind: input.kind,
      state: "running",
      missing,
      fixes,
      fixUrl: baseUrl,
    };
  }

  const firstParam = missingParams[0];
  const firstIntegration = (input.requires ?? []).find((id) => missingIntegrations.includes(id));
  const integrationFirst = (input.requires ?? []).some((id) =>
    INTEGRATION_FIRST_REQUIREMENTS.has(id),
  );
  const fixUrl =
    integrationFirst && firstIntegration
      ? automationIntegrationFixUrl(firstIntegration)
      : firstParam
        ? `${baseUrl}?param=${encodeURIComponent(firstParam)}`
        : firstIntegration
          ? automationIntegrationFixUrl(firstIntegration)
          : baseUrl;
  const failureReason = `${NEEDS_SETUP_PREFIX} params=[${missingParams.join(",")}] integrations=[${missingIntegrations.join(",")}]`;

  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    state: "needs_setup",
    missing,
    fixes,
    fixUrl,
    failureReason,
  };
}

const EXACT_TOKEN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Render only keys explicitly present in params; workflow runtime tokens stay untouched. */
export function renderAutomationTokens<T>(value: T, params: Record<string, unknown>): T {
  function render(current: unknown): unknown {
    if (typeof current === "string") {
      const exact = EXACT_TOKEN.exec(current);
      if (exact?.[1] && Object.hasOwn(params, exact[1])) return params[exact[1]];
      return current.replace(TOKEN, (token, key: string) => {
        if (!Object.hasOwn(params, key)) return token;
        const replacement = params[key];
        return typeof replacement === "object" ? JSON.stringify(replacement) : String(replacement);
      });
    }
    if (Array.isArray(current)) return current.map(render);
    if (current != null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, nested]) => [key, render(nested)]),
      );
    }
    return current;
  }

  return render(value) as T;
}

function enabled(flag: string | undefined): boolean {
  return flag !== "true" && flag !== "1";
}

function present(value: string | undefined): boolean {
  return !!value?.trim();
}

/** Shared integration truth used by both runtime preflight and GET /status. */
export async function getAutomationSetupStates(): Promise<AutomationSetupStates> {
  const [linearTokens, jiraTokens, jiraApp] = await Promise.all([
    getOAuthTokens("linear"),
    getOAuthTokens("jira"),
    getOAuthApp("jira"),
  ]);
  let jiraCloudId = false;
  try {
    const metadata = jiraApp?.metadata ? JSON.parse(jiraApp.metadata) : null;
    jiraCloudId = !!(metadata && typeof metadata === "object" && metadata.cloudId);
  } catch {
    jiraCloudId = false;
  }

  const agentFsKey = process.env.API_AGENT_FS_API_KEY ?? process.env.AGENT_FS_API_KEY;
  const agentFsOrg = process.env.AGENT_FS_DEFAULT_ORG_ID ?? process.env.AGENT_FS_SHARED_ORG_ID;
  const gscConfigured =
    present(process.env.GSC_SERVICE_ACCOUNT_BASE64) ||
    present(process.env.GSC_SERVICE_ACCOUNT_JSON);

  return {
    slack:
      enabled(process.env.SLACK_DISABLE) &&
      present(process.env.SLACK_BOT_TOKEN) &&
      present(process.env.SLACK_APP_TOKEN)
        ? "verified"
        : "unverified",
    github:
      present(process.env.GITHUB_WEBHOOK_SECRET) &&
      present(process.env.GITHUB_APP_ID) &&
      present(process.env.GITHUB_APP_PRIVATE_KEY)
        ? "verified"
        : "unverified",
    linear: linearTokens ? "verified" : "unverified",
    jira: jiraTokens && jiraCloudId ? "verified" : "unverified",
    gsc: gscConfigured ? "verified" : "unverified",
    agentmail:
      enabled(process.env.AGENTMAIL_DISABLE) && present(process.env.AGENTMAIL_API_KEY)
        ? "verified"
        : "unverified",
    agentfs:
      present(process.env.AGENT_FS_API_URL) &&
      present(agentFsKey) &&
      present(agentFsOrg) &&
      present(process.env.AGENT_FS_DEFAULT_DRIVE_ID)
        ? "verified"
        : "unverified",
  };
}

export function schedulePreflightInput(schedule: ScheduledTask): AutomationPreflightInput {
  return { ...schedule, kind: "schedule" };
}

export function workflowPreflightInput(workflow: Workflow): AutomationPreflightInput {
  return { ...workflow, kind: "workflow" };
}

/** Load only the setup metadata needed by the globally polled status endpoint. */
export async function listEnabledAutomationPreflightInputs(): Promise<AutomationPreflightInput[]> {
  const rows = await getDbClient().query<AutomationPreflightRow>(
    `SELECT id, name, 'schedule' AS kind, params, requiredParams, requires
     FROM scheduled_tasks
     WHERE enabled = 1
     UNION ALL
     SELECT id, name, 'workflow' AS kind, params, requiredParams, requires
     FROM workflows
     WHERE enabled = 1`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    params: JSON.parse(row.params) as Record<string, unknown>,
    requiredParams: JSON.parse(row.requiredParams) as string[],
    requires: JSON.parse(row.requires) as AutomationIntegrationId[],
  }));
}

function utcDayBounds(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

/** Record at most one copy of the same setup failure on a schedule per UTC day. */
export async function recordSchedulePreflightFailure(
  scheduleId: string,
  failureReason: string,
  now: Date = new Date(),
): Promise<boolean> {
  return await getDbClient().transaction(async (tx) => {
    const row = await tx.get<{ lastErrorAt: string | null; lastErrorMessage: string | null }>(
      "SELECT lastErrorAt, lastErrorMessage FROM scheduled_tasks WHERE id = ?",
      [scheduleId],
    );
    if (!row) return false;
    if (
      row.lastErrorMessage === failureReason &&
      row.lastErrorAt?.slice(0, 10) === now.toISOString().slice(0, 10)
    ) {
      return false;
    }
    await tx.run(
      `UPDATE scheduled_tasks
       SET lastErrorAt = ?, lastErrorMessage = ?, lastUpdatedAt = ?
       WHERE id = ?`,
      [now.toISOString(), failureReason, now.toISOString(), scheduleId],
    );
    return true;
  });
}

/** Create and finish at most one failed preflight run per workflow and UTC day. */
export async function recordWorkflowPreflightFailure(input: {
  workflowId: string;
  triggerType: "schedule" | "manual" | "event" | "api";
  triggerData: unknown;
  failureReason: string;
  createdBy?: string;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const bounds = utcDayBounds(now);
  return await getDbClient().transaction(async (tx) => {
    const existing = await tx.get<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE workflowId = ? AND status = 'failed'
         AND error LIKE 'needs_setup:%'
         AND startedAt >= ? AND startedAt < ?
       ORDER BY startedAt ASC LIMIT 1`,
      [input.workflowId, bounds.start, bounds.end],
    );
    if (existing) return existing.id;

    const runId = crypto.randomUUID();
    const timestamp = now.toISOString();
    await tx.run(
      `INSERT INTO workflow_runs
         (id, workflowId, status, triggerType, triggerData, error, created_by,
          startedAt, lastUpdatedAt, finishedAt)
       VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        input.workflowId,
        input.triggerType,
        input.triggerData === undefined ? null : JSON.stringify(input.triggerData),
        input.failureReason,
        input.createdBy ?? null,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    return runId;
  });
}
