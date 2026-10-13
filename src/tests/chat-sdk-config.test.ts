import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb, upsertSwarmConfig } from "../be/db";
import { validateConfigValue } from "../be/swarm-config-guard";
import {
  assertNoSlackClash,
  ChatSdkAdaptersSchema,
  getChatSdkConfig,
  readApiUrlOverrides,
} from "../integrations/chat-sdk/config";

const TEST_DB_PATH = "./test-chat-sdk-config.sqlite";
const ENV_KEYS = [
  "CHAT_SDK_ENABLED",
  "CHAT_SDK_ADAPTERS",
  "CHAT_SDK_API_URL_OVERRIDES",
  "SLACK_DISABLE",
  "CHAT_TEST_ENV_ONLY",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

/** The brainstorm's example config, one adapter of each kind. */
const BRAINSTORM_EXAMPLE = {
  slack: {
    botToken: { $config: "SLACK_CHAT_BOT_TOKEN" },
    signingSecret: { $config: "SLACK_CHAT_SIGNING_SECRET" },
    mode: "webhook",
  },
  discord: {
    botToken: { $config: "DISCORD_BOT_TOKEN" },
    publicKey: "abcdef",
    applicationId: "1234",
    respondToChannelIds: ["c1"],
    respondToGlobalMentions: true,
  },
  telegram: {
    botToken: { $config: "TG_TOKEN" },
    secretToken: "s3cret-token",
    mode: "polling",
    allowedUserIds: ["1", 2],
  },
  teams: { appId: "app", appPassword: { $config: "TEAMS_PW" }, appType: "SingleTenant" },
};

function setAdapters(value: unknown): void {
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify(value);
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await upsertSwarmConfig({
    scope: "global",
    key: "TG_TOKEN",
    value: "tg-token-from-config",
    isSecret: true,
  });
  await upsertSwarmConfig({ scope: "global", key: "TG_SECRET", value: "tg-secret-from-config" });
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("ChatSdkAdaptersSchema", () => {
  test("accepts the brainstorm example", () => {
    expect(ChatSdkAdaptersSchema.safeParse(BRAINSTORM_EXAMPLE).success).toBe(true);
  });

  test("rejects a non-object adapter and an unknown adapter name", () => {
    expect(ChatSdkAdaptersSchema.safeParse({ telegram: "token" }).success).toBe(false);
    expect(ChatSdkAdaptersSchema.safeParse({ whatsapp: {} }).success).toBe(false);
  });

  test("defaults telegram mode to webhook, never the SDK's auto", () => {
    const parsed = ChatSdkAdaptersSchema.parse({ telegram: { botToken: "x" } });
    expect(parsed.telegram?.mode).toBe("webhook");
    expect(
      ChatSdkAdaptersSchema.safeParse({ telegram: { botToken: "x", mode: "auto" } }).success,
    ).toBe(false);
  });

  test("passes unknown adapter keys through", () => {
    const parsed = ChatSdkAdaptersSchema.parse({
      telegram: { botToken: "x", mentionOnReply: true },
    });
    expect((parsed.telegram as Record<string, unknown>).mentionOnReply).toBe(true);
  });
});

describe("CHAT_SDK_ADAPTERS validator", () => {
  test("returns an error string for bad JSON", () => {
    expect(validateConfigValue("CHAT_SDK_ADAPTERS", "{not json")).toContain("not valid JSON");
  });

  test("rejects operator base URLs, verifiers and unverified webhooks", () => {
    for (const key of ["apiUrl", "apiBaseUrl", "webhookVerifier", "allowUnverifiedWebhooks"]) {
      const error = validateConfigValue(
        "CHAT_SDK_ADAPTERS",
        JSON.stringify({ telegram: { botToken: "x", [key]: "http://evil.example" } }),
      );
      expect(error).toContain(`telegram.${key}`);
    }
  });

  test("accepts a valid value without resolving refs", () => {
    expect(validateConfigValue("CHAT_SDK_ADAPTERS", JSON.stringify(BRAINSTORM_EXAMPLE))).toBeNull();
  });

  test("CHAT_SDK_ENABLED is a boolean key", () => {
    expect(validateConfigValue("CHAT_SDK_ENABLED", "true")).toBeNull();
    expect(validateConfigValue("CHAT_SDK_ENABLED", "yes please")).not.toBeNull();
  });
});

describe("getChatSdkConfig", () => {
  test("disabled returns no adapters and no error", async () => {
    process.env.CHAT_SDK_ENABLED = "false";
    process.env.CHAT_SDK_ADAPTERS = JSON.stringify({ telegram: { botToken: "x" } });
    expect(await getChatSdkConfig()).toEqual({ enabled: false, adapters: {} });
  });

  test("resolves refs into functions for botToken and strings for secretToken", async () => {
    setAdapters({
      telegram: { botToken: { $config: "TG_TOKEN" }, secretToken: { $config: "TG_SECRET" } },
    });
    const config = await getChatSdkConfig();
    expect(config.error).toBeUndefined();
    const telegram = config.adapters.telegram!;
    expect(typeof telegram.botToken).toBe("function");
    expect(await (telegram.botToken as () => Promise<string>)()).toBe("tg-token-from-config");
    expect(telegram.secretToken).toBe("tg-secret-from-config");
    expect(telegram.mode).toBe("webhook");
    expect(telegram.userName).toBeUndefined();
  });

  test("rejects reserved keys as $config targets", async () => {
    for (const key of ["API_KEY", "SECRETS_ENCRYPTION_KEY", "CHAT_SDK_API_URL_OVERRIDES"]) {
      setAdapters({ telegram: { botToken: { $config: key }, secretToken: "s" } });
      const config = await getChatSdkConfig();
      expect(config.adapters).toEqual({});
      expect(config.error).toContain(`reserved key '${key}'`);
    }
  });

  test("a ref to an env-only value is reported missing", async () => {
    process.env.CHAT_TEST_ENV_ONLY = "lives-only-in-env";
    setAdapters({ telegram: { botToken: { $config: "CHAT_TEST_ENV_ONLY" }, secretToken: "s" } });
    const config = await getChatSdkConfig();
    expect(config.adapters).toEqual({});
    expect(config.error).toContain("CHAT_TEST_ENV_ONLY");
  });

  test("reports invalid JSON and schema errors without throwing", async () => {
    process.env.CHAT_SDK_ENABLED = "true";
    process.env.CHAT_SDK_ADAPTERS = "{oops";
    expect((await getChatSdkConfig()).error).toContain("not valid JSON");
    setAdapters({ telegram: { botToken: "x", apiUrl: "http://evil.example" } });
    expect((await getChatSdkConfig()).error).toContain("telegram.apiUrl");
  });
});

describe("assertNoSlackClash", () => {
  test("throws for a slack adapter unless SLACK_DISABLE=true", async () => {
    setAdapters({ slack: { botToken: "xoxb-1", signingSecret: "sig" } });
    delete process.env.SLACK_DISABLE;
    const config = await getChatSdkConfig();
    expect(() => assertNoSlackClash(config)).toThrow("set SLACK_DISABLE=true");
    process.env.SLACK_DISABLE = "true";
    expect(() => assertNoSlackClash(config)).not.toThrow();
  });

  test("ignores configs without slack", () => {
    delete process.env.SLACK_DISABLE;
    expect(() => assertNoSlackClash({ enabled: true, adapters: { telegram: {} } })).not.toThrow();
  });
});

describe("readApiUrlOverrides", () => {
  test("reads known adapters from env JSON and ignores garbage", () => {
    process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({
      telegram: "http://127.0.0.1:1",
      unknown: "http://x",
    });
    expect(readApiUrlOverrides()).toEqual({ telegram: "http://127.0.0.1:1" });
    process.env.CHAT_SDK_API_URL_OVERRIDES = "not json";
    expect(readApiUrlOverrides()).toEqual({});
  });
});
