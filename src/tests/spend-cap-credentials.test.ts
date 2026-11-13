import { describe, expect, test } from "bun:test";
import { KeySpendCapError, resolveCredentialPools } from "../utils/credentials";

const POOL = "sk-or-v1-aaaaa11111,sk-or-v1-bbbbb22222";

function pick(spendCappedIndices: number[], availableIndices: number[] = []) {
  return resolveCredentialPools(
    { OPENROUTER_API_KEY: POOL },
    {
      provider: "pi",
      enforceModelCapacity: true,
      availableIndicesMap: { OPENROUTER_API_KEY: { availableIndices, spendCappedIndices } },
    },
  );
}

describe("resolveCredentialPools with spend-capped keys", () => {
  test("every key capped fails the task before the CLI starts", async () => {
    await expect(pick([0, 1])).rejects.toBeInstanceOf(KeySpendCapError);
  });

  test("the best-effort pick skips a capped key", async () => {
    for (let i = 0; i < 20; i++) {
      const [selection] = await pick([0]);
      expect(selection?.index).toBe(1);
    }
  });

  test("an available key is drawn as before", async () => {
    const [selection] = await pick([0], [1]);
    expect(selection?.index).toBe(1);
    expect(selection?.isRateLimitFallback).toBe(false);
  });
});
