import { describe, expect, test } from "bun:test";
import * as z from "zod";
import {
  canWriteAssetKey,
  defaultAssetKey,
  isCanonicalAssetKey,
  normalizeAssetKey,
  parseAssetKey,
} from "../assets/key";
import { AssetKeySchema } from "../types";

describe("asset namespace key normalization", () => {
  test("normalizes NFKC, lowercase, and trailing slash", () => {
    expect(normalizeAssetKey("ＳＨＡＲＥＤ/ＲＥＰＯＲＴＳ")).toBe("shared/reports/");
    expect(normalizeAssetKey(" shared/Operations ")).toBe("shared/operations/");
  });

  test("parses shared and personal namespaces without treating keys as identity", () => {
    expect(parseAssetKey("shared/operations/")).toEqual({
      root: "shared",
      key: "shared/operations/",
      segments: ["shared", "operations"],
      relativeSegments: ["operations"],
    });
    expect(parseAssetKey("personal/abc123/drafts/")).toEqual({
      root: "personal",
      key: "personal/abc123/drafts/",
      segments: ["personal", "abc123", "drafts"],
      userId: "abc123",
      relativeSegments: ["drafts"],
    });
  });

  test("builds resource-specific defaults inside the shared namespace", () => {
    expect(defaultAssetKey("task", "ABC-123")).toBe("shared/task:abc-123/");
    expect(defaultAssetKey("workflow", "workflow-id")).toBe("shared/workflow:workflow-id/");
    expect(defaultAssetKey("app", "APP-ID")).toBe("shared/app:app-id/");
    expect(defaultAssetKey("script", "SCRIPT-ID")).toBe("shared/script:script-id/");
    expect(defaultAssetKey("fs:agent-fs", "mapping-id")).toBe("shared/fs:agent-fs:mapping-id/");
  });

  test("rejects absolute, traversal, empty-segment, backslash, NUL, and unknown roots", () => {
    for (const key of [
      "/shared/",
      "shared/../private/",
      "shared/./reports/",
      "shared//reports/",
      "shared\\reports",
      "shared/\0reports/",
      "other/reports/",
      "personal/",
    ]) {
      expect(() => normalizeAssetKey(key)).toThrow();
    }
  });

  test("distinguishes canonical values and scopes personal writes to the trusted user", () => {
    expect(isCanonicalAssetKey("shared/reports/")).toBe(true);
    expect(isCanonicalAssetKey("Shared/Reports")).toBe(false);
    expect(canWriteAssetKey("shared/reports/", null)).toBe(true);
    expect(canWriteAssetKey("personal/user-a/drafts/", "user-a")).toBe(true);
    expect(canWriteAssetKey("personal/user-a/drafts/", "user-b")).toBe(false);
  });

  test("keeps the shared schema JSON-Schema-compatible for MCP tool discovery", () => {
    expect(() => z.toJSONSchema(AssetKeySchema)).not.toThrow();
    expect(AssetKeySchema.safeParse("shared/../private/").success).toBe(false);
    expect(AssetKeySchema.parse(" Shared/Reports ")).toBe(" Shared/Reports ");
  });
});
