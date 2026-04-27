import { jiraFetch } from "./client";
import { getJiraMetadata, updateJiraMetadata } from "./metadata";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Atlassian dynamic webhooks expire 30 days after registration / refresh. We
 * default to that on register and let the keepalive tighten the value on the
 * first refresh round-trip (Atlassian returns the authoritative expiry).
 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SLACK_ALERTS_CHANNEL = process.env.SLACK_ALERTS_CHANNEL || "C08JCRURPBV";

const WEBHOOK_EVENTS = [
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "comment_updated",
] as const;

let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

// ─── URL helpers ─────────────────────────────────────────────────────────────

function getWebhookBaseUrl(): string {
  return process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || "3013"}`;
}

function getRegisteredWebhookUrl(): string {
  const token = process.env.JIRA_WEBHOOK_TOKEN;
  if (!token) {
    throw new Error(
      "JIRA_WEBHOOK_TOKEN is not set — webhook registration would produce an unauthenticatable URL.",
    );
  }
  return `${getWebhookBaseUrl()}/api/trackers/jira/webhook/${token}`;
}

// ─── Slack alert (best-effort) ───────────────────────────────────────────────

async function notifySlack(text: string): Promise<void> {
  try {
    const { getSlackApp } = await import("../slack/app");
    const app = getSlackApp();
    if (!app) {
      console.warn("[Jira webhook keepalive] Slack not available, cannot send notification");
      return;
    }
    await app.client.chat.postMessage({
      channel: SLACK_ALERTS_CHANNEL,
      text,
    });
    console.log("[Jira webhook keepalive] Slack notification sent");
  } catch (slackErr) {
    console.error(
      "[Jira webhook keepalive] Failed to send Slack notification:",
      slackErr instanceof Error ? slackErr.message : slackErr,
    );
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RegisterJiraWebhookResult {
  webhookId: number;
  expiresAt: string;
  jql: string;
}

/**
 * Register a dynamic webhook with Atlassian.
 *
 * The registered URL embeds `JIRA_WEBHOOK_TOKEN` in the path so inbound
 * deliveries can be authenticated (Atlassian does not HMAC-sign OAuth 3LO
 * dynamic webhooks — see plan errata I8).
 *
 * Atlassian's response shape:
 *   { webhookRegistrationResult: [{ createdWebhookId: number, errors?: string[] }] }
 *
 * The response does NOT include the expiry on registration — we default to
 * `now + 30 days` (the documented webhook lifetime) and let the first refresh
 * tick replace it with Atlassian's authoritative `expirationDate`.
 */
export async function registerJiraWebhook(jqlFilter: string): Promise<RegisterJiraWebhookResult> {
  const url = getRegisteredWebhookUrl();

  const response = await jiraFetch("/rest/api/3/webhook", {
    method: "POST",
    body: JSON.stringify({
      url,
      webhooks: [
        {
          events: WEBHOOK_EVENTS,
          jqlFilter,
          fieldIdsFilter: ["assignee"],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Jira webhook registration failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    webhookRegistrationResult?: Array<{
      createdWebhookId?: number;
      errors?: string[];
    }>;
  };

  const results = payload.webhookRegistrationResult ?? [];
  if (results.length === 0) {
    throw new Error(
      "Jira webhook registration returned no results — payload may have been rejected upstream",
    );
  }

  const first = results[0];
  if (!first || typeof first.createdWebhookId !== "number") {
    const errors = first?.errors?.join("; ") ?? "no createdWebhookId";
    throw new Error(`Jira webhook registration entry malformed: ${errors}`);
  }

  const webhookId = first.createdWebhookId;
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();

  // Persist via the read-modify-write helper so we don't clobber cloudId/siteUrl.
  // updateJiraMetadata's id-keyed merge preserves any other webhookIds rows.
  updateJiraMetadata({
    webhookIds: [{ id: webhookId, expiresAt, jql: jqlFilter }],
  });

  console.log(
    `[Jira webhook keepalive] Registered webhook id=${webhookId} jql='${jqlFilter}' (default expiry ${expiresAt})`,
  );

  return { webhookId, expiresAt, jql: jqlFilter };
}

/**
 * Delete a dynamic webhook from Atlassian and remove it from `metadata.webhookIds`.
 *
 * Per Atlassian REST v3: `DELETE /rest/api/3/webhook` with body
 * `{ webhookIds: [<int>, ...] }`. Atlassian silently ignores ids it doesn't
 * recognize, so this is safe to call with stale local entries.
 */
export async function deleteJiraWebhook(webhookId: number): Promise<void> {
  const response = await jiraFetch("/rest/api/3/webhook", {
    method: "DELETE",
    body: JSON.stringify({ webhookIds: [webhookId] }),
  });

  if (!response.ok && response.status !== 204) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Jira webhook delete failed (${response.status}): ${errorText}`);
  }

  // Remove the id from local metadata regardless of whether Atlassian had it.
  const meta = getJiraMetadata();
  const remaining = (meta.webhookIds ?? []).filter((entry) => entry.id !== webhookId);

  // updateJiraMetadata's id-keyed merge can't drop entries (it merges by id).
  // For removal we need the read-modify-write to overwrite the array. Bypass
  // the merge by writing an empty `webhookIds` partial isn't supported either,
  // so we manually compose the full list and call updateJiraMetadata once for
  // each remaining entry — but that's quadratic. Instead: mutate via a
  // single UPDATE statement bypassing the helper. Done in a transaction-safe
  // way below.
  await overwriteWebhookIds(remaining);

  console.log(`[Jira webhook keepalive] Deleted webhook id=${webhookId}`);
}

