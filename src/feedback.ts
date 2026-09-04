import { randomUUID } from "node:crypto";
import pkg from "../package.json";
import { getDbClient } from "./be/db";
import { ensureInstallationIdentity } from "./installation-identity";

const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";
const RELAY_INTERVAL_MS = 60_000;
const RELAY_TIMEOUT_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export interface FeedbackInput {
  name?: string;
  email?: string;
  newsletter_consent: boolean;
  nps?: 1 | 2 | 3 | 4 | 5;
  message?: string;
  user_id: string;
}

export interface FeedbackPayload {
  submission_id: string;
  name: string | null;
  email: string | null;
  newsletter_consent: boolean;
  nps: number | null;
  message: string | null;
  user_id: string;
  install_id: string;
  swarm_version: string;
  org_name: string | null;
  installed_at: string | null;
  submitted_at: string;
}

interface FeedbackRow {
  id: string;
  name: string | null;
  email: string | null;
  newsletter_consent: number;
  nps: number | null;
  message: string | null;
  user_id: string;
  install_id: string;
  swarm_version: string;
  org_name: string | null;
  installed_at: string | null;
  submitted_at: string;
  relay_attempts: number;
}

// 4xx means the proxy rejected the payload itself (bad schema, body too large, etc) —
// retrying an unchanged payload can never succeed. 408/429 are exceptions: they signal
// a transient condition on the caller side (timeout, rate limit), not a bad request.
function isTerminalRelayStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rowToPayload(row: FeedbackRow): FeedbackPayload {
  return {
    submission_id: row.id,
    name: row.name,
    email: row.email,
    newsletter_consent: row.newsletter_consent === 1,
    nps: row.nps,
    message: row.message,
    user_id: row.user_id,
    install_id: row.install_id,
    swarm_version: row.swarm_version,
    org_name: row.org_name,
    installed_at: row.installed_at,
    submitted_at: row.submitted_at,
  };
}

export async function createFeedbackSubmission(
  input: FeedbackInput,
  now = new Date().toISOString(),
): Promise<string> {
  const id = randomUUID();
  const identity = await ensureInstallationIdentity();
  await getDbClient().run(
    `INSERT INTO feedback_submissions (
       id, name, email, newsletter_consent, nps, message, user_id,
       install_id, swarm_version, org_name, installed_at, submitted_at,
       next_retry_at, created_at, updated_at, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      optionalText(input.name),
      optionalText(input.email),
      input.newsletter_consent ? 1 : 0,
      input.nps ?? null,
      optionalText(input.message),
      input.user_id,
      identity.installId,
      pkg.version,
      optionalText(process.env.SWARM_ORG_NAME),
      identity.installedAt,
      now,
      now,
      now,
      now,
      input.user_id,
      input.user_id,
    ],
  );
  return id;
}

function nextRetryAt(now: Date, attemptsBeforeFailure: number): string {
  const delay = Math.min(RELAY_INTERVAL_MS * 2 ** attemptsBeforeFailure, MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay).toISOString();
}

export async function relayPendingFeedback(
  options: { fetchImpl?: typeof fetch; now?: Date; limit?: number } = {},
): Promise<{ relayed: number; failed: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = await getDbClient().query<FeedbackRow>(
    `SELECT id, name, email, newsletter_consent, nps, message, user_id,
            install_id, swarm_version, org_name, installed_at, submitted_at, relay_attempts
       FROM feedback_submissions
      WHERE relayed_at IS NULL AND relay_terminal_at IS NULL AND next_retry_at <= ?
      ORDER BY created_at ASC
      LIMIT ?`,
    [nowIso, options.limit ?? 20],
  );

  let relayed = 0;
  let failed = 0;
  const endpoint = process.env.FEEDBACK_ENDPOINT?.trim() || DEFAULT_FEEDBACK_ENDPOINT;

  for (const row of rows) {
    // The API-start sweep and a just-submitted immediate sweep can overlap.
    // Move the due time forward as an atomic claim so only one caller sends
    // this row; a crashed claimant becomes eligible again after the cap.
    const claimed = await getDbClient().run(
      `UPDATE feedback_submissions
          SET next_retry_at = ?, updated_at = ?, updated_by = 'feedback-relay'
        WHERE id = ? AND relayed_at IS NULL AND relay_terminal_at IS NULL AND next_retry_at <= ?`,
      [new Date(now.getTime() + MAX_RETRY_DELAY_MS).toISOString(), nowIso, row.id, nowIso],
    );
    if (claimed.changes !== 1) continue;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rowToPayload(row)),
        signal: controller.signal,
      });
      if (response.ok) {
        await getDbClient().run(
          `UPDATE feedback_submissions
              SET relayed_at = ?, updated_at = ?, updated_by = 'feedback-relay'
            WHERE id = ? AND relayed_at IS NULL`,
          [nowIso, nowIso, row.id],
        );
        relayed += 1;
      } else if (isTerminalRelayStatus(response.status)) {
        console.warn(
          `[feedback] Relay rejected for ${row.id}: HTTP ${response.status} (terminal, will not retry)`,
        );
        await getDbClient().run(
          `UPDATE feedback_submissions
              SET relay_attempts = relay_attempts + 1,
                  relay_terminal_at = ?, relay_failure_status = ?,
                  updated_at = ?, updated_by = 'feedback-relay'
            WHERE id = ? AND relayed_at IS NULL`,
          [nowIso, response.status, nowIso, row.id],
        );
        failed += 1;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      const errorLabel = error instanceof Error ? error.message : String(error);
      console.warn(`[feedback] Relay failed for ${row.id}: ${errorLabel}`);
      await getDbClient().run(
        `UPDATE feedback_submissions
            SET relay_attempts = relay_attempts + 1,
                next_retry_at = ?, updated_at = ?, updated_by = 'feedback-relay'
          WHERE id = ? AND relayed_at IS NULL`,
        [nextRetryAt(now, row.relay_attempts), nowIso, row.id],
      );
      failed += 1;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { relayed, failed };
}

let relayTimer: ReturnType<typeof setTimeout> | null = null;
let relayEnabled = false;

export function startFeedbackRelay(): void {
  if (relayEnabled) return;
  relayEnabled = true;

  const poll = async () => {
    try {
      await relayPendingFeedback();
    } catch (error) {
      console.warn(
        `[feedback] Relay sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (relayEnabled) {
        relayTimer = setTimeout(poll, RELAY_INTERVAL_MS);
        relayTimer.unref?.();
      }
    }
  };

  void poll();
}

export function stopFeedbackRelay(): void {
  relayEnabled = false;
  if (relayTimer) clearTimeout(relayTimer);
  relayTimer = null;
}
