import { describe, expect, test } from "bun:test";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  test("matches the FIPS 180-4 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  test("matches Bun's hasher across block boundaries and multi-byte text", () => {
    const inputs = ["ä€😀", ...[55, 56, 63, 64, 65, 119, 120, 1000].map((n) => "x".repeat(n))];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(new Bun.CryptoHasher("sha256").update(input).digest("hex"));
    }
  });
});
