// Phase 3 fix — regression guard that OpencodeSession stamps `provider:
// "opencode"` on every CostData it emits. Without this tag the API server
// recompute branch in src/http/session-data.ts falls through to
// costSource='harness' instead of engaging the pricing-table lookup, so a
// perfectly-priced model still renders as un-priced in the dashboard.
//
// Mirrors the narrow, single-purpose shape of src/tests/providers/codex-cost.test.ts.

import { describe, expect, test } from "bun:test";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk";
import { OpencodeSession } from "../../providers/opencode-adapter";
import type { ProviderEvent } from "../../providers/types";

function makeSession(): {
  session: OpencodeSession;
  events: ProviderEvent[];
} {
  const sessionId = "sess-cost-test";
  const session = new OpencodeSession(
    sessionId,
    { url: "http://127.0.0.1:0", close: () => {} },
    "openrouter/deepseek/deepseek-v4-flash",
    "agent-1",
    "task-1",
    "/tmp/opencode-agent.md",
    "/tmp/opencode-config.json",
    "/tmp/opencode-data",
  );
  const events: ProviderEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, events };
}

describe("OpencodeSession — provider tag on CostData", () => {
  test("session.idle → emitted `result.cost.provider === 'opencode'`", async () => {
    const { session, events } = makeSession();

    // Drive the SSE event that causes OpencodeSession to build + emit CostData.
    session.handleOpencodeEvent({
      type: "session.idle",
      properties: { sessionID: "sess-cost-test" },
    } as unknown as OpencodeEvent);

    const result = await session.waitForCompletion();

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "result") {
      // The load-bearing assertion. Phase 2's API recompute path keys off
      // exactly this field; emitting CostData without it silently disables
      // pricing-table tagging for the entire opencode provider.
      expect(resultEvent.cost.provider).toBe("opencode");
    }
    expect(result.cost?.provider).toBe("opencode");
  });

  test("session.error → emitted `result.cost.provider === 'opencode'` on error path too", async () => {
    const { session, events } = makeSession();

    session.handleOpencodeEvent({
      type: "session.error",
      properties: {
        sessionID: "sess-cost-test",
        error: { message: "boom" },
      },
    } as unknown as OpencodeEvent);

    const result = await session.waitForCompletion();
    // The error-path also routes through buildCostData; same regression risk.
    expect(result.cost?.provider).toBe("opencode");
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
  });
});
