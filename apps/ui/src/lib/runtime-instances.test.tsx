import { describe, expect, test } from "bun:test";
import {
  formatSlots,
  runtimeCredentialState,
  runtimeLiveness,
  runtimeLivenessHelp,
  shortRuntimeId,
} from "./runtime-instances";

describe("runtimeLiveness", () => {
  test("live when the server derived it live", () => {
    expect(runtimeLiveness({ status: "active", isLive: true })).toBe("live");
  });

  test("an active-but-stale row presents as stale, never as live", () => {
    expect(runtimeLiveness({ status: "active", isLive: false })).toBe("stale");
  });

  test("a closed runtime presents as offline", () => {
    expect(runtimeLiveness({ status: "offline", isLive: false })).toBe("offline");
  });
});

describe("runtimeCredentialState", () => {
  test("true is ready", () => {
    expect(runtimeCredentialState(true)).toBe("ready");
  });

  test("false is waiting", () => {
    expect(runtimeCredentialState(false)).toBe("waiting");
  });

  test("null and undefined are unreported, not an error state", () => {
    expect(runtimeCredentialState(null)).toBe("unreported");
    expect(runtimeCredentialState(undefined)).toBe("unreported");
  });
});

describe("runtimeLivenessHelp", () => {
  test("mentions the server-provided staleness window", () => {
    expect(runtimeLivenessHelp("stale", 5)).toContain("5-minute");
    expect(runtimeLivenessHelp("live", 10)).toContain("10-minute");
  });

  test("degrades gracefully without a window", () => {
    const help = runtimeLivenessHelp("stale");
    expect(help).toContain("staleness window");
    expect(help).not.toContain("undefined");
  });
});

describe("formatSlots", () => {
  test("singular and plural", () => {
    expect(formatSlots(1)).toBe("1 slot");
    expect(formatSlots(2)).toBe("2 slots");
    expect(formatSlots(0)).toBe("0 slots");
  });
});

describe("shortRuntimeId", () => {
  test("truncates long ids to an 8-char prefix", () => {
    expect(shortRuntimeId("a93f0000-1111-2222-3333-44445555ffff")).toBe("a93f0000…");
  });

  test("leaves short ids untouched", () => {
    expect(shortRuntimeId("abc123")).toBe("abc123");
  });
});
