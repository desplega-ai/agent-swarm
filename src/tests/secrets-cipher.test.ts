import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  AES_KEY_BYTES,
  decryptSecret,
  encryptSecret,
  IV_BYTES,
  TAG_BYTES,
} from "../be/crypto/secrets-cipher";

function freshKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

describe("secrets-cipher: roundtrip", () => {
  it("roundtrips a plain ASCII string", () => {
    const key = freshKey();
    const ct = encryptSecret("hello world", key);
    expect(decryptSecret(ct, key)).toBe("hello world");
  });

  it("roundtrips a UTF-8 multibyte string", () => {
    const key = freshKey();
    const plain = "héllo 世界 🔐 ñandú";
    const ct = encryptSecret(plain, key);
    expect(decryptSecret(ct, key)).toBe(plain);
  });

  it("roundtrips an empty string", () => {
    const key = freshKey();
    const ct = encryptSecret("", key);
    expect(decryptSecret(ct, key)).toBe("");
  });

  it("roundtrips a 1-byte string", () => {
    const key = freshKey();
    const ct = encryptSecret("x", key);
    expect(decryptSecret(ct, key)).toBe("x");
  });

  it("roundtrips a 1MB string", () => {
    const key = freshKey();
    const plain = "a".repeat(1024 * 1024);
    const ct = encryptSecret(plain, key);
    expect(decryptSecret(ct, key)).toBe(plain);
  });
});

describe("secrets-cipher: tamper detection", () => {
  function flipByteAt(encoded: string, byteIndex: number): string {
    const buf = Buffer.from(encoded, "base64");
    buf[byteIndex] ^= 0xff;
    return buf.toString("base64");
  }

  it("throws when a byte in the ciphertext region is flipped", () => {
    const key = freshKey();
    const plain = "sensitive data here please do not tamper";
    const encoded = encryptSecret(plain, key);
    const buf = Buffer.from(encoded, "base64");
    // Ciphertext region: [IV_BYTES, buf.length - TAG_BYTES)
    const ctRegionStart = IV_BYTES;
    const ctRegionEnd = buf.length - TAG_BYTES;
    expect(ctRegionEnd).toBeGreaterThan(ctRegionStart);
    const tampered = flipByteAt(encoded, ctRegionStart + 3);
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("throws when a byte in the IV region is flipped", () => {
    const key = freshKey();
    const encoded = encryptSecret("some data", key);
    const tampered = flipByteAt(encoded, 0); // first byte is IV
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("throws when a byte in the auth-tag region is flipped", () => {
    const key = freshKey();
    const encoded = encryptSecret("some data", key);
    const buf = Buffer.from(encoded, "base64");
    const tagStart = buf.length - TAG_BYTES;
    const tampered = flipByteAt(encoded, tagStart + 2);
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("throws when the payload is too short", () => {
    const key = freshKey();
    const short = Buffer.alloc(IV_BYTES + TAG_BYTES - 1).toString("base64");
    expect(() => decryptSecret(short, key)).toThrow(/too short/);
  });
});

describe("secrets-cipher: IV uniqueness", () => {
  it("produces different ciphertexts for the same plaintext+key", () => {
    const key = freshKey();
    const plain = "same plaintext";
    const a = encryptSecret(plain, key);
    const b = encryptSecret(plain, key);
    expect(a).not.toBe(b);
    // But both decrypt back to the same value.
    expect(decryptSecret(a, key)).toBe(plain);
    expect(decryptSecret(b, key)).toBe(plain);
  });
});

describe("secrets-cipher: wrong key", () => {
  it("throws when decrypting with a different key", () => {
    const keyA = freshKey();
    const keyB = freshKey();
    const encoded = encryptSecret("top secret", keyA);
    expect(() => decryptSecret(encoded, keyB)).toThrow();
  });
});

describe("secrets-cipher: invalid key lengths", () => {
  const invalidKeys: Array<[string, Buffer]> = [
    ["31 bytes", Buffer.alloc(31)],
    ["33 bytes", Buffer.alloc(33)],
    ["empty buffer", Buffer.alloc(0)],
  ];

  for (const [label, key] of invalidKeys) {
    it(`encryptSecret rejects ${label}`, () => {
      expect(() => encryptSecret("hello", key)).toThrow(/Invalid encryption key/);
    });
    it(`decryptSecret rejects ${label}`, () => {
      // Produce a valid payload with a real key, then try to decrypt with bad key.
      const real = freshKey();
      const encoded = encryptSecret("hello", real);
      expect(() => decryptSecret(encoded, key)).toThrow(/Invalid encryption key/);
    });
  }
});
