import { describe, expect, test } from "bun:test";
import { defaultExportToEnv } from "../utils/config-env-export";

describe("defaultExportToEnv for Chat SDK rows", () => {
  test("CHAT_SDK_* rows start server-only; other keys keep the default", () => {
    expect(defaultExportToEnv("CHAT_SDK_TELEGRAM_BOT_TOKEN")).toBe(false);
    expect(defaultExportToEnv("chat_sdk_adapters")).toBe(false);
    expect(defaultExportToEnv("CHAT_SDK_ENABLED")).toBe(false);
    expect(defaultExportToEnv("MY_TOOL_TOKEN")).toBe(true);
  });
});
