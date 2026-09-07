import { describe, expect, test } from "bun:test";
import { ACP_TARGET_CATALOG as UI_ACP_TARGET_CATALOG } from "../../apps/ui/src/lib/acp-target-catalog";
import {
  HARNESS_LABEL,
  harnessSupportsModelSelection,
  isLocalHarness,
  LOCAL_HARNESSES,
  modelGroupsForHarness,
} from "../../apps/ui/src/lib/agent-runtime-models";
import { ACP_TARGET_CATALOG } from "../providers/acp-target-catalog";

describe("ACP dashboard runtime metadata", () => {
  test("keeps the dashboard preset catalog in sync", () => {
    expect(UI_ACP_TARGET_CATALOG).toEqual(ACP_TARGET_CATALOG);
  });

  test("lists ACP as a labelled local harness without a model picker catalog", () => {
    expect(LOCAL_HARNESSES).toContain("acp");
    expect(isLocalHarness("acp")).toBe(true);
    expect(HARNESS_LABEL.acp).toBe("ACP");
    expect(harnessSupportsModelSelection("acp")).toBe(false);
    expect(modelGroupsForHarness("acp", undefined, undefined)).toEqual([]);
  });
});
