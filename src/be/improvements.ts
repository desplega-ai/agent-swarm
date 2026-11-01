/**
 * Improvements: short product comments an install sends to desplega through
 * the telemetry proxy (`POST /v1/improvements`).
 *
 * Invariants:
 * - An agent can only draft. A row leaves `pending_approval` only through
 *   `approveAndSend`, whose caller passes the approving person taken from the
 *   credential (a user id or `operator`). The DB refuses a `sending` / `sent`
 *   row without `approved_by`.
 * - Exactly `install_id`, `text` and `email` leave the install, built by
 *   `buildImprovementPayload`. All three always go: the approver must give a
 *   valid email, and `install_id` is minted here when telemetry never did.
 * - `IMPROVEMENTS_ENABLED=false` refuses every create, send and discard.
 */
import { parseEnvFlag } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient, getSwarmConfigs, upsertSwarmConfig } from "./db";

export const IMPROVEMENTS_ENABLED_KEY = "IMPROVEMENTS_ENABLED";
export const IMPROVEMENT_TEXT_MAX = 4000;
const SEND_TIMEOUT_MS = 10_000;
const PROXY_ERROR_MAX = 1024;
const LEAK_HINTS_MAX = 50;
const INSTALL_ID_KEY = "telemetry_installation_id";
const EMAIL_MAX = 320;
const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A trimmed email of at most 320 characters with a local part, an `@` and a dotted domain. */
export function isValidImprovementEmail(value: string | null | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && trimmed.length <= EMAIL_MAX && VALID_EMAIL_RE.test(trimmed);
}

export const IMPROVEMENT_STATUSES = [
  "pending_approval",
  "sending",
  "sent",
  "failed",
  "discarded",
] as const;
export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
export const IMPROVEMENT_SOURCES = ["mcp", "api", "ui"] as const;
export type ImprovementSource = (typeof IMPROVEMENT_SOURCES)[number];

