import { describe, expect, test } from "bun:test";
import humalikeForesee from "../be/seed-scripts/catalog/humalike-foresee";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeCtx(fetchImpl: (input: unknown, init: unknown) => Promise<Response>) {
  const kvSets: Array<{ namespace: string; key: string; value: unknown }> = [];
  const errors: string[] = [];
  return {
    calls: 0,
    kvSets,
    errors,
    ctx: {
      stdlib: {
        fetch: async (input: unknown, init: unknown) => {
          return fetchImpl(input, init);
        },
      },
      swarm: {
        kv_set: async (args: { namespace: string; key: string; value: unknown }) => {
          kvSets.push(args);
          return { data: { ok: true } };
        },
      },
      logger: {
        error: (msg: string) => errors.push(msg),
      },
    },
  };
}

describe("humalike-foresee", () => {
  test("happy path maps fields and logs the pilot pair to KV", async () => {
    let calls = 0;
    const { ctx, kvSets } = makeCtx(async () => {
      calls++;
      return jsonResponse(200, {
        mental_state: [
          {
            name: "Taras",
            beliefs: ["the fix is done"],
            emotions: [{ type: "trust", intensity: 0.7 }],
            intentions: "approve",
          },
        ],
        predicted_reaction: [{ name: "Taras", risk: "low" }],
        refined_reply: "Refined text.",
        refinement_rationale: "Trimmed filler.",
      });
    });

    const result: any = await humalikeForesee(
      { draft: "Original draft.", agentName: "Researcher", taskId: "task-123" },
      ctx,
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.risk).toBe("low");
    expect(result.refinedReply).toBe("Refined text.");
    expect(result.rationale).toBe("Trimmed filler.");
    expect(result.mentalState).toHaveLength(1);
    expect(result.predictedReaction).toEqual([{ name: "Taras", risk: "low" }]);
    expect(result.draft).toBe("Original draft.");

    expect(kvSets).toHaveLength(1);
    expect(kvSets[0]?.namespace).toBe("humalike-pilot");
    expect(kvSets[0]?.key).toContain("task-123");
    expect((kvSets[0]?.value as any).draft).toBe("Original draft.");
    expect((kvSets[0]?.value as any).refinedReply).toBe("Refined text.");
    expect((kvSets[0]?.value as any).risk).toBe("low");
  });

  test("402 PAYMENT_REQUIRED is terminal — exactly one fetch call, no retry", async () => {
    let calls = 0;
    const { ctx } = makeCtx(async () => {
      calls++;
      return jsonResponse(402, { error: { code: "PAYMENT_REQUIRED", message: "out of credits" } });
    });

    const result: any = await humalikeForesee({ draft: "Draft text." }, ctx);

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PAYMENT_REQUIRED");
    expect(result.draft).toBe("Draft text.");
    expect(result.attempts).toBe(1);
  });

  test("502 UPSTREAM_ERROR retries exactly once then falls through", async () => {
    let calls = 0;
    const { ctx } = makeCtx(async () => {
      calls++;
      return jsonResponse(502, { error: { code: "UPSTREAM_ERROR", message: "bad gateway" } });
    });

    const result: any = await humalikeForesee({ draft: "Draft text." }, ctx);

    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UPSTREAM_ERROR");
    expect(result.draft).toBe("Draft text.");
    expect(result.attempts).toBe(2);
  });

  test("502 UPSTREAM_ERROR that succeeds on retry returns a success result after two calls", async () => {
    let calls = 0;
    const { ctx } = makeCtx(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(502, { error: { code: "UPSTREAM_ERROR", message: "bad gateway" } });
      }
      return jsonResponse(200, {
        mental_state: [],
        predicted_reaction: [{ name: "x", risk: "low" }],
        refined_reply: "ok",
        refinement_rationale: "ok",
      });
    });

    const result: any = await humalikeForesee({ draft: "Draft text." }, ctx);

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.draft).toBe("Draft text.");
  });

  test("401 UNAUTHORIZED sets alert and falls through without throwing", async () => {
    let calls = 0;
    const { ctx } = makeCtx(async () => {
      calls++;
      return jsonResponse(401, {
        error: { code: "UNAUTHORIZED", message: "missing or invalid credentials" },
      });
    });

    const result: any = await humalikeForesee({ draft: "Draft text." }, ctx);

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNAUTHORIZED");
    expect(result.alert).toBe(true);
    expect(result.draft).toBe("Draft text.");
  });

  test("400/422 VALIDATION_ERROR falls through, logs loudly, no retry", async () => {
    let calls = 0;
    const { ctx, errors } = makeCtx(async () => {
      calls++;
      return jsonResponse(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "invalid transcript",
          details: ["transcript[0].speaker required"],
        },
      });
    });

    const result: any = await humalikeForesee({ draft: "Draft text." }, ctx);

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.draft).toBe("Draft text.");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("timeout falls through to a failure result without throwing", async () => {
    const { ctx } = makeCtx(async (_input, init: any) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result: any = await humalikeForesee({ draft: "Draft text." }, ctx);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("TIMEOUT");
    expect(result.draft).toBe("Draft text.");
  }, 8000);

  test("invariant holds across every failure branch: never throws, draft is byte-identical", async () => {
    const scenarios: Array<() => Promise<Response>> = [
      async () => jsonResponse(402, { error: { code: "PAYMENT_REQUIRED", message: "x" } }),
      async () => jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } }),
      async () => jsonResponse(422, { error: { code: "VALIDATION_ERROR", message: "x" } }),
      async () => jsonResponse(502, { error: { code: "UPSTREAM_ERROR", message: "x" } }),
      async () => jsonResponse(500, { error: { code: "SOMETHING_ELSE", message: "x" } }),
    ];

    for (const scenario of scenarios) {
      const { ctx } = makeCtx(scenario);
      const draft = "Invariant check draft.";
      let threw = false;
      let result: any;
      try {
        result = await humalikeForesee({ draft }, ctx);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.draft).toBe(draft);
    }
  });

  test("usage mode hits the free usage-summary endpoint and returns a 30-day breakdown", async () => {
    let calls = 0;
    let requestedPath = "";
    const { ctx } = makeCtx(async (input: unknown) => {
      calls++;
      requestedPath = String(input);
      return jsonResponse(200, {
        total_calls: 4,
        total_credits: 22,
        by_product: [
          { product: "theoryofmind", calls: 3, credits: 13 },
          { product: "social-observability", calls: 1, credits: 9 },
        ],
      });
    });

    const result: any = await humalikeForesee({ draft: "unused", mode: "usage" }, ctx);

    expect(calls).toBe(1);
    expect(requestedPath).toContain("/v1/credits/projections/usage-summary");
    expect(result.ok).toBe(true);
    expect(result.windowDays).toBe(30);
    expect(result.totalCalls).toBe(4);
    expect(result.byProduct).toHaveLength(2);
  });
});