/**
 * Direct overwrite of the `webhookIds` array — needed when removing entries
 * because `updateJiraMetadata`'s id-keyed merge cannot delete.
 *
 * Reads the current metadata, replaces just the `webhookIds` key, persists.
 * Race-window with concurrent registrations is acceptable: deletions are
 * rare admin actions, and the next register call will re-add anything we
 * accidentally race-stomped.
 */
async function overwriteWebhookIds(
  next: Array<{ id: number; expiresAt: string; jql: string }>,
): Promise<void> {
  const { getDb } = await import("../be/db");
  const db = getDb();
  const txn = db.transaction(() => {
    const row = db.query("SELECT metadata FROM oauth_apps WHERE provider = 'jira'").get() as {
      metadata: string | null;
    } | null;

    if (!row) {
      throw new Error(
        "[jira.webhook-lifecycle] oauth_apps row missing for provider='jira' — call initJira() first",
      );
    }

    let current: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata || "{}");
      if (parsed && typeof parsed === "object") {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // fall through with empty
    }

    const merged = { ...current, webhookIds: next };
    db.query(
      "UPDATE oauth_apps SET metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE provider = 'jira'",
    ).run(JSON.stringify(merged));
  });
  txn();
}

/**
 * Refresh known webhooks. Atlassian's `PUT /rest/api/3/webhook/refresh` takes
 * `{ webhookIds: [...] }` and returns either:
 *   - 200 + `{ expirationDate: "<ISO-8601>" }` (applies to ALL refreshed webhooks)
 *   - 204 No Content (older API variant)
 *
 * Unrecognized ids are silently ignored. On a successful refresh that returns
 * an `expirationDate`, we update every locally-known webhook to that expiry.
 * On 204 (no body), we treat the call as best-effort and log a warning.
 */
