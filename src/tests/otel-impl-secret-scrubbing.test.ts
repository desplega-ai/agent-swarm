import { describe, expect, test } from "bun:test";
import { scrubOtelException, scrubOtelStatus } from "@swarm/otel";

const SECRET = "ghp_1234567890abcdefghijklmnopqrstuv";

describe("otel-impl secret scrubbing", () => {
  test("scrubs Error messages and stacks before recording exceptions", () => {
    const error = new Error(`request failed with token ${SECRET}`);
    error.stack = `Error: request failed with token ${SECRET}\n    at fake`;

    const scrubbed = scrubOtelException(error);

    expect(scrubbed).toBeInstanceOf(Error);
    expect((scrubbed as Error).message).not.toContain(SECRET);
    expect((scrubbed as Error).message).toContain("[REDACTED:github_token]");
    expect((scrubbed as Error).stack).not.toContain(SECRET);
  });

  test("scrubs non-Error exception values", () => {
    const scrubbed = scrubOtelException(`raw failure ${SECRET}`);

    expect(scrubbed).toBe("raw failure [REDACTED:github_token]");
  });

  test("scrubs span status messages", () => {
    const status = scrubOtelStatus({
      code: 2,
      message: `worker failed with token ${SECRET}`,
    });

    expect(status.message).toBe("worker failed with token [REDACTED:github_token]");
  });
});
