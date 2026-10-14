import { describe, expect, test } from "bun:test";
import { CHAT_SDK_ADAPTER_DEFS } from "./chat-sdk-fields";
import {
  buildAll,
  initialDrafts,
  localTunnelPort,
  MASKED_SECRET,
  maskSecretsForPreview,
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
