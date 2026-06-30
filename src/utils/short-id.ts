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
  // Rejection-sample bytes into the 52-letter alphabet to avoid modulo bias:
  // accept bytes < 208 (= 52 * 4, the largest multiple of 52 ≤ 255) and reject
  // the rest so every letter is equally likely.
  let out = "";
  while (out.length < len) {
    for (const byte of randomBytes((len - out.length) * 2)) {
      if (byte < 208) {
        out += LETTERS[byte % 52];
        if (out.length === len) break;
      }
    }
  }
  return out;
}

/** base62-encode raw bytes (URL-safe, unambiguous), mirroring the user-token util. */
function base62(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += BASE62[byte % 62];
  return out;
}

/**
 * Generate a high-entropy bearer secret: `xsk_` + 24 base62 chars (~143 bits),
 * mirroring the `aswt_` user-token shape in src/be/users.ts. Unlike
 * {@link generateShortId} this IS a secret and must be stored encrypted.
 */
export function generateBearerToken(): string {
  return `xsk_${base62(randomBytes(24))}`;
}