export type Improvement = {
  id: string;
  text: string;
  email: string | null;
  status: ImprovementStatus;
  source: ImprovementSource;
  requestedByAgentId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  proxyStatus: number | null;
  proxyId: string | null;
  proxyError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ImprovementRow = {
  id: string;
  text: string;
  email: string | null;
  status: ImprovementStatus;
  source: ImprovementSource;
  requested_by_agent_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  proxy_status: number | null;
  proxy_id: string | null;
  proxy_error: string | null;
  created_at: string;
  updated_at: string;
};

function toImprovement(row: ImprovementRow): Improvement {
  return {
    id: row.id,
    text: row.text,
    email: row.email,
    status: row.status,
    source: row.source,
    requestedByAgentId: row.requested_by_agent_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    proxyStatus: row.proxy_status,
    proxyId: row.proxy_id,
    proxyError: row.proxy_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ImprovementErrorCode =
  | "improvements_disabled"
  | "invalid_text"
  | "invalid_email"
  | "not_found"
  | "conflict";

export class ImprovementError extends Error {
  constructor(
    readonly code: ImprovementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImprovementError";
  }
}

/** A global config value, stored rows first, then the deployment env. */
async function globalValue(key: string): Promise<string | undefined> {
  const stored = (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value;
  return (stored ?? process.env[key])?.trim() || undefined;
}

/** The kill switch. On unless `IMPROVEMENTS_ENABLED` is set to false. */
export async function isImprovementsEnabled(): Promise<boolean> {
  return parseEnvFlag(await globalValue(IMPROVEMENTS_ENABLED_KEY), true);
}

async function assertEnabled(): Promise<void> {
  if (!(await isImprovementsEnabled())) {
    throw new ImprovementError(
      "improvements_disabled",
      "Improvements are turned off (IMPROVEMENTS_ENABLED=false).",
    );
  }
}

export type ImprovementPayload = { install_id: string; text: string; email: string };

/**
 * The only body that leaves the install. It copies exactly three named fields,
 * so no row, config or agent value can ride along.
 */
export function buildImprovementPayload(input: {
  installId: string;
  text: string;
  email: string;
}): ImprovementPayload {
  return { install_id: input.installId, text: input.text, email: input.email };
}

/**
 * The install id, whether or not telemetry is on. An install that never ran
 * with telemetry has none, so the first send mints one in the telemetry
 * format and stores it under the same key: turning telemetry on later reuses
 * it. The read and the insert share one write transaction, so two first
 * sends cannot mint two ids.
 */
export async function improvementInstallId(): Promise<string> {
  return getDbClient().transaction(async () => {
    const existing = await globalValue(INSTALL_ID_KEY);
    if (existing) return existing;
    const minted = `install_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await upsertSwarmConfig({ scope: "global", key: INSTALL_ID_KEY, value: minted });
    return minted;
  });
}

export async function getImprovement(id: string): Promise<Improvement | null> {
  const row = await getDbClient().get<ImprovementRow>("SELECT * FROM improvements WHERE id = ?", [
    id,
  ]);
  return row ? toImprovement(row) : null;
}

/**
 * Every row a person still has to act on (`pending_approval`, `failed`), plus
 * the newest `historyLimit` other rows, newest first. Only history is capped:
 * an actionable draft must stay reachable however many newer rows exist.
 */
export async function listImprovements(historyLimit = 100): Promise<Improvement[]> {
  const rows = await getDbClient().query<ImprovementRow>(
    `SELECT * FROM improvements WHERE status IN ('pending_approval', 'failed')
     UNION ALL
     SELECT * FROM (
       SELECT * FROM improvements WHERE status NOT IN ('pending_approval', 'failed')
        ORDER BY created_at DESC, id DESC LIMIT ?
     )
     ORDER BY created_at DESC, id DESC`,
    [historyLimit],
  );
  return rows.map(toImprovement);
}

/**
 * Store a draft as `pending_approval`. The text is scrubbed before it is
 * stored; `scrubChanged` tells a person's direct send to stop at pending, so
 * they see the redacted text before it leaves.
 */
export async function createImprovement(input: {
  text: string;
  source: ImprovementSource;
  requestedByAgentId?: string | null;
  createdBy?: string | null;
}): Promise<{ improvement: Improvement; scrubChanged: boolean }> {
  await assertEnabled();
  const trimmed = input.text.trim();
  const scrubbed = scrubSecrets(trimmed);
  if (scrubbed.length === 0 || scrubbed.length > IMPROVEMENT_TEXT_MAX) {
    throw new ImprovementError(
      "invalid_text",
      `Text must be 1 to ${IMPROVEMENT_TEXT_MAX} characters after trimming.`,
    );
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO improvements
       (id, text, status, source, requested_by_agent_id, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scrubbed,
      input.source,
      input.requestedByAgentId ?? null,
      now,
      now,
      input.createdBy ?? null,
      input.createdBy ?? null,
    ],
  );
  const improvement = await getImprovement(id);
  if (!improvement) throw new Error(`Improvement ${id} vanished after insert`);
  return { improvement, scrubChanged: scrubbed !== trimmed };
}

/**
 * Approve a draft and send it. `approvedBy` must come from the caller's
 * credential (a user id or `operator`), never from a request body. `email` is
 * required: a draft carries none until its approver gives one. The claim
 * (`pending_approval` or `failed` → `sending`) is one conditional UPDATE, so a
 * double approve gets a conflict instead of a second send. There is no
 * automatic retry: the proxy has no idempotency key.
 */
export async function approveAndSend(
  id: string,
  approval: {
    approvedBy: string;
    email: string;
    endpoint: string;
    updatedBy?: string | null;
  },
): Promise<Improvement> {
  await assertEnabled();
  if (!isValidImprovementEmail(approval.email)) {
    throw new ImprovementError("invalid_email", "A valid email is required to send.");
  }
  const email = approval.email.trim();
  // Resolved before the claim, so a failed mint cannot strand a row in `sending`.
  const installId = await improvementInstallId();
  const approvedAt = new Date().toISOString();
  const claimed = await getDbClient().transaction(async (tx) => {
    const result = await tx.run(
      `UPDATE improvements
          SET status = 'sending', approved_by = ?, approved_at = ?, email = ?,
              proxy_status = NULL, proxy_id = NULL, proxy_error = NULL,
              updated_at = ?, updated_by = ?
        WHERE id = ? AND status IN ('pending_approval', 'failed')`,
      [approval.approvedBy, approvedAt, email, approvedAt, approval.updatedBy ?? null, id],
    );
    if (result.changes === 1) {
      return tx.get<ImprovementRow>("SELECT * FROM improvements WHERE id = ?", [id]);
    }
    return null;
  });
  if (!claimed) {
    const existing = await getImprovement(id);
    if (!existing) throw new ImprovementError("not_found", `Improvement ${id} not found.`);
    throw new ImprovementError(
      "conflict",
      `Improvement ${id} is ${existing.status}; only pending or failed improvements can be approved.`,
    );
  }

  const payload = buildImprovementPayload({
    installId,
    text: claimed.text,
    email,
  });
  let proxyStatus: number | null = null;
  let proxyId: string | null = null;
  let proxyError: string | null = null;
  try {
    const response = await fetch(approval.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    proxyStatus = response.status;
    const body = await response.text().catch(() => "");
    if (response.ok) {
      try {
        const parsed = JSON.parse(body) as { id?: unknown };
        proxyId = typeof parsed.id === "string" ? parsed.id : null;
      } catch {
        proxyId = null;
      }
    } else {
      proxyError = body || `HTTP ${response.status}`;
    }
  } catch (error) {
    proxyError = error instanceof Error ? error.message : String(error);
  }

  const sent = proxyStatus !== null && proxyStatus >= 200 && proxyStatus < 300;
  const finishedAt = new Date().toISOString();
  await getDbClient().run(
    `UPDATE improvements
        SET status = ?, sent_at = ?, proxy_status = ?, proxy_id = ?, proxy_error = ?, updated_at = ?
      WHERE id = ?`,
    [
      sent ? "sent" : "failed",
      sent ? finishedAt : null,
      proxyStatus,
      proxyId,
      proxyError ? scrubSecrets(proxyError).slice(0, PROXY_ERROR_MAX) : null,
      finishedAt,
      id,
    ],
  );
  const finished = await getImprovement(id);
  if (!finished) throw new Error(`Improvement ${id} vanished after send`);
  return finished;
}

/** Discard a pending or failed draft. The caller checks who may discard. */
export async function discardImprovement(
  id: string,
  options?: { updatedBy?: string | null },
): Promise<Improvement> {
  await assertEnabled();
  const now = new Date().toISOString();
  const result = await getDbClient().run(
    `UPDATE improvements SET status = 'discarded', updated_at = ?, updated_by = ?
      WHERE id = ? AND status IN ('pending_approval', 'failed')`,
    [now, options?.updatedBy ?? null, id],
  );
  const existing = await getImprovement(id);
  if (!existing) throw new ImprovementError("not_found", `Improvement ${id} not found.`);
  if (result.changes !== 1) {
    throw new ImprovementError(
      "conflict",
      `Improvement ${id} is ${existing.status}; only pending or failed improvements can be discarded.`,
    );
  }
  return existing;
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host || null;
  } catch {
    return null;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Substrings of `text` that look like install-specific details: agent names,
 * repo names and URLs, the dashboard and API hosts, the org name and website,
 * user emails, and any URL or email. They warn the approver; they never block.
 */
export async function improvementLeakHints(text: string): Promise<string[]> {
  const client = getDbClient();
  const [agents, repos, users] = await Promise.all([
    client.query<{ name: string | null }>("SELECT name FROM agents"),
    client.query<{ name: string | null; url: string | null }>("SELECT name, url FROM swarm_repos"),
    client.query<{ email: string | null }>("SELECT email FROM users WHERE email IS NOT NULL"),
  ]);
  const terms = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 3) terms.add(trimmed);
  };
  for (const agent of agents) add(agent.name);
  for (const repo of repos) {
    add(repo.name);
    add(repo.url);
  }
  for (const user of users) add(user.email);
  add(hostOf(process.env.MCP_BASE_URL));
  add(hostOf(process.env.APP_URL));
  const orgName = await globalValue("SWARM_ORG_NAME");
  const orgWebsite = await globalValue("SWARM_ORG_WEBSITE");
  add(orgName);
  add(orgWebsite);
  add(hostOf(orgWebsite));

  const hits: string[] = [];
  const seen = new Set<string>();
  const push = (hit: string) => {
    const key = hit.toLowerCase();
    if (seen.has(key) || hits.length >= LEAK_HINTS_MAX) return;
    seen.add(key);
    hits.push(hit);
  };
  const lower = text.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at >= 0) push(text.slice(at, at + term.length));
  }
  for (const match of text.matchAll(URL_RE)) push(match[0]);
  for (const match of text.matchAll(EMAIL_RE)) push(match[0]);
  return hits;
}
