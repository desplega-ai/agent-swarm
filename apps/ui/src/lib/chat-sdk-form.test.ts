import { describe, expect, test } from "bun:test";
import { CHAT_SDK_ADAPTER_DEFS } from "./chat-sdk-fields";
import {
  buildAll,
  DISCORD_INVITE_PERMISSIONS,
  discordInviteUrl,
  initialDrafts,
  localTunnelPort,
  MASKED_SECRET,
  maskSecretsForPreview,
  mergeAdaptersForSave,
  secretFieldProblem,
} from "./chat-sdk-form";

const discordRef = { $config: "CHAT_SDK_DISCORD_PUBLIC_KEY_ROW" };
const stored = {
  discord: {
    botToken: { $config: "CHAT_SDK_DISCORD_BOT_TOKEN" },
    publicKey: discordRef,
    applicationId: "123456789012345678",
  },
};

describe("Chat SDK form: object values on text fields", () => {
  test("an untouched field keeps its $config object and the input starts empty", () => {
    const drafts = initialDrafts(stored);
    expect(drafts.discord.values.publicKey).toBe("");
    // An unrelated edit must not turn the object into "[object Object]".
    drafts.discord.values.userName = "swarm";
    const { adapters, problems } = buildAll(drafts, stored);
    expect((adapters.discord as Record<string, unknown>).publicKey).toEqual(discordRef);
    expect(problems).toEqual([]);
  });

  test("the baseline equals the stored entry, so an untouched form is not dirty", () => {
    const baseline = JSON.stringify(buildAll(initialDrafts(stored), stored).adapters);
    expect(baseline).toBe(JSON.stringify(stored));
    expect(baseline).not.toContain("[object Object]");
  });

  test("typed text replaces the object", () => {
    const drafts = initialDrafts(stored);
    drafts.discord.values.publicKey = "a".repeat(64);
    const { adapters } = buildAll(drafts, stored);
    expect((adapters.discord as Record<string, unknown>).publicKey).toBe("a".repeat(64));
  });
});

describe("Chat SDK form: JSON preview", () => {
  test("masks plaintext secrets and keeps references and non-secret values", () => {
    const adapters = {
      telegram: { botToken: "123:plain", secretToken: { $config: "ROW" }, mode: "webhook" },
    };
    const preview = maskSecretsForPreview(adapters);
    expect(preview.telegram).toEqual({
      botToken: MASKED_SECRET,
      secretToken: { $config: "ROW" },
      mode: "webhook",
    });
    // The value to save is not changed.
    expect(adapters.telegram.botToken).toBe("123:plain");
  });
});

describe("Chat SDK form: Telegram secret token", () => {
  const telegram = CHAT_SDK_ADAPTER_DEFS.find((def) => def.name === "telegram")!;
  const field = telegram.fields.find((candidate) => candidate.key === "secretToken")!;

  test("accepts 1 to 256 characters from A-Z, a-z, 0-9, underscore and hyphen", () => {
    expect(secretFieldProblem("telegram", field, "")).toBeUndefined();
    expect(secretFieldProblem("telegram", field, "a")).toBeUndefined();
    expect(secretFieldProblem("telegram", field, "Ab_9-z".repeat(10))).toBeUndefined();
    expect(secretFieldProblem("telegram", field, "x".repeat(256))).toBeUndefined();
  });

  test("rejects other characters and values longer than 256", () => {
    expect(secretFieldProblem("telegram", field, "has space")).toBeDefined();
    expect(secretFieldProblem("telegram", field, "dot.token")).toBeDefined();
    expect(secretFieldProblem("telegram", field, "x".repeat(257))).toBeDefined();
  });

  test("an invalid typed token blocks the save", () => {
    const drafts = initialDrafts({});
    drafts.telegram = {
      included: true,
      values: { ...drafts.telegram.values, mode: "webhook" },
      secrets: { botToken: "123:abc", secretToken: "not valid!" },
    };
    const { problems } = buildAll(drafts, {});
    expect(problems.some((problem) => problem.includes("Webhook secret token"))).toBe(true);
  });
});

describe("Chat SDK form: local webhook URL detection", () => {
  test("a localhost URL returns its port", () => {
    expect(localTunnelPort("http://localhost:3013/api/integrations/chat/telegram/webhook")).toBe(
      "3013",
    );
    expect(localTunnelPort("http://127.0.0.1:3913/api/integrations/chat/slack/webhook")).toBe(
      "3913",
    );
    expect(localTunnelPort("http://[::1]:3013/api/integrations/chat/teams/webhook")).toBe("3013");
    expect(localTunnelPort("http://LOCALHOST:3013/x")).toBe("3013");
  });

  test("a local URL without a port returns the protocol default", () => {
    expect(localTunnelPort("http://localhost/api")).toBe("80");
    expect(localTunnelPort("https://localhost/api")).toBe("443");
  });

  test("a public host or a value that is not a URL returns undefined", () => {
    expect(localTunnelPort("https://abc123.ngrok-free.app/api/integrations/chat/x/webhook")).toBe(
      undefined,
    );
    expect(localTunnelPort("https://localhost.example.com/api")).toBe(undefined);
    expect(localTunnelPort("not a url")).toBe(undefined);
    expect(localTunnelPort("")).toBe(undefined);
  });
});

