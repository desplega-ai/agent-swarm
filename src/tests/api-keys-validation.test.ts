import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  closeDb,
  getAvailableKeyIndices,
  getDbClient,
  getKeyStatuses,
  initDb,
  recordKeyValidation,
} from "../be/db";
import { handleApiKeys } from "../http/api-keys";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB = "./test-api-keys-validation.sqlite";
const keyType = "ANTHROPIC_API_KEY";
const rejected = { keyIndex: 0, keySuffix: "aaa11", ok: false, httpStatus: 401 };

async function call(method: string, url: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
  let statusCode = 200;
  let responseBody = "";
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      responseBody += chunk ?? "";
    },
  };
  const handled = await handleApiKeys(
    req as never,
    res as never,
    getPathSegments(url),
    parseQueryParams(url),
  );
  return { handled, statusCode, body: JSON.parse(responseBody) };
}

describe("pooled key validation", () => {
  beforeAll(() => {
    initDb(TEST_DB);
  });
  beforeEach(async () => {
    await getDbClient().run("DELETE FROM api_key_status");
  });
  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      await Bun.file(TEST_DB + suffix)
        .delete()
        .catch(() => {});
    }
  });

  test("HTTP 401 marks the key as rejected", async () => {
    await recordKeyValidation(keyType, [{ ...rejected, httpStatus: 401 }]);
    const [row] = await getKeyStatuses(keyType);
    expect(row).toMatchObject({
      keyIndex: 0,
      keySuffix: "aaa11",
      provider: "claude",
      lastValidationError: "HTTP 401",
    });
    expect(row!.lastValidationFailedAt).not.toBeNull();
  });

  test("a pass clears rejection and updates the index", async () => {
    await recordKeyValidation(keyType, [rejected]);
    await recordKeyValidation(keyType, [{ ...rejected, keyIndex: 2, ok: true }]);
    expect((await getKeyStatuses(keyType))[0]).toMatchObject({
      keyIndex: 2,
      lastValidationError: null,
      lastValidationFailedAt: null,
    });
  });

  // 403 included: a valid key can lack the scope of the list endpoint.
  test.each([
    403,
    500,
    429,
    undefined,
  ])("failure with status %s preserves existing state", async (httpStatus) => {
    await recordKeyValidation(keyType, [rejected]);
    const before = await getKeyStatuses(keyType);
    await recordKeyValidation(keyType, [{ ...rejected, keyIndex: 3, httpStatus }]);
    expect(await getKeyStatuses(keyType)).toEqual(before);
    await recordKeyValidation("OPENAI_API_KEY", [{ ...rejected, httpStatus }]);
    expect(await getKeyStatuses("OPENAI_API_KEY")).toEqual([]);
  });

  test("a removed suffix cannot block a replacement at the same index", async () => {
    await recordKeyValidation(keyType, [rejected]);
    await recordKeyValidation(keyType, [{ keyIndex: 0, keySuffix: "bbb22", ok: true }]);
    const rows = await getKeyStatuses(keyType);
    expect(rows.find((row) => row.keySuffix === "aaa11")).toMatchObject({
      lastValidationError: null,
      lastValidationFailedAt: null,
    });
    expect((await getAvailableKeyIndices(keyType, 1)).availableIndices).toEqual([0]);
  });

  test("rejections and removed-suffix cleanup stay within their scope and key type", async () => {
    await recordKeyValidation(keyType, [rejected], "agent", "agent-a");
    await recordKeyValidation(keyType, [rejected], "agent", "agent-b");
    await recordKeyValidation("OPENAI_API_KEY", [rejected], "agent", "agent-a");
    await recordKeyValidation(
      keyType,
      [{ keyIndex: 0, keySuffix: "bbb22", ok: true }],
      "agent",
      "agent-a",
    );
    expect((await getAvailableKeyIndices(keyType, 1, "agent", "agent-a")).availableIndices).toEqual(
      [0],
    );
    expect((await getAvailableKeyIndices(keyType, 1, "agent", "agent-b")).availableIndices).toEqual(
      [],
    );
    expect(
      (await getAvailableKeyIndices("OPENAI_API_KEY", 1, "agent", "agent-a")).availableIndices,
    ).toEqual([]);
  });

  test("availability excludes rejected keys and reports their indices", async () => {
    await recordKeyValidation(keyType, [rejected, { keyIndex: 1, keySuffix: "bbb22", ok: true }]);
    expect(await getAvailableKeyIndices(keyType, 3)).toMatchObject({
      availableIndices: [1, 2],
      rejectedIndices: [0],
    });
  });

  test("availability is empty when every key is rejected", async () => {
    await recordKeyValidation(keyType, [
      rejected,
      { ...rejected, keyIndex: 1, keySuffix: "bbb22" },
    ]);
    expect(await getAvailableKeyIndices(keyType, 2)).toMatchObject({
      availableIndices: [],
      rejectedIndices: [0, 1],
    });
  });

  test("the report handler records validation and exposes it in reads", async () => {
    expect(
      await call("POST", "/api/keys/report-validation", { keyType, keys: [rejected] }),
    ).toEqual({
      handled: true,
      statusCode: 200,
      body: { success: true, message: "Key validation recorded" },
    });
    expect(
      (await call("GET", `/api/keys/available?keyType=${keyType}&totalKeys=2`)).body,
    ).toMatchObject({
      availableIndices: [1],
      rejectedIndices: [0],
    });
    const status = await call("GET", `/api/keys/status?keyType=${keyType}`);
    expect(status.body.keys[0]).toMatchObject({ lastValidationError: "HTTP 401" });
    expect(status.body.keys[0].lastValidationFailedAt).not.toBeNull();
  });

  test("the report handler rejects an empty pool", async () => {
    expect(
      (await call("POST", "/api/keys/report-validation", { keyType, keys: [] })).statusCode,
    ).toBe(400);
    expect(await getKeyStatuses(keyType)).toEqual([]);
  });
});
