import { describe, expect, test } from "bun:test";
import {
  HARNESS_LABEL,
  harnessSupportsModelSelection,
  isLocalHarness,
  LOCAL_HARNESSES,
  modelGroupsForHarness,
} from "../../apps/ui/src/lib/agent-runtime-models";

describe("ACP dashboard runtime metadata", () => {
  test("lists ACP as a labelled local harness without a model picker catalog", () => {
    expect(LOCAL_HARNESSES).toContain("acp");
    expect(isLocalHarness("acp")).toBe(true);
    expect(HARNESS_LABEL.acp).toBe("ACP");
    expect(harnessSupportsModelSelection("acp")).toBe(false);
    expect(modelGroupsForHarness("acp", undefined, undefined)).toEqual([]);
  });
});
