import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as otelModule from "../otel";
import { ackSlackMessage, finalizeSlackMessageReaction } from "../slack/ack";
import {
  normalizeSlackReactionShortcode,
  reactionName,
  SLACK_REACTION_CONFIG_KEYS,
  SLACK_REACTION_DEFAULTS,
  type SlackReactionEvent,
} from "../slack/reaction-shortcode";

const ALL_EVENTS: SlackReactionEvent[] = [
  "accepted",
  "buffered",
  "now",
  "steered",
  "completed",
  "failed",
];

/** The four acceptance-stage names `main` removed as a fixed list at finalize. */
const DEFAULT_ACCEPTANCE_NAMES = ["eyes", "heavy_plus_sign", "zap", "speech_balloon"];

function clearReactionEnv() {
  for (const key of Object.values(SLACK_REACTION_CONFIG_KEYS)) delete process.env[key];
}

type ReactionCall = { method: "add" | "remove"; name: string };

/** A minimal Slack client that records every reaction write in order. */
function recordingClient(options: { removeError?: (name: string) => unknown } = {}) {
  const calls: ReactionCall[] = [];
  const client = {
    reactions: {
      add: async ({ name }: { name: string }) => {
        calls.push({ method: "add", name });
        return { ok: true };
      },
      remove: async ({ name }: { name: string }) => {
        calls.push({ method: "remove", name });
        const error = options.removeError?.(name);
        if (error) throw error;
        return { ok: true };
      },
    },
  };
  return { client, calls };
}