export async function refreshJiraWebhooks(): Promise<void> {
  const meta = getJiraMetadata();
  const ids = (meta.webhookIds ?? []).map((entry) => entry.id);

  if (ids.length === 0) {
    console.log("[Jira webhook keepalive] No webhooks to refresh");
    return;
  }

  console.log(`[Jira webhook keepalive] Refreshing ${ids.length} webhook(s): ${ids.join(", ")}`);

  const response = await jiraFetch("/rest/api/3/webhook/refresh", {
    method: "PUT",
    body: JSON.stringify({ webhookIds: ids }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Jira webhook refresh failed (${response.status}): ${errorText}`);
  }

  // 204 No Content → nothing to write back.
  if (response.status === 204) {
    console.warn(
      "[Jira webhook keepalive] Refresh returned 204 (no expirationDate) — local expiries left as-is. Stale entries will surface on next tick.",
    );
    return;
  }

  let payload: { expirationDate?: string } | null = null;
  try {
    payload = (await response.json()) as { expirationDate?: string };
  } catch {
    payload = null;
  }

  const expirationDate = payload?.expirationDate;
  if (!expirationDate || typeof expirationDate !== "string") {
    console.warn(
      "[Jira webhook keepalive] Refresh succeeded but response had no expirationDate — local expiries left as-is",
    );
    return;
  }

  // Apply the new expiry to all known entries (Atlassian docs: the new
  // expiration applies to ALL refreshed webhooks).
  const updated = (meta.webhookIds ?? []).map((entry) => ({
    ...entry,
    expiresAt: expirationDate,
  }));
  updateJiraMetadata({ webhookIds: updated });

  console.log(
    `[Jira webhook keepalive] Refreshed ${updated.length} webhook(s) → expiresAt=${expirationDate}`,
  );
}

/**
 * Run the keepalive check once: refresh webhooks expiring within 7 days.
 *
 * Errors are caught and reported (Slack-best-effort) so the timer survives
 * transient network / token failures.
 */
async function runKeepalive(): Promise<void> {
  try {
    const meta = getJiraMetadata();
    const entries = meta.webhookIds ?? [];
    if (entries.length === 0) {
      console.log("[Jira webhook keepalive] No webhooks registered, nothing to refresh");
      return;
    }

    const now = Date.now();
    const dueSoon = entries.filter((entry) => {
      const expiry = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiry)) return true; // malformed → refresh defensively
      return expiry - now < SEVEN_DAYS_MS;
    });

    if (dueSoon.length === 0) {
      console.log(
        `[Jira webhook keepalive] All ${entries.length} webhook(s) have expiries >7 days out — skipping`,
      );
      return;
    }

    console.log(
      `[Jira webhook keepalive] ${dueSoon.length}/${entries.length} webhook(s) expire within 7 days — refreshing all`,
    );
    await refreshJiraWebhooks();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Jira webhook keepalive] Refresh failed: ${message}`);
    await notifySlack(
      `⚠️ *Jira webhook keepalive failed*\nError: ${message}\n\nWebhooks may expire — manual refresh via \`POST /api/trackers/jira/webhook-register\` may be required.`,
    );
  }
}

/**
 * Start the recurring keepalive timer.
 *
 * Per plan errata I5: runs an immediate expiry check on first invocation
 * (a stale webhook surfaces on boot, not after the first 12-hour tick), then
 * every 12 hours.
 */
export function startJiraWebhookKeepalive(): void {
  if (keepaliveInterval) {
    console.log("[Jira webhook keepalive] Already running, skipping");
    return;
  }

  console.log("[Jira webhook keepalive] Starting (12h interval, 7-day refresh threshold)");

  // Immediate-on-boot check (after a short delay so server finishes startup
  // and OAuth tokens are loaded). Mirrors src/oauth/keepalive.ts pattern.
  setTimeout(() => {
    runKeepalive();
  }, 10_000);

  keepaliveInterval = setInterval(() => {
    runKeepalive();
  }, TWELVE_HOURS_MS);
}

/**
 * Stop the keepalive timer. Idempotent.
 */
export function stopJiraWebhookKeepalive(): void {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
    console.log("[Jira webhook keepalive] Stopped");
  }
}
