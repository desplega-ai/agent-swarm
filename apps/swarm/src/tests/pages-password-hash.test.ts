/**
 * Unit test for `Bun.password.{hash,verify}` on bcrypt — the primitive used by
 * `auth_mode='password'` pages (step-5). These tests pin the assumptions:
 *
 *   1. A bcrypt hash of a known input verifies successfully.
 *   2. A close-but-wrong input fails verification.
 *   3. Hashes are unique per call (bcrypt salts internally) — same plaintext,
 *      different hash, both still verify.
 *
 * Constant-time-comparison assumption: `Bun.password.verify` uses bcrypt's
 * internal constant-time compare, so password verification cannot leak the
 * password via timing side-channels at the API surface. We pin behaviour, not
 * timings.
 */
import { describe, expect, test } from "bun:test";

describe("Bun.password — bcrypt assumptions for password-mode pages", () => {
  test("hash() produces a $2-prefixed bcrypt hash", async () => {
    const hash = await Bun.password.hash("swordfish", "bcrypt");
    expect(hash.startsWith("$2")).toBe(true);
    // bcrypt hashes are 60 characters.
    expect(hash.length).toBe(60);
  });

  test("verify() succeeds on the exact plaintext", async () => {
    const hash = await Bun.password.hash("swordfish", "bcrypt");
    expect(await Bun.password.verify("swordfish", hash)).toBe(true);
  });

  test("verify() fails on a close-but-wrong input (one char off)", async () => {
    const hash = await Bun.password.hash("swordfish", "bcrypt");
    expect(await Bun.password.verify("swordfisH", hash)).toBe(false);
    expect(await Bun.password.verify("swordfish ", hash)).toBe(false);
    expect(await Bun.password.verify("Swordfish", hash)).toBe(false);
  });

  test("verify() fails on the empty string", async () => {
    const hash = await Bun.password.hash("swordfish", "bcrypt");
    expect(await Bun.password.verify("", hash)).toBe(false);
  });

  test("two hashes of the same plaintext differ (random salt), both verify", async () => {
    const a = await Bun.password.hash("swordfish", "bcrypt");
    const b = await Bun.password.hash("swordfish", "bcrypt");
    expect(a).not.toBe(b);
    expect(await Bun.password.verify("swordfish", a)).toBe(true);
    expect(await Bun.password.verify("swordfish", b)).toBe(true);
  });

  test("verify() against a malformed hash string throws UnsupportedAlgorithm", async () => {
    // Bun.password.verify throws for unrecognised hash prefixes — the
    // password-mode handler wraps the call in try/catch so a corrupt
    // passwordHash column surfaces as a 401, NOT a 500. This test pins the
    // throw behaviour so the handler's try/catch is intentional (not vestigial).
    await expect(Bun.password.verify("swordfish", "not-a-real-hash")).rejects.toThrow();
  });
});
