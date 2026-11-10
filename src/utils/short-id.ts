import { randomBytes } from "node:crypto";

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Generate a URL-friendly random id of `len` letters `[a-zA-Z]`.
 *
 * NOT a secret — use for opaque public handles (e.g. external script-API
 * endpoint ids) where a short, readable identifier is wanted. 52^12 ≈ 3.9e20
 * values, so collisions are negligible; callers with a UNIQUE/PRIMARY KEY
 * constraint should regenerate on the (astronomically unlikely) conflict.
 */
export function generateShortId(len = 12): string {
  return randomChars(LETTERS, len);
}

/**
 * Pick `len` uniformly random characters from `alphabet`. Rejection-samples
 * bytes to avoid modulo bias: accept bytes below the largest multiple of the
 * alphabet size that fits in a byte (208 for 52 letters, 248 for base62) and
 * reject the rest so every character is equally likely. `source` is
 * injectable for tests.
 */
export function randomChars(
  alphabet: string,
  len: number,
  source: (size: number) => Uint8Array = randomBytes,
): string {
  const accept = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < len) {
    for (const byte of source((len - out.length) * 2)) {
      if (byte < accept) {
        out += alphabet[byte % alphabet.length];
        if (out.length === len) break;
      }
    }
  }
  return out;
}

/**
 * Generate a high-entropy bearer secret: `xsk_` + 24 base62 chars (~143 bits),
 * mirroring the `aswt_` user-token shape in src/be/users.ts. Unlike
 * {@link generateShortId} this IS a secret and must be stored encrypted.
 */
export function generateBearerToken(): string {
  return `xsk_${randomChars(BASE62, 24)}`;
}
