import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM secrets cipher.
 *
 * Encrypted payload layout (before base64):
 *   [ iv (12 bytes) || ciphertext (variable) || auth tag (16 bytes) ]
 *
 * A fresh random IV is generated per `encryptSecret` call, so encrypting the
 * same plaintext twice produces different ciphertexts. Decryption verifies the
 * auth tag and throws on any tampering.
 */

export const AES_KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

const ALGORITHM = "aes-256-gcm" as const;

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    const got = Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key;
    throw new Error(`Invalid encryption key: expected ${AES_KEY_BYTES} bytes, got ${got}`);
  }
}

/**
 * Encrypt a UTF-8 plaintext string with AES-256-GCM.
 *
 * @param plaintext - Any UTF-8 string (empty allowed).
 * @param key - 32-byte key buffer.
 * @returns base64-encoded `iv || ciphertext || authTag`.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKey(key);
  if (typeof plaintext !== "string") {
    throw new Error(`encryptSecret: plaintext must be a string, got ${typeof plaintext}`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== TAG_BYTES) {
    // Should never happen with aes-256-gcm, but guard anyway.
    throw new Error(`encryptSecret: unexpected auth tag length ${authTag.length}`);
  }

  return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
}

/**
 * Decrypt a payload produced by `encryptSecret`. Throws on any tampering
 * (invalid length, corrupted ciphertext/iv, or bad auth tag).
 */
export function decryptSecret(encoded: string, key: Buffer): string {
  assertKey(key);
  if (typeof encoded !== "string") {
    throw new Error(`decryptSecret: encoded payload must be a string, got ${typeof encoded}`);
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(encoded, "base64");
  } catch (err) {
    throw new Error(`decryptSecret: invalid base64 payload: ${(err as Error).message}`);
  }

  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error(
      `decryptSecret: payload too short (${buf.length} bytes, need at least ${IV_BYTES + TAG_BYTES})`,
    );
  }

  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (err) {
    throw new Error(
      `decryptSecret: auth tag verification failed or payload corrupted: ${(err as Error).message}`,
    );
  }
}
