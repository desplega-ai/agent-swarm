import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { SummaryWithRatingsSchema } from "../../be/memory/raters/llm.js";
import { summaryToolSchema } from "../../utils/internal-ai/summarize-session.js";

/**
 * 10 valid + 10 invalid fixtures. Both validators (zod via `safeParse`,
 * typebox via `Value.Check`) must agree on every fixture.
 *
 * Note: zod's `SummaryWithRatingsSchema` defaults `ratings` to `[]` when
 * missing — so an object with no `ratings` key IS valid from zod's POV but
 * NOT from typebox's strict `Type.Array` (it requires the key). We handle
 * that by always including `ratings` in our fixtures and explicitly fuzzing
 * different missing-key cases separately.
 */

const VALID_CASES: unknown[] = [
  { summary: "Learned X", ratings: [] },
  { summary: "Learned Y", ratings: [{ id: "m1", score: 0.5, reasoning: "ok" }] },
  {
    summary: "Multiple",
    ratings: [
      { id: "m1", score: 0, reasoning: "bad" },
      { id: "m2", score: 1, reasoning: "great" },
    ],
  },
  // referencesSource optional, present.
  {
    summary: "with refs",
    ratings: [
      {
        id: "m1",
        score: 0.7,
        reasoning: "useful",
        referencesSource: "github:foo/bar#1",
      },
    ],
  },
  // empty summary string allowed (zod has no min on summary).
  { summary: "", ratings: [] },
  // long summary.
  { summary: "x".repeat(2000), ratings: [] },
  // score boundary 0.
  { summary: "boundary-0", ratings: [{ id: "m1", score: 0, reasoning: "min" }] },
  // score boundary 1.
  { summary: "boundary-1", ratings: [{ id: "m1", score: 1, reasoning: "max" }] },
  // referencesSource long but under 512.
  {
    summary: "long-ref",
    ratings: [{ id: "m1", score: 0.5, reasoning: "ok", referencesSource: "x".repeat(100) }],
  },
  // reasoning at max length.
  {
    summary: "max-reason",
    ratings: [{ id: "m1", score: 0.5, reasoning: "x".repeat(500) }],
  },
];

const INVALID_CASES: unknown[] = [
  null,
  "string",
  42,
  // missing required summary.
  { ratings: [] },
  // wrong summary type.
  { summary: 42, ratings: [] },
  // wrong ratings type.
  { summary: "ok", ratings: "not an array" },
  // rating missing id.
  { summary: "ok", ratings: [{ score: 0.5, reasoning: "x" }] },
  // rating score out of range (>1).
  { summary: "ok", ratings: [{ id: "m1", score: 1.5, reasoning: "x" }] },
  // rating score out of range (<0).
  { summary: "ok", ratings: [{ id: "m1", score: -0.1, reasoning: "x" }] },
  // rating with non-string id.
  { summary: "ok", ratings: [{ id: 7, score: 0.5, reasoning: "x" }] },
];

describe("schema-parity: SummaryWithRatingsSchema (zod) vs summaryToolSchema (typebox)", () => {
  for (const [i, fixture] of VALID_CASES.entries()) {
    test(`valid #${i}: both validators accept`, () => {
      const zodOk = SummaryWithRatingsSchema.safeParse(fixture).success;
      const typeboxOk = Value.Check(summaryToolSchema, fixture);
      // Note: typebox is structurally stricter (e.g., bounded score). For
      // VALID_CASES we expect BOTH to pass; if zod accepts but typebox does
      // not, our typebox schema is too narrow for the wire format and the
      // production tool-call will get rejected by pi-ai before zod even
      // sees it. Treat both-pass as the spec.
      expect(zodOk).toBe(true);
      expect(typeboxOk).toBe(true);
    });
  }

  for (const [i, fixture] of INVALID_CASES.entries()) {
    test(`invalid #${i}: both validators reject`, () => {
      const zodOk = SummaryWithRatingsSchema.safeParse(fixture).success;
      const typeboxOk = Value.Check(summaryToolSchema, fixture);
      // Both must agree the input is invalid.
      expect(zodOk).toBe(false);
      expect(typeboxOk).toBe(false);
    });
  }
});
