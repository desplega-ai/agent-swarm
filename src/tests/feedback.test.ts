import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { createFeedbackSubmission, relayPendingFeedback } from "../feedback";

const TEST_DB_PATH = "./test-feedback.sqlite";

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

beforeEach(async () => {
  delete process.env.SWARM_ORG_NAME;
  delete process.env.FEEDBACK_ENDPOINT;
  await getDbClient().run("DELETE FROM feedback_submissions");
  await getDbClient().run("DELETE FROM swarm_config");
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("feedback relay", () => {
  test("persists optional fields and relays the enriched contract", async () => {
    process.env.SWARM_ORG_NAME = "Acme";
    const submittedAt = "2026-09-03T12:00:00.000Z";
    await upsertSwarmConfig({
      scope: "global",
      key: "telemetry_installation_id",
      value: "install_existing123",
    });
    await upsertSwarmConfig({ scope: "global", key: "telemetry_installed_at", value: submittedAt });
    const id = await createFeedbackSubmission(
      {
        name: " Ada ",
        email: "ada@example.com",
        newsletter_consent: true,
        nps: 5,
        message: " Great tool ",
        user_id: "user_ada",
      },
      submittedAt,
    );

    let payload: Record<string, unknown> | undefined;
    const result = await relayPendingFeedback({
      now: new Date(submittedAt),
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
    });

    expect(result).toEqual({ relayed: 1, failed: 0 });
    expect(payload).toMatchObject({
      submission_id: id,
      name: "Ada",
      email: "ada@example.com",
      newsletter_consent: true,
      nps: 5,
      message: "Great tool",
      user_id: "user_ada",
      org_name: "Acme",
      installed_at: submittedAt,
      submitted_at: submittedAt,
    });
    expect(payload?.install_id).toBe("install_existing123");
    expect(typeof payload?.swarm_version).toBe("string");

    const row = await getDbClient().get<{ relayed_at: string | null }>(
      "SELECT relayed_at FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(row?.relayed_at).toBe(submittedAt);
  });

  test("does not fabricate an install date when feedback mints a missing install ID", async () => {
    const submittedAt = "2026-09-03T12:00:00.000Z";
    const id = await createFeedbackSubmission(
      { newsletter_consent: false, user_id: "user_1" },
      submittedAt,
    );

    const row = await getDbClient().get<{ install_id: string; installed_at: string | null }>(
      "SELECT install_id, installed_at FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(row?.install_id).toMatch(/^install_[a-f0-9]{16}$/);
    expect(row?.installed_at).toBeNull();

    const anchor = await getDbClient().get<{ value: string }>(
      "SELECT value FROM swarm_config WHERE scope = 'global' AND key = 'telemetry_installed_at'",
    );
    expect(anchor).toBeNull();
  });

  test("keeps a retryable non-2xx submission local and backs off before retry", async () => {
    const submittedAt = "2026-09-03T12:00:00.000Z";
    const id = await createFeedbackSubmission(
      { newsletter_consent: false, user_id: "user_1" },
      submittedAt,
    );

    const failed = await relayPendingFeedback({
      now: new Date(submittedAt),
      fetchImpl: async () => new Response(null, { status: 500 }),
    });
    expect(failed).toEqual({ relayed: 0, failed: 1 });

    const row = await getDbClient().get<{
      relayed_at: string | null;
      relay_terminal_at: string | null;
      relay_attempts: number;
      next_retry_at: string;
    }>(
      "SELECT relayed_at, relay_terminal_at, relay_attempts, next_retry_at FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(row).toEqual({
      relayed_at: null,
      relay_terminal_at: null,
      relay_attempts: 1,
      next_retry_at: "2026-09-03T12:01:00.000Z",
    });

    const early = await relayPendingFeedback({
      now: new Date("2026-09-03T12:00:59.000Z"),
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(early).toEqual({ relayed: 0, failed: 0 });
  });

  test("accepts a 202 as success, same as 204", async () => {
    const submittedAt = "2026-09-03T12:00:00.000Z";
    const id = await createFeedbackSubmission(
      { newsletter_consent: false, user_id: "user_1" },
      submittedAt,
    );

    const result = await relayPendingFeedback({
      now: new Date(submittedAt),
      fetchImpl: async () => new Response(null, { status: 202 }),
    });
    expect(result).toEqual({ relayed: 1, failed: 0 });

    const row = await getDbClient().get<{ relayed_at: string | null }>(
      "SELECT relayed_at FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(row?.relayed_at).toBe(submittedAt);
  });

  test("marks a 400 terminal and never retries it again", async () => {
    const submittedAt = "2026-09-03T12:00:00.000Z";
    const id = await createFeedbackSubmission(
      { newsletter_consent: false, user_id: "user_1" },
      submittedAt,
    );

    const result = await relayPendingFeedback({
      now: new Date(submittedAt),
      fetchImpl: async () => new Response(null, { status: 400 }),
    });
    expect(result).toEqual({ relayed: 0, failed: 1 });

    const row = await getDbClient().get<{
      relayed_at: string | null;
      relay_terminal_at: string | null;
      relay_failure_status: number | null;
      relay_attempts: number;
    }>(
      "SELECT relayed_at, relay_terminal_at, relay_failure_status, relay_attempts FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(row).toEqual({
      relayed_at: null,
      relay_terminal_at: submittedAt,
      relay_failure_status: 400,
      relay_attempts: 1,
    });

    // A later sweep, even far in the future, must not pick this row up again.
    const later = await relayPendingFeedback({
      now: new Date("2026-09-03T18:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("should not be called for a terminal row");
      },
    });
    expect(later).toEqual({ relayed: 0, failed: 0 });
  });

  test("treats a 429 as retryable, not terminal", async () => {
    const submittedAt = "2026-09-03T12:00:00.000Z";
    const id = await createFeedbackSubmission(
      { newsletter_consent: false, user_id: "user_1" },
      submittedAt,
    );

    const result = await relayPendingFeedback({
      now: new Date(submittedAt),
      fetchImpl: async () => new Response(null, { status: 429 }),
    });
    expect(result).toEqual({ relayed: 0, failed: 1 });

    const row = await getDbClient().get<{
      relayed_at: string | null;
      relay_terminal_at: string | null;
      relay_attempts: number;
      next_retry_at: string;
    }>(
      "SELECT relayed_at, relay_terminal_at, relay_attempts, next_retry_at FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(row).toEqual({
      relayed_at: null,
      relay_terminal_at: null,
      relay_attempts: 1,
      next_retry_at: "2026-09-03T12:01:00.000Z",
    });

    const later = await relayPendingFeedback({
      now: new Date("2026-09-03T12:01:00.000Z"),
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(later).toEqual({ relayed: 1, failed: 0 });
    const relayedRow = await getDbClient().get<{ relayed_at: string | null }>(
      "SELECT relayed_at FROM feedback_submissions WHERE id = ?",
      [id],
    );
    expect(relayedRow?.relayed_at).toBe("2026-09-03T12:01:00.000Z");
  });

  test("claims a due row once across overlapping relay sweeps", async () => {
    const submittedAt = "2026-09-03T12:00:00.000Z";
    await createFeedbackSubmission({ newsletter_consent: false, user_id: "user_1" }, submittedAt);
    let sends = 0;
    const fetchImpl: typeof fetch = async () => {
      sends += 1;
      await Promise.resolve();
      return new Response(null, { status: 204 });
    };

    await Promise.all([
      relayPendingFeedback({ now: new Date(submittedAt), fetchImpl }),
      relayPendingFeedback({ now: new Date(submittedAt), fetchImpl }),
    ]);

    expect(sends).toBe(1);
  });
});