describe("reaction-shortcode.ts", () => {
  // Snapshot so this suite's env writes never leak into a later test file
  // sharing the same process (see the OTel test below, which also mutates
  // OTEL_EXPORTER_OTLP_ENDPOINT).
  const previousEnv: Record<string, string | undefined> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
  for (const key of Object.values(SLACK_REACTION_CONFIG_KEYS)) {
    previousEnv[key] = process.env[key];
  }

  beforeEach(() => {
    clearReactionEnv();
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("reactionName returns the default for every event when env is unset", () => {
    for (const event of ALL_EVENTS) {
      expect(reactionName(event)).toBe(SLACK_REACTION_DEFAULTS[event]);
    }
  });

  test("reactionName normalizes colons, whitespace and case", () => {
    process.env.SLACK_REACTION_COMPLETED = "  :Swarm_Check_Mark:  ";
    expect(reactionName("completed")).toBe("swarm_check_mark");
  });

  test("reactionName rejects a value outside the shortcode format and returns the default", () => {
    for (const bad of ["white check", "✅", "Check!", "", "::"]) {
      process.env.SLACK_REACTION_COMPLETED = bad;
      expect(reactionName("completed")).toBe("white_check_mark");
    }
  });

  test("normalizeSlackReactionShortcode returns null for non-strings and bad values", () => {
    expect(normalizeSlackReactionShortcode(undefined)).toBeNull();
    expect(normalizeSlackReactionShortcode(42)).toBeNull();
    expect(normalizeSlackReactionShortcode("a b")).toBeNull();
    expect(normalizeSlackReactionShortcode("+1")).toBe("+1");
    expect(normalizeSlackReactionShortcode("thumbsup")).toBe("thumbsup");
    expect(normalizeSlackReactionShortcode("o'clock")).toBe("o'clock");
    expect(normalizeSlackReactionShortcode("e-mail")).toBe("e-mail");
  });

  test("normalizeSlackReactionShortcode accepts one optional ::skin-tone-[2-6] suffix", () => {
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-6")).toBe("thumbsup::skin-tone-6");
    expect(normalizeSlackReactionShortcode(":thumbsup::skin-tone-6:")).toBe(
      "thumbsup::skin-tone-6",
    );
    expect(normalizeSlackReactionShortcode("THUMBSUP::SKIN-TONE-2")).toBe("thumbsup::skin-tone-2");
    expect(normalizeSlackReactionShortcode("+1::skin-tone-3")).toBe("+1::skin-tone-3");
  });

  test("normalizeSlackReactionShortcode rejects an out-of-range, malformed, or doubled skin-tone suffix", () => {
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-1")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-7")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup:::skin-tone-6")).toBeNull();
    expect(normalizeSlackReactionShortcode("thumbsup::skin-tone-6::skin-tone-6")).toBeNull();
  });

  test("no Slack source file outside ack.ts names a reaction shortcode or calls reactions.add", async () => {
    const glob = new Bun.Glob("*.ts");
    const dir = new URL("../slack/", import.meta.url);
    for await (const relPath of glob.scan({ cwd: dir.pathname })) {
      if (
        relPath === "ack.ts" ||
        relPath === "reaction-shortcode.ts" ||
        relPath.endsWith(".test.ts")
      )
        continue;
      const source = await Bun.file(new URL(relPath, dir)).text();
      expect(source).not.toContain("reactions.add(");
      for (const name of Object.values(SLACK_REACTION_DEFAULTS)) {
        expect(source).not.toContain(`"${name}"`);
      }
    }
  });

  test("recordSlackReactionInvalidName is a no-op when OTel is not configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    otelModule._resetOtelForTests();
    expect(otelModule.recordSlackReactionInvalidName("completed")).toBeUndefined();
  });

  test("a configured invalid name falls back to the default for every event and counts once per event", async () => {
    const spy = spyOn(otelModule, "recordSlackReactionInvalidName");
    spy.mockClear();

    for (const event of ALL_EVENTS) {
      process.env[SLACK_REACTION_CONFIG_KEYS[event]] = "not_a_real_emoji_xyz";
      const calls: Array<{ name: string }> = [];
      const add = async ({ name }: { name: string }) => {
        calls.push({ name });
        if (name === "not_a_real_emoji_xyz") throw { data: { error: "invalid_name" } };
        return { ok: true, name };
      };
      const client = { reactions: { add } };

      await ackSlackMessage(client as never, "C_TEST", "1000.0001", reactionName(event), event);

      expect(calls).toHaveLength(2);
      expect(calls[1].name).toBe(SLACK_REACTION_DEFAULTS[event]);

      delete process.env[SLACK_REACTION_CONFIG_KEYS[event]];
    }

    expect(spy).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });

  test("already_reacted on acknowledge is a silent no-op", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const add = async () => {
      throw { data: { error: "already_reacted" } };
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0002",
      "eyes",
      "accepted",
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  // --- Finalize cleanup: the configurable form of main's fixed-list removal ---

  test("finalize removes the four default acceptance-stage names, then adds the terminal reaction", async () => {
    const { client, calls } = recordingClient();
    await finalizeSlackMessageReaction(
      client as never,
      "C_TEST",
      "2000.0001",
      reactionName("completed"),
      "completed",
    );
    expect(calls.filter((call) => call.method === "remove").map((call) => call.name)).toEqual(
      DEFAULT_ACCEPTANCE_NAMES,
    );
    expect(calls.at(-1)).toEqual({ method: "add", name: "white_check_mark" });
  });

  test("finalize removes the configured acceptance-stage names when the config overrides them", async () => {
    process.env.SLACK_REACTION_ACCEPTED = "swarm_eyes";
    process.env.SLACK_REACTION_BUFFERED = "swarm_plus";
    process.env.SLACK_REACTION_NOW = "swarm_zap";
    process.env.SLACK_REACTION_STEERED = "swarm_balloon";
    process.env.SLACK_REACTION_FAILED = "swarm_x";
    const { client, calls } = recordingClient();
    await finalizeSlackMessageReaction(
      client as never,
      "C_TEST",
      "2000.0002",
      reactionName("failed"),
      "failed",
    );
    expect(calls.filter((call) => call.method === "remove").map((call) => call.name)).toEqual([
      "swarm_eyes",
      "swarm_plus",
      "swarm_zap",
      "swarm_balloon",
    ]);
    expect(calls.at(-1)).toEqual({ method: "add", name: "swarm_x" });
  });

  test("finalize removes a shared name once when two events are configured to the same shortcode", async () => {
    process.env.SLACK_REACTION_ACCEPTED = "hourglass";
    process.env.SLACK_REACTION_BUFFERED = "hourglass";
    const { client, calls } = recordingClient();
    await finalizeSlackMessageReaction(
      client as never,
      "C_TEST",
      "2000.0003",
      reactionName("completed"),
      "completed",
    );
    expect(calls.filter((call) => call.method === "remove").map((call) => call.name)).toEqual([
      "hourglass",
      "zap",
      "speech_balloon",
    ]);
  });

  test("finalize consults no process state: a message never acknowledged in this process (API restart) is still cleaned up", async () => {
    // No ackSlackMessage call precedes finalize, modelling an API restart
    // between acceptance and finalization. Removal depends only on the
    // configured names, exactly like main's fixed-list removal.
    const { client, calls } = recordingClient();
    await finalizeSlackMessageReaction(
      client as never,
      "C_TEST",
      "2000.0004",
      reactionName("completed"),
      "completed",
    );
    expect(calls.filter((call) => call.method === "remove")).toHaveLength(
      DEFAULT_ACCEPTANCE_NAMES.length,
    );
    expect(calls.at(-1)).toEqual({ method: "add", name: "white_check_mark" });
  });

  test("finalize treats no_reaction, message_not_found and invalid_name on removal as expected and still adds the terminal reaction", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const codes: Record<string, string> = {
      eyes: "no_reaction",
      heavy_plus_sign: "message_not_found",
      zap: "invalid_name",
    };
    const { client, calls } = recordingClient({
      removeError: (name) => (codes[name] ? { data: { error: codes[name] } } : undefined),
    });
    await finalizeSlackMessageReaction(
      client as never,
      "C_TEST",
      "2000.0005",
      reactionName("completed"),
      "completed",
    );
    expect(calls.filter((call) => call.method === "remove")).toHaveLength(4);
    expect(calls.at(-1)).toEqual({ method: "add", name: "white_check_mark" });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("finalize needs only reactions.add and reactions.remove: no auth.test and no reactions.get", async () => {
    const apiCalls: string[] = [];
    const client = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "reactions") {
            return {
              add: async () => {
                apiCalls.push("reactions.add");
                return { ok: true };
              },
              remove: async () => {
                apiCalls.push("reactions.remove");
                return { ok: true };
              },
            };
          }
          apiCalls.push(`client.${String(prop)}`);
          return undefined;
        },
      },
    );
    await finalizeSlackMessageReaction(
      client as never,
      "C_TEST",
      "2000.0006",
      reactionName("completed"),
      "completed",
    );
    expect(apiCalls.filter((call) => call.startsWith("client."))).toEqual([]);
    expect(apiCalls).toEqual([
      "reactions.remove",
      "reactions.remove",
      "reactions.remove",
      "reactions.remove",
      "reactions.add",
    ]);
  });

  test("a generic (non-invalid_name) add failure redacts a secret-shaped error message in the emitted log", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const add = async () => {
      throw new Error(`rate_limited: ${leaked}`);
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0003",
      "swarm_eyes",
      "accepted",
    );
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("a generic (non-invalid_name/no_reaction) remove failure redacts a secret-shaped error message in the emitted log", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const remove = async () => {
      const error = new Error(`rate_limited: ${leaked}`) as Error & { data: unknown };
      error.data = { error: "rate_limited" };
      throw error;
    };
    const add = async () => ({ ok: true });

    await finalizeSlackMessageReaction(
      { reactions: { add, remove } } as never,
      "C_TEST",
      "1000.0004",
      "white_check_mark",
    );
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("an invalid_name add failure redacts a secret-shaped reaction name in the emitted log", async () => {
    const errorSpy = spyOn(console, "error");
    errorSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const add = async () => {
      throw { data: { error: "invalid_name" } };
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0005",
      leaked,
      "accepted",
    );
    const emitted = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });

  test("a fallback add failure after invalid_name redacts a secret-shaped error message in the emitted log", async () => {
    const logSpy = spyOn(console, "log");
    logSpy.mockClear();
    const leaked = "github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef";
    const add = async ({ name }: { name: string }) => {
      if (name === "not_a_real_emoji") throw { data: { error: "invalid_name" } };
      throw new Error(`rate_limited: ${leaked}`);
    };
    await ackSlackMessage(
      { reactions: { add } } as never,
      "C_TEST",
      "1000.0006",
      "not_a_real_emoji",
      "accepted",
    );
    const emitted = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(emitted).toContain("[REDACTED:github_pat]");
    expect(emitted).not.toContain(leaked);
  });
});
