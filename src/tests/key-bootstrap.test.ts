import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetEncryptionKeyForTests,
  getEncryptionKey,
  resolveEncryptionKey,
} from "../be/crypto/key-bootstrap";
import { AES_KEY_BYTES } from "../be/crypto/secrets-cipher";

const ENV_KEY = "SECRETS_ENCRYPTION_KEY";
const ENV_KEY_FILE = "SECRETS_ENCRYPTION_KEY_FILE";

let tmpDir: string;
let originalEnvKey: string | undefined;
let originalEnvKeyFile: string | undefined;
let warnSpy: { messages: string[]; restore: () => void };

function installWarnSpy(): typeof warnSpy {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

beforeEach(() => {
  __resetEncryptionKeyForTests();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "swarm-crypto-"));
  originalEnvKey = process.env[ENV_KEY];
  originalEnvKeyFile = process.env[ENV_KEY_FILE];
  delete process.env[ENV_KEY];
  delete process.env[ENV_KEY_FILE];
  warnSpy = installWarnSpy();
});

afterEach(() => {
  warnSpy.restore();
  if (originalEnvKey === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnvKey;
  if (originalEnvKeyFile === undefined) delete process.env[ENV_KEY_FILE];
  else process.env[ENV_KEY_FILE] = originalEnvKeyFile;
  rmSync(tmpDir, { recursive: true, force: true });
  __resetEncryptionKeyForTests();
});

describe("key-bootstrap: precedence", () => {
  it("uses SECRETS_ENCRYPTION_KEY env var when set, ignores file sources", () => {
    const envKeyBytes = randomBytes(AES_KEY_BYTES);
    process.env[ENV_KEY] = envKeyBytes.toString("base64");

    // Also write a different key to a file path so we can prove it was ignored.
    const otherKey = randomBytes(AES_KEY_BYTES).toString("base64");
    const keyFilePath = path.join(tmpDir, ".encryption-key");
    writeFileSync(keyFilePath, otherKey);

    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(envKeyBytes)).toBe(true);
  });

  it("uses SECRETS_ENCRYPTION_KEY_FILE when only the file env var is set", () => {
    const fileKeyBytes = randomBytes(AES_KEY_BYTES);
    const externalKeyPath = path.join(tmpDir, "external.key");
    writeFileSync(externalKeyPath, fileKeyBytes.toString("base64"));
    process.env[ENV_KEY_FILE] = externalKeyPath;

    // Write a different key to .encryption-key to prove the file env var wins.
    const otherKey = randomBytes(AES_KEY_BYTES).toString("base64");
    const onDiskKeyPath = path.join(tmpDir, ".encryption-key");
    writeFileSync(onDiskKeyPath, otherKey);

    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(fileKeyBytes)).toBe(true);
  });

  it("reads .encryption-key when only the on-disk file exists", () => {
    const diskKeyBytes = randomBytes(AES_KEY_BYTES);
    const keyFilePath = path.join(tmpDir, ".encryption-key");
    writeFileSync(keyFilePath, diskKeyBytes.toString("base64"));

    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(diskKeyBytes)).toBe(true);
  });
});

describe("key-bootstrap: auto-generate", () => {
  it("generates a new .encryption-key file when nothing is set", () => {
    const dbPath = path.join(tmpDir, "test.sqlite");
    const keyFilePath = path.join(tmpDir, ".encryption-key");
    expect(existsSync(keyFilePath)).toBe(false);

    const resolved = resolveEncryptionKey(dbPath);

    // Key is the right length.
    expect(resolved.length).toBe(AES_KEY_BYTES);

    // File was created.
    expect(existsSync(keyFilePath)).toBe(true);

    // File mode is exactly 0o600.
    const mode = statSync(keyFilePath).mode & 0o777;
    expect(mode).toBe(0o600);

    // File content is base64 that decodes to exactly 32 bytes.
    const content = readFileSync(keyFilePath, "utf8").trim();
    const decoded = Buffer.from(content, "base64");
    expect(decoded.length).toBe(AES_KEY_BYTES);

    // File content round-trips to the resolved key.
    expect(decoded.equals(resolved)).toBe(true);

    // Warning was logged with the expected text.
    expect(warnSpy.messages.length).toBeGreaterThanOrEqual(1);
    const warning = warnSpy.messages.find((m) =>
      m.includes("[secrets] Generated new encryption key"),
    );
    expect(warning).toBeTruthy();
    expect(warning).toContain(keyFilePath);
    expect(warning).toContain("BACK THIS FILE UP");
    expect(warning).toContain("Losing it means losing all encrypted secrets.");
  });

  it("is idempotent — second call returns same key without regenerating", () => {
    const dbPath = path.join(tmpDir, "test.sqlite");
    const first = resolveEncryptionKey(dbPath);

    // Second call should return exactly the same key via in-memory cache.
    const second = resolveEncryptionKey(dbPath);
    expect(second.equals(first)).toBe(true);

    // Simulate a new process boot by clearing the cache — should read the
    // file written the first time and produce the same key.
    __resetEncryptionKeyForTests();
    const third = resolveEncryptionKey(dbPath);
    expect(third.equals(first)).toBe(true);
  });
});