describe("Chat SDK form: partial saves", () => {
  test("missing required fields do not block the save; they are listed as missing", () => {
    const drafts = initialDrafts({});
    drafts.discord.included = true;
    drafts.discord.enabled = true;
    drafts.discord.secrets.botToken = "token-only";
    const built = buildAll(drafts, {});
    expect(built.problems).toEqual([]);
    expect(built.missing).toEqual(["Discord: Public key", "Discord: Application ID"]);
    expect(Object.keys(built.adapters)).toEqual(["discord"]);
    expect(built.secretRows.map((row) => row.key)).toEqual(["CHAT_SDK_DISCORD_BOT_TOKEN"]);
  });

  test("a mode-dependent field counts as missing only in that mode", () => {
    const drafts = initialDrafts({});
    drafts.telegram.included = true;
    drafts.telegram.enabled = true;
    drafts.telegram.secrets.botToken = "t";
    drafts.telegram.values.mode = "webhook";
    expect(buildAll(drafts, {}).missing).toEqual(["Telegram: Webhook secret token"]);
    drafts.telegram.values.mode = "polling";
    expect(buildAll(drafts, {}).missing).toEqual([]);
  });

  test("a format problem still blocks, even on a partial entry", () => {
    const drafts = initialDrafts({});
    drafts.discord.included = true;
    drafts.discord.enabled = true;
    drafts.discord.values.publicKey = "not-hex";
    const built = buildAll(drafts, {});
    expect(built.problems).toEqual(["Discord: Public key must be 64 hex characters"]);
  });
});

describe("Chat SDK form: Discord invite link", () => {
  test("builds the OAuth2 URL with both scopes and the permissions integer", () => {
    const url = discordInviteUrl("1560241123685965894");
    expect(url).toBeDefined();
    const params = new URL(url ?? "").searchParams;
    expect(params.get("client_id")).toBe("1560241123685965894");
    expect(params.get("scope")).toBe("bot applications.commands");
    expect(params.get("permissions")).toBe(DISCORD_INVITE_PERMISSIONS);
  });

  test("the permissions integer is the documented bit set", () => {
    const bits = [10, 11, 38, 35, 34, 16, 6, 15, 14];
    const sum = bits.reduce((acc, bit) => acc + 2n ** BigInt(bit), 0n);
    expect(DISCORD_INVITE_PERMISSIONS).toBe(sum.toString());
  });

  test("no link without a plausible snowflake id", () => {
    expect(discordInviteUrl(undefined)).toBeUndefined();
    expect(discordInviteUrl("")).toBeUndefined();
    expect(discordInviteUrl("abc")).toBeUndefined();
  });
});

describe("Chat SDK form: merge over the stored row on save", () => {
  const telegramEntry = { botToken: { $config: "CHAT_SDK_TELEGRAM_BOT_TOKEN" }, mode: "polling" };

  test("an adapter added elsewhere while the form was open survives the save", () => {
    // The form was built when the row held nothing; Telegram was added since.
    const drafts = initialDrafts({});
    drafts.discord.included = true;
    drafts.discord.enabled = true;
    drafts.discord.values.applicationId = "1560241123685965894";
    const built = buildAll(drafts, {});
    const merged = mergeAdaptersForSave({ telegram: telegramEntry }, {}, drafts, built.adapters);
    expect(merged).toEqual({ telegram: telegramEntry, discord: built.adapters.discord });
  });

  test("an adapter the user switched off is removed, an untouched one keeps the fresh value", () => {
    const stored = { telegram: telegramEntry, discord: { applicationId: "1" } };
    const drafts = initialDrafts(stored);
    drafts.telegram.included = false;
    const built = buildAll(drafts, stored);
    const fresh = { telegram: telegramEntry, discord: { applicationId: "2" } };
    expect(mergeAdaptersForSave(fresh, stored, drafts, built.adapters)).toEqual({
      discord: { applicationId: "2" },
    });
  });

  test("a touched adapter takes the form's version over a concurrent change", () => {
    const stored = { discord: { applicationId: "1" } };
    const drafts = initialDrafts(stored);
    drafts.discord.values.applicationId = "3";
    const built = buildAll(drafts, stored);
    expect(
      mergeAdaptersForSave({ discord: { applicationId: "2" } }, stored, drafts, built.adapters),
    ).toEqual({ discord: { applicationId: "3" } });
  });
});

describe("Chat SDK form: an adapter switched back on reuses its secret rows", () => {
  test("the bot token references its existing row instead of counting as missing", () => {
    const drafts = initialDrafts({});
    drafts.telegram.included = true;
    drafts.telegram.enabled = true;
    drafts.telegram.values.mode = "polling";
    const existing = new Set(["CHAT_SDK_TELEGRAM_BOT_TOKEN"]);
    const built = buildAll(drafts, {}, existing);
    expect(built.missing).toEqual([]);
    expect(built.secretRows).toEqual([]);
    expect(built.adapters.telegram).toEqual({
      botToken: { $config: "CHAT_SDK_TELEGRAM_BOT_TOKEN" },
      mode: "polling",
    });
    // Without the row the token is still missing.
    expect(buildAll(drafts, {}).missing).toEqual(["Telegram: Bot token"]);
  });
});

describe("Chat SDK form: the switch keeps the configuration", () => {
  const telegramEntry = { botToken: { $config: "CHAT_SDK_TELEGRAM_BOT_TOKEN" }, mode: "polling" };

  test("switching off writes enabled: false and keeps every value", () => {
    const stored = { telegram: telegramEntry };
    const drafts = initialDrafts(stored);
    expect(drafts.telegram).toMatchObject({ included: true, enabled: true });
    drafts.telegram.enabled = false;
    expect(buildAll(drafts, stored).adapters.telegram).toEqual({
      ...telegramEntry,
      enabled: false,
    });
  });

  test("switching back on drops the flag; an entry without the flag counts as enabled", () => {
    const stored = { telegram: { ...telegramEntry, enabled: false } };
    const drafts = initialDrafts(stored);
    expect(drafts.telegram.enabled).toBe(false);
    drafts.telegram.enabled = true;
    expect(buildAll(drafts, stored).adapters.telegram).toEqual(telegramEntry);
  });
});
