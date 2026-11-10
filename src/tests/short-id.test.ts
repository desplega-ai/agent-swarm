import { describe, expect, test } from "bun:test";
import { generateBearerToken, generateShortId, randomChars } from "../utils/short-id";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

describe("short-id", () => {
  test("generateBearerToken is xsk_ plus 24 base62 chars", () => {
    for (let i = 0; i < 50; i++) expect(generateBearerToken()).toMatch(/^xsk_[0-9a-zA-Z]{24}$/);
  });

  test("generateShortId is 12 letters by default", () => {
    expect(generateShortId()).toMatch(/^[a-zA-Z]{12}$/);
  });

  test("randomChars rejects bytes at or above the largest multiple of 62", () => {
    // 248 = 62 * 4: 247 is the last accepted byte, 248..255 are rejected.
    const bytes = [248, 255, 247, 0, 61, 62];
    const source = (size: number) => Uint8Array.from(bytes.splice(0, size));
    expect(randomChars(BASE62, 4, source)).toBe(
      BASE62[247 % 62] + BASE62[0] + BASE62[61] + BASE62[0],
    );
  });
});