describe("key-bootstrap: validation", () => {
  it("throws when SECRETS_ENCRYPTION_KEY decodes to the wrong length", () => {
    process.env[ENV_KEY] = Buffer.alloc(16).toString("base64"); // 16 bytes, not 32
    const dbPath = path.join(tmpDir, "test.sqlite");
    expect(() => resolveEncryptionKey(dbPath)).toThrow(
      /Invalid encryption key at env:SECRETS_ENCRYPTION_KEY/,
    );
    expect(() => resolveEncryptionKey(dbPath)).toThrow(/got 16 bytes/);
  });

  it("error message includes openssl generation commands and the -base64 39 hint", () => {
    process.env[ENV_KEY] = Buffer.alloc(16).toString("base64");
    const dbPath = path.join(tmpDir, "test.sqlite");
    let caught: Error | null = null;
    try {
      resolveEncryptionKey(dbPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    const msg = caught?.message ?? "";
    expect(msg).toContain("openssl rand -base64 32");
    expect(msg).toContain("openssl rand -hex 32");
    expect(msg).toContain("openssl rand -base64 39");
  });

  it("accepts a hex-encoded 32-byte key via SECRETS_ENCRYPTION_KEY env var", () => {
    const keyBytes = randomBytes(AES_KEY_BYTES);
    process.env[ENV_KEY] = keyBytes.toString("hex");
    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(keyBytes)).toBe(true);
  });

  it("accepts a hex-encoded 32-byte key via SECRETS_ENCRYPTION_KEY_FILE", () => {
    const keyBytes = randomBytes(AES_KEY_BYTES);
    const keyPath = path.join(tmpDir, "hex.key");
    writeFileSync(keyPath, keyBytes.toString("hex"));
    process.env[ENV_KEY_FILE] = keyPath;
    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(keyBytes)).toBe(true);
  });

  it("accepts a hex-encoded 32-byte key via on-disk .encryption-key", () => {
    const keyBytes = randomBytes(AES_KEY_BYTES);
    const keyFilePath = path.join(tmpDir, ".encryption-key");
    writeFileSync(keyFilePath, keyBytes.toString("hex"));
    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(keyBytes)).toBe(true);
  });

  it("accepts uppercase hex-encoded keys", () => {
    const keyBytes = randomBytes(AES_KEY_BYTES);
    process.env[ENV_KEY] = keyBytes.toString("hex").toUpperCase();
    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    expect(resolved.equals(keyBytes)).toBe(true);
  });

  it("throws when SECRETS_ENCRYPTION_KEY_FILE points to a malformed file", () => {
    const keyPath = path.join(tmpDir, "bad.key");
    writeFileSync(keyPath, Buffer.alloc(10).toString("base64"));
    process.env[ENV_KEY_FILE] = keyPath;
    const dbPath = path.join(tmpDir, "test.sqlite");
    expect(() => resolveEncryptionKey(dbPath)).toThrow(
      /Invalid encryption key at env:SECRETS_ENCRYPTION_KEY_FILE/,
    );
  });

  it("throws when SECRETS_ENCRYPTION_KEY_FILE points to a non-existent file", () => {
    process.env[ENV_KEY_FILE] = path.join(tmpDir, "does-not-exist.key");
    const dbPath = path.join(tmpDir, "test.sqlite");
    expect(() => resolveEncryptionKey(dbPath)).toThrow(/does not exist/);
  });

  it("throws when .encryption-key file on disk is malformed", () => {
    const keyFilePath = path.join(tmpDir, ".encryption-key");
    writeFileSync(keyFilePath, "not-even-base64-real-data-$$$");
    const dbPath = path.join(tmpDir, "test.sqlite");
    expect(() => resolveEncryptionKey(dbPath)).toThrow(/Invalid encryption key at file:/);
    // Ensure we did NOT silently overwrite it with a new generated key.
    const afterContent = readFileSync(keyFilePath, "utf8");
    expect(afterContent).toBe("not-even-base64-real-data-$$$");
  });
});

describe("key-bootstrap: in-memory database", () => {
  it("throws when dbPath is :memory: and no env vars are set", () => {
    expect(() => resolveEncryptionKey(":memory:")).toThrow(
      /In-memory database requires SECRETS_ENCRYPTION_KEY or SECRETS_ENCRYPTION_KEY_FILE to be set explicitly/,
    );
  });

  it("uses SECRETS_ENCRYPTION_KEY when dbPath is :memory:", () => {
    const envKeyBytes = randomBytes(AES_KEY_BYTES);
    process.env[ENV_KEY] = envKeyBytes.toString("base64");
    const resolved = resolveEncryptionKey(":memory:");
    expect(resolved.equals(envKeyBytes)).toBe(true);
  });
});

describe("key-bootstrap: getEncryptionKey", () => {
  it("throws if called before resolveEncryptionKey", () => {
    expect(() => getEncryptionKey()).toThrow(/Encryption key not resolved yet/);
  });

  it("returns the resolved key after resolveEncryptionKey succeeds", () => {
    const dbPath = path.join(tmpDir, "test.sqlite");
    const resolved = resolveEncryptionKey(dbPath);
    const fetched = getEncryptionKey();
    expect(fetched.equals(resolved)).toBe(true);
  });
});
