import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { reportSeatMismatchOutcome } from "../commands/seat-mismatch-report";

/**
 * Report helper for a `credits_required` seat mismatch: the report sends the
 * credential and model family, resolves only after the API responds, and
 * never throws. The completion ordering is covered by
 * `credential-outcome-report.test.ts`.
 */

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

const SEAT_REPORT_DELAY_MS = 150;
let server: ReturnType<typeof Bun.serve>;
let apiUrl: string;
let requests: RecordedRequest[] = [];
let respondedAt: number | undefined;
let status = 200;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        body: (await req.json()) as Record<string, unknown>,
      });
      await Bun.sleep(SEAT_REPORT_DELAY_MS);
      respondedAt = Date.now();
      return Response.json({ success: status === 200 }, { status });
    },
  });
  apiUrl = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  requests = [];
  respondedAt = undefined;
  status = 200;
});

const credential = { keyType: "CLAUDE_CODE_OAUTH_TOKEN", keySuffix: "TJAAA", keyIndex: 3 };

describe("reportSeatMismatchOutcome", () => {
  test("posts the seat mismatch and resolves only after the API responds", async () => {
    await reportSeatMismatchOutcome(apiUrl, "example-test-key", credential, "fable");
    const resolvedAt = Date.now();

    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/keys/report-seat-mismatch",
        auth: "Bearer example-test-key",
        body: {
          keyType: "CLAUDE_CODE_OAUTH_TOKEN",
          keySuffix: "TJAAA",
          keyIndex: 3,
          model: "fable",
        },
      },
    ]);
    expect(respondedAt).toBeDefined();
    expect(resolvedAt).toBeGreaterThanOrEqual(respondedAt!);
  });

  test("a failed report is logged and never throws", async () => {
    status = 500;
    await expect(
      reportSeatMismatchOutcome(apiUrl, "example-test-key", credential, "fable"),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });
});
