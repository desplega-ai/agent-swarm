/**
 * Deterministic in-memory `LlmRaterClient` for tests.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-4.md §5
 *
 * Used by `memory-rater-llm.test.ts` (this step) and reused by the cross-
 * cutting e2e in step-7. Keep it dependency-free and side-effect-free.
 */
import type {
  LlmRaterClient,
  LlmRaterInput,
  LlmRaterResult,
} from "../../be/memory/raters/llm-client";

export type MockResultMap = Record<string, LlmRaterResult | null>;

export class MockLlmRaterClient implements LlmRaterClient {
  /** Inputs received, in call order — for assertions. */
  public readonly calls: LlmRaterInput[] = [];

  /**
   * @param map  memoryId → fixed result. Missing keys → fallback.
   * @param fallback  result returned when a memoryId is not in the map.
   *                  `null` simulates an LLM parse-failure (skip rating).
   */
  constructor(
    private readonly map: MockResultMap,
    private readonly fallback: LlmRaterResult | null = null,
  ) {}

  async rate(input: LlmRaterInput): Promise<LlmRaterResult | null> {
    this.calls.push(input);
    return Object.hasOwn(this.map, input.memory.id) ? this.map[input.memory.id] : this.fallback;
  }
}
