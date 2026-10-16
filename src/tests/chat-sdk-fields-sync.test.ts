import { describe, expect, test } from "bun:test";
import { CHAT_SDK_ADAPTER_DEFS, chatSdkSecretKey } from "../../apps/ui/src/lib/chat-sdk-fields";
import {
  CHAT_SDK_ADAPTER_FIELDS,
  CHAT_SDK_ADAPTER_NAMES,
  SlackAdapterSchema,
  TeamsAdapterSchema,
  TelegramAdapterSchema,
} from "../integrations/chat-sdk/schema";

/*
 * The dashboard keeps a plain field list for the Chat SDK card because it
 * cannot import the API's zod schemas. This test keeps the two equal.
 */
describe("Chat SDK field list sync (UI vs API schema)", () => {
  test("the UI lists the same adapters in the same order", () => {
    expect(CHAT_SDK_ADAPTER_DEFS.map((def) => def.name)).toEqual([...CHAT_SDK_ADAPTER_NAMES]);
  });

  test("every adapter has the same field names", () => {
    for (const def of CHAT_SDK_ADAPTER_DEFS) {
      expect(def.fields.map((field) => field.key).sort()).toEqual(
        [...CHAT_SDK_ADAPTER_FIELDS[def.name]].sort(),
      );
    }
  });

  test("select options match the schema enums", () => {
    const enums: Record<string, readonly string[]> = {
      "telegram.mode": TelegramAdapterSchema.shape.mode.unwrap().options,
      "slack.mode": SlackAdapterSchema.shape.mode.unwrap().options,
      "teams.appType": TeamsAdapterSchema.shape.appType.unwrap().options,
    };
    const selects: Array<readonly [string, string[] | undefined]> = CHAT_SDK_ADAPTER_DEFS.flatMap(
      (def) =>
        def.fields
          .filter((field) => field.kind === "select")
          .map((field) => [`${def.name}.${field.key}`, field.options] as const),
    );
    expect(selects.map(([path]) => path).sort()).toEqual(Object.keys(enums).sort());
    for (const [path, options] of selects) {
      expect(options).toEqual([...(enums[path] ?? [])]);
    }
  });

  test("secret rows are named CHAT_SDK_<ADAPTER>_<FIELD>", () => {
    expect(chatSdkSecretKey("telegram", "botToken")).toBe("CHAT_SDK_TELEGRAM_BOT_TOKEN");
    expect(chatSdkSecretKey("teams", "appPassword")).toBe("CHAT_SDK_TEAMS_APP_PASSWORD");
  });
});
