import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import * as contractRuntime from "../extensions/contract-runtime";
import { registerSystemOneDecideTool } from "../tools/system-one-decide";

// Unit tests for templates/extensions/slack-reply-gate/hooks.ts. Decisions go to a
// stubbed `ctx.swarm.systemOne_decide` and Slack calls to a mocked fetch; nothing
// reaches the network. The last block runs the real system-one-decide tool behind it.

// `swarm-extension` is a bare import the extension loader shims to contract-runtime.
mock.module("swarm-extension", () => contractRuntime);

type Handler = (event: any, ctx: any) => Promise<any>;
let handler: Handler;
let mod: any;

// The hook reads credential presence and the Slack token from the API process env.
// Each test sets its own; the runner's values are saved here and restored after the file.
const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "SLACK_BOT_TOKEN",
  ...["ACCEPTED", "BUFFERED", "NOW", "STEERED"].map((k) => `SLACK_REACTION_${k}`),
];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mod = await import("../../templates/extensions/slack-reply-gate/hooks.ts");
  mod.default({
    on: (name: string, h: Handler) => {
      if (name === "pre.task.create") handler = h;
    },
  });
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const realFetch = globalThis.fetch;
let jevCalls: any[] = [];
let slackCalls: Array<{ method: string; body: any; auth: string }> = [];

type SlackReply = (method: string, body: any) => Response | Promise<Response>;
const slackOk = (method: string, body: any): Response => {
  // Default: only the engine's :eyes: is on the message.
  if (method === "reactions.remove" && body.name !== "eyes")
    return Response.json({ ok: false, error: "no_reaction" });
  return Response.json({ ok: true });
};
let slackReply: SlackReply = slackOk;

/** What the MCP bridge returns for a tool call: the tool's structured content in `data`. */
type BridgeResult = { success: boolean; status: number; data: Record<string, unknown> };
const served = (data: Record<string, unknown>): BridgeResult => ({
  success: true,
  status: 200,
  data: { success: true, message: "Decision", ...data },
});
const refused = (message: string): BridgeResult => ({
  success: true,
  status: 200,
  data: { success: false, message },
});

type DecideReply = (args: any) => BridgeResult | Promise<BridgeResult>;
let decideReply: DecideReply = () => refused("no decision stub");

/** Stub `systemOne_decide` with `reply(args)`. Slack calls go to `slackReply` through fetch. */
const mockJev = (reply: DecideReply) => {
  decideReply = reply;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const href = String(url);
    if (href.startsWith("https://slack.com/api/")) {
      const method = href.slice("https://slack.com/api/".length);
      slackCalls.push({ method, body, auth: String(init?.headers?.Authorization ?? "") });
      return slackReply(method, body);
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
};
const jevChoice = (
  choice: string,
  confidence = 0.9,
  probabilities: Record<string, number> | null = { [choice]: confidence, other: 1 - confidence },
) =>
  mockJev(() =>
    served({
      model: "jev-1.13.0",
      answers: {
        reason: {
          type: "choice",
          choice,
          confidence,
          ...(probabilities ? { probabilities } : {}),
        },
      },
    }),
  );

const makeCtx = (
  config: Record<string, unknown> = {},
  opts: {
    key?: string;
    openrouterKey?: string;
    cloudflareToken?: string;
    cloudflareAccount?: string;
    slackToken?: string;
  } = {},
) => {
  const kv: Record<string, unknown> = {};
  const counters: Record<string, number> = {};
  const setEnv = (name: string, value: string) => {
    if (value) process.env[name] = value;
    else delete process.env[name];
  };
  setEnv("TYPESAFE_API_KEY", opts.key ?? "tsk-test");
  setEnv("OPENROUTER_API_KEY", opts.openrouterKey ?? "");
  setEnv("CLOUDFLARE_API_TOKEN", opts.cloudflareToken ?? "");
  setEnv("CLOUDFLARE_ACCOUNT_ID", opts.cloudflareAccount ?? "");
  setEnv("SLACK_BOT_TOKEN", opts.slackToken ?? "xoxb-test");
  const swarm: Record<string, (args: any) => Promise<unknown>> = {
    systemOne_decide: async (args: any) => {
      jevCalls.push({ provider: args.provider, body: args });
      return decideReply(args);
    },
    kv_set: async ({ key, value }: any) => {
      kv[key] = value;
      return { success: true };
    },
    kv_incr: async ({ key }: any) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return { success: true };
    },
  };
  const warns: unknown[] = [];
  return {
    ctx: {
      swarm,
      config,
      state: {},
      log: { debug() {}, info() {}, warn: (...a: unknown[]) => warns.push(a), error() {} },
      signal: new AbortController().signal,
    },
    kv,
    counters,
    warns,
  };
};

const followUp = (
  newMessages: string[],
  context = "<@U1|Alice>: can someone check the deploy?\n[Agent]: On it.",
) =>
  `<thread_context>\n${context}\n</thread_context>\n\n[Thread follow-up — ${newMessages.length} message(s) buffered]\n\n${newMessages.join("\n---\n")}`;

const slackEvent = (newMessages: string[], extra: Record<string, unknown> = {}) => ({
  origin: "slack",
  description: followUp(newMessages),
  options: {
    agentId: "lead-id",
    source: "slack",
    slackChannelId: "C123",
    slackThreadTs: "1700000000.000100",
    slackTriggerMessageTs: "1700000099.000200",
    slackUserId: "U1",
    requestedByUserId: "user-1",
    ...extra,
  },
});

beforeEach(() => {
  jevCalls = [];
  slackCalls = [];
  slackReply = slackOk;
  decideReply = () => refused("no decision stub");
  mod.resetKeyCache();
});
afterEach(async () => {
  await mod.settleMutes();
  globalThis.fetch = realFetch;
});

describe("parseFollowUp", () => {
  test("splits thread context lines and buffered messages", () => {
    const parsed = mod.parseFollowUp(followUp(["lol", "boom!"]));
    expect(parsed.context).toEqual([
      "<@U1|Alice>: can someone check the deploy?",
      "[Agent]: On it.",
    ]);
    expect(parsed.messages).toEqual(["lol", "boom!"]);
  });

  // Regression: an older Lead message quoted the header and `</thread_context>`, so the
  // first-match header regex treated the rest of the context as new messages.
  test("a header or close tag quoted inside the context stays context", () => {
    const quoted =
      "[Agent]: it reads the `</thread_context>` block plus the new message, never their `[Thread follow-up … buffered]` header [2].\n" +
      "[Agent]: also [Thread follow-up — 2 message(s) buffered]\n<@UBOT> (that's you) old ask\n" +
      "<@U2> (unknown user): damn this is nice";
    const parsed = mod.parseFollowUp(followUp(["lol, you did it before us, fml"], quoted));
    expect(parsed.messages).toEqual(["lol, you did it before us, fml"]);
    expect(parsed.context.at(-1)).toBe("<@U2> (unknown user): damn this is nice");
  });

  test("a prefix before the context and a missing context both parse", () => {
    const prefixed = `<sibling_tasks_in_progress>\n- x\n</sibling_tasks_in_progress>\n\n${followUp(["hi"])}`;
    expect(mod.parseFollowUp(prefixed).messages).toEqual(["hi"]);
    const bare = "[Thread follow-up — 1 message(s) buffered]\n\nhi";
    expect(mod.parseFollowUp(bare)).toEqual({ context: [], messages: ["hi"] });
  });

  test("a direct task whose context merely quotes the header is not a follow-up", () => {
    const direct = `<thread_context>\n[Agent]: never their \`[Thread follow-up — 1 message(s) buffered]\` header\n[Thread follow-up — 1 message(s) buffered]\n<@UBOT> (that's you) x\n</thread_context>\n\ncan you add everything until this point in the video also/`;
    expect(mod.parseFollowUp(direct)).toBeNull();
  });
});

describe("mention check ignores thread context", () => {
  const ctxWithMentions =
    "<@U3> (unknown user): Have my bot talk to their <@UBOT> (that's you)\n" +
    "[Agent]: it reads the `</thread_context>` block, never their `[Thread follow-up … buffered]` header.\n" +
    "<@U1|Alice>: <@UBOT> (that's you) can you add everything until this point in the video also/\n" +
    "[Agent]: <@U1|Alice> the video is ready, ping @Lead for v3";

  test("banter in a thread that mentioned Lead before goes to Jev and is muted", async () => {
    jevChoice("reaction_only", 0.93);
    const { ctx, kv } = makeCtx({ mode: "enforce" });
    const ev = slackEvent([]);
    ev.description = followUp(["lol, you did it before us, fml"], ctxWithMentions);
    const result = await handler(ev, ctx);
    await mod.settleMutes();
    expect(result).toEqual({ action: "block", reason: expect.stringContaining("reaction_only") });
    expect(jevCalls).toHaveLength(1);
    expect((kv.last as any).reason).toBe("reaction_only");
    expect(
      slackCalls.some((c: any) => c.method === "reactions.add" && c.body.name === "mute"),
    ).toBe(true);
  });

  test("an unmentioned direct question in the same thread goes to Jev and passes", async () => {
    jevChoice("direct_ask", 0.9);
    const { ctx, kv } = makeCtx({ mode: "enforce" });
    const ev = slackEvent([]);
    ev.description = followUp(["can you also make a 9:16 version?"], ctxWithMentions);
    expect(await handler(ev, ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(1);
    expect((kv.last as any).reason).toBe("direct_ask");
  });

  test("a real mention in the new message still passes without Jev", async () => {
    jevChoice("reaction_only");
    const { ctx, kv } = makeCtx({ mode: "enforce" });
    const ev = slackEvent([]);
    ev.description = followUp(
      ["<@UBOT> (that's you) can you add everything until this point in the video also/"],
      ctxWithMentions,
    );
    expect(await handler(ev, ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
    expect((kv.last as any).reason).toBe("mention");
  });
});

describe("mention passthrough", () => {
  for (const text of [
    "only answer us. @Lead just chat in this thread with the other swarm",
    "<@UBOT> (that's you) what do you think?",
    "hey <@U9|Lead> ship it",
  ]) {
    test(`passes without a Jev call: ${text.slice(0, 40)}`, async () => {
      jevChoice("reaction_only");
      const { ctx, counters, kv } = makeCtx({ mode: "enforce" });
      const result = await handler(slackEvent([text]), ctx);
      expect(result).toBeUndefined();
      expect(jevCalls).toHaveLength(0);
      expect(counters.mention).toBe(1);
      expect((kv.last as any).reason).toBe("mention");
    });
  }

  test("@leadership is not a mention of Lead", () => {
    expect(mod.mentionsLead("ask @leadership about it", ["lead"])).toBe(false);
  });
});

describe("mentionsLead", () => {
  test("matches the rewritten own-bot mention, a resolved alias and a literal alias", () => {
    expect(mod.mentionsLead("<@UBOT> (that's you) what now?", [])).toBe(true);
    expect(mod.mentionsLead("hey <@U9|Lead> ship it", ["lead"])).toBe(true);
    expect(mod.mentionsLead("@LEAD thoughts?", ["lead"])).toBe(true);
    expect(mod.mentionsLead("ping @coordinator", ["lead", "coordinator"])).toBe(true);
  });

  test("ignores plain names, emails, other users and empty aliases", () => {
    expect(mod.mentionsLead("the lead said so", ["lead"])).toBe(false);
    expect(mod.mentionsLead("mail team@lead.dev", ["lead"])).toBe(false);
    expect(mod.mentionsLead("<@U2> can you check?", ["lead"])).toBe(false);
    expect(mod.mentionsLead("@lead", ["", "  "])).toBe(false);
  });
});

describe("decide", () => {
  const verdict = (
    reason: string,
    confidence: number | null,
    probabilities: Record<string, number> | null = null,
  ) => ({ reason, confidence, probabilities, latencyMs: 1 });

  test("a reply label always replies, whatever the skip mass", () => {
    expect(
      mod.decide(verdict("direct_ask", 0.4, { direct_ask: 0.4, reaction_only: 0.6 }), 0.55),
    ).toMatchObject({ reply: true, reason: "direct_ask", lowConfidence: false });
  });

  test("a skip label skips when the summed skip mass reaches minConfidence", () => {
    const d = mod.decide(
      verdict("reaction_only", 0.3, {
        reaction_only: 0.3,
        banter_between_others: 0.25,
        other: 0.45,
      }),
      0.55,
    );
    expect(d.reply).toBe(false);
    expect(d.skipP).toBeCloseTo(0.55);
  });

  test("a skip label below minConfidence replies and is flagged low-confidence", () => {
    expect(
      mod.decide(verdict("not_addressed_to_lead", 0.5, { not_addressed_to_lead: 0.5 }), 0.55),
    ).toMatchObject({ reply: true, lowConfidence: true });
  });

  test("without probabilities the top-label confidence is the skip mass", () => {
    expect(mod.decide(verdict("banter_between_others", 0.7), 0.55)).toMatchObject({
      reply: false,
      skipP: 0.7,
    });
    expect(mod.decide(verdict("banter_between_others", null), 0.55)).toMatchObject({
      reply: false,
      skipP: null,
      lowConfidence: false,
    });
  });
});

describe("provider", () => {
  const cfg = (extra: Record<string, unknown> = {}) => mod.config.parse(extra);
  const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";

  test("auto prefers TypeSafe when every credential is set", () => {
    makeCtx(
      {},
      {
        key: "tsk-test",
        openrouterKey: "or-test",
        cloudflareToken: "cf",
        cloudflareAccount: CF_ACCOUNT,
      },
    );
    expect(mod.resolveProvider(cfg())).toEqual({ provider: "typesafe", model: "jev-latest" });
  });

  test("auto falls back to OpenRouter, then to Clef", () => {
    makeCtx(
      {},
      { key: "", openrouterKey: "or-test", cloudflareToken: "cf", cloudflareAccount: CF_ACCOUNT },
    );
    expect(mod.resolveProvider(cfg())).toEqual({
      provider: "openrouter",
      model: "typesafe/jev-1.13",
    });
    mod.resetKeyCache();
    makeCtx({}, { key: "", cloudflareToken: "cf", cloudflareAccount: CF_ACCOUNT });
    expect(mod.resolveProvider(cfg())).toEqual({ provider: "cloudflare", model: "clef" });
  });

  test("auto accepts CLOUDFLARE_API_KEY and needs the account id", () => {
    makeCtx({}, { key: "", cloudflareAccount: CF_ACCOUNT });
    process.env.CLOUDFLARE_API_KEY = "cf-key";
    expect(mod.resolveProvider(cfg()).provider).toBe("cloudflare");
    mod.resetKeyCache();
    makeCtx({}, { key: "", cloudflareToken: "cf" });
    delete process.env.CLOUDFLARE_API_KEY;
    expect(() => mod.resolveProvider(cfg())).toThrow("CLOUDFLARE_ACCOUNT_ID");
  });

  test("an explicit provider is used as is; the server checks its credential", () => {
    makeCtx({}, { key: "tsk-test", openrouterKey: "or-test" });
    expect(mod.resolveProvider(cfg({ provider: "openrouter" })).provider).toBe("openrouter");
    expect(
      mod.resolveProvider(cfg({ provider: "cloudflare", cloudflareModel: "clef-flash" })),
    ).toEqual({
      provider: "cloudflare",
      model: "clef-flash",
    });
    // A host with no model setting sends none: the server uses the host's default.
    expect(mod.resolveProvider(cfg({ provider: "laya" }))).toEqual({
      provider: "laya",
      model: undefined,
    });
  });

  test("auto with no credential names every secret", () => {
    makeCtx({}, { key: "", openrouterKey: "" });
    expect(() => mod.resolveProvider(cfg())).toThrow(
      "no TYPESAFE_API_KEY, OPENROUTER_API_KEY, or CLOUDFLARE_API_TOKEN with CLOUDFLARE_ACCOUNT_ID",
    );
  });

  test("the decision goes through systemOne_decide, never a direct fetch", async () => {
    jevChoice("reaction_only", 0.95);
    const { ctx, kv } = makeCtx({ mode: "enforce" }, { key: "", openrouterKey: "or-test" });
    const result = await handler(slackEvent(["lol nice"]), ctx);
    expect(result).toEqual({ action: "block", reason: expect.stringContaining("reaction_only") });
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0].body).toMatchObject({
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      timeoutMs: 3000,
      maxRetries: 0,
    });
    expect(Object.keys(jevCalls[0].body.questions.reason.criteria)).toEqual(
      Object.keys(mod.REASONS),
    );
    expect(JSON.stringify(jevCalls[0].body)).not.toContain("or-test");
    expect(kv.last).toMatchObject({ provider: "openrouter", reason: "reaction_only" });
  });

  test("a provider error relayed by the server fails open and names the provider", async () => {
    mockJev(() => refused("OpenRouter returned HTTP 402"));
    const { ctx, kv } = makeCtx({ mode: "enforce" }, { key: "", openrouterKey: "or-test" });
    expect(await handler(slackEvent(["lol"]), ctx)).toBeUndefined();
    expect(kv.last).toMatchObject({
      action: "fail-open",
      error: expect.stringContaining("openrouter: OpenRouter returned HTTP 402"),
    });
  });
});

describe("fail open", () => {
  const cases: Array<[string, () => void, Record<string, unknown>]> = [
    ["provider error", () => mockJev(() => refused("TypeSafe returned HTTP 500")), {}],
    [
      "bridge error",
      () => mockJev(() => ({ success: false, status: 500, data: { error: "boom" } })),
      {},
    ],
    ["network error", () => mockJev(() => Promise.reject(new Error("ECONNRESET"))), {}],
    ["malformed answer", () => mockJev(() => served({ answers: {} })), {}],
    ["unknown label", () => jevChoice("definitely_skip"), {}],
    ["timeout", () => mockJev(() => new Promise<BridgeResult>(() => {})), { timeoutMs: 50 }],
  ];
  for (const [label, arrange, cfg] of cases) {
    test(`${label} -> continue, error recorded`, async () => {
      arrange();
      const { ctx, counters, kv, warns } = makeCtx({ mode: "enforce", ...cfg });
      const result = await handler(slackEvent(["lol"]), ctx);
      expect(result).toBeUndefined();
      expect(jevCalls).toHaveLength(1);
      expect(counters.error).toBe(1);
      expect((kv.last as any).action).toBe("fail-open");
      expect(warns).toHaveLength(1);
    });
  }

  test("missing API key under auto -> continue without a decision call", async () => {
    jevChoice("reaction_only");
    const { ctx, counters } = makeCtx({ mode: "enforce" }, { key: "" });
    const result = await handler(slackEvent(["lol"]), ctx);
    expect(result).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
    expect(counters.error).toBe(1);
  });

  test("a redacted API key counts as missing", async () => {
    jevChoice("reaction_only");
    const { ctx, counters } = makeCtx({ mode: "enforce" }, { key: "[REDACTED:TYPESAFE_API_KEY]" });
    expect(await handler(slackEvent(["lol"]), ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
    expect(counters.error).toBe(1);
  });

  test("a throwing KV store still fails open", async () => {
    jevChoice("reaction_only");
    const { ctx } = makeCtx({ mode: "enforce" });
    ctx.swarm.kv_set = async () => {
      throw new Error("kv down");
    };
    ctx.swarm.kv_incr = async () => {
      throw new Error("kv down");
    };
    const result = await handler(slackEvent(["lol"]), ctx);
    // KV failures are swallowed by allSettled, the decision still applies.
    expect(result).toEqual({ action: "block", reason: expect.stringContaining("reaction_only") });
  });
});

describe("shadow mode", () => {
  test("is the default and never blocks a skip verdict", async () => {
    jevChoice("reaction_only", 0.95);
    const { ctx, counters, kv } = makeCtx({});
    const result = await handler(slackEvent([":joy:"]), ctx);
    expect(result).toBeUndefined();
    expect(jevCalls).toHaveLength(1);
    expect(counters["shadow-skip"]).toBe(1);
    expect(counters["reason:reaction_only"]).toBe(1);
    const last = kv.last as any;
    expect(last).toMatchObject({
      mode: "shadow",
      action: "shadow-skip",
      reply: false,
      reason: "reaction_only",
    });
    expect(
      Object.keys(kv).some((k) => k.startsWith("d:") && k.endsWith("C123_1700000000.000100")),
    ).toBe(true);
  });

  test("records a reply verdict as pass", async () => {
    jevChoice("instruction_to_lead");
    const { ctx, counters } = makeCtx({ mode: "shadow" });
    expect(
      await handler(slackEvent(["can you please create a remotion video of this?"]), ctx),
    ).toBeUndefined();
    expect(counters.reply).toBe(1);
  });
});

describe("enforce mode", () => {
  test("blocks a confident skip verdict", async () => {
    jevChoice("banter_between_others", 0.8);
    const { ctx, counters } = makeCtx({ mode: "enforce" });
    const result = await handler(slackEvent(["yeah, I figured hahaha"]), ctx);
    expect(result).toEqual({
      action: "block",
      reason: expect.stringContaining("banter_between_others"),
    });
    expect(counters.skipped).toBe(1);
  });

  test("a low-confidence skip verdict replies", async () => {
    jevChoice("not_addressed_to_lead", 0.4);
    const { ctx, kv } = makeCtx({ mode: "enforce" });
    expect(await handler(slackEvent(["hmm"]), ctx)).toBeUndefined();
    expect((kv.last as any).lowConfidence).toBe(true);
  });

  test("skip mass split across skip labels still skips", async () => {
    jevChoice("banter_between_others", 0.52, {
      banter_between_others: 0.52,
      reaction_only: 0.4,
      direct_ask: 0.08,
    });
    const { ctx, kv } = makeCtx({ mode: "enforce" });
    const result = await handler(slackEvent(["yeah, I figured hahaha"]), ctx);
    expect(result).toEqual({ action: "block", reason: expect.stringContaining("p(skip) 0.92") });
    expect((kv.last as any).skipP).toBeCloseTo(0.92);
  });

  test("without probabilities the top-label confidence decides", async () => {
    jevChoice("reaction_only", 0.5, null);
    const { ctx } = makeCtx({ mode: "enforce" });
    expect(await handler(slackEvent(["ok"]), ctx)).toBeUndefined();
  });

  for (const reason of ["direct_ask", "followup_to_lead", "instruction_to_lead", "other"]) {
    test(`${reason} passes`, async () => {
      jevChoice(reason, 0.99);
      const { ctx } = makeCtx({ mode: "enforce" });
      expect(await handler(slackEvent(["x"]), ctx)).toBeUndefined();
    });
  }

  test("sends the new message, sender and the last 6 thread messages", async () => {
    jevChoice("reaction_only");
    const { ctx } = makeCtx({ mode: "enforce" });
    const lines = Array.from({ length: 9 }, (_, i) => `<@U${i}|P${i}>: line ${i}`).join("\n");
    await handler({ ...slackEvent(["lol"]), description: followUp(["lol"], lines) }, ctx);
    const state = jevCalls[0].body.state;
    expect(state.new_message).toBe("lol");
    expect(state.new_message_sender).toBe("human (known teammate)");
    expect(state.recent_thread_messages).toHaveLength(6);
    expect(state.recent_thread_messages[0]).toBe("<@U3|P3>: line 3");
    expect(jevCalls[0].body.model).toBe("jev-latest");
    expect(Object.keys(jevCalls[0].body.questions.reason.criteria)).toContain(
      "banter_between_others",
    );
  });

  test("labels configured bot senders", async () => {
    jevChoice("reaction_only");
    const { ctx } = makeCtx({ mode: "enforce", botSlackUserIds: ["U1"] });
    await handler(slackEvent(["lol"]), ctx);
    expect(jevCalls[0].body.state.new_message_sender).toBe("bot");
  });
});

describe("scope", () => {
  test("ignores non-slack origins, non-follow-up slack tasks and mode off", async () => {
    jevChoice("reaction_only");
    const { ctx } = makeCtx({ mode: "enforce" });
    expect(await handler({ ...slackEvent(["lol"]), origin: "mcp" }, ctx)).toBeUndefined();
    expect(
      await handler({ ...slackEvent(["lol"]), description: "please deploy" }, ctx),
    ).toBeUndefined();
    const off = makeCtx({ mode: "off" });
    expect(await handler(slackEvent(["lol"]), off.ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
  });

  test("a follow-up carrying files passes without a Jev call", async () => {
    jevChoice("reaction_only");
    const { ctx, counters } = makeCtx({ mode: "enforce" });
    expect(await handler(slackEvent(["lol"], { status: "draft" }), ctx)).toBeUndefined();
    expect(jevCalls).toHaveLength(0);
    expect(counters.files).toBe(1);
  });
});

describe("mute on drop (enforce)", () => {
  const dropped = async (config: Record<string, unknown> = {}, opts = {}) => {
    jevChoice("reaction_only", 0.95);
    const made = makeCtx({ mode: "enforce", ...config }, opts);
    const result = await handler(slackEvent(["blu blu blu blu"]), made.ctx);
    await mod.settleMutes();
    return { result, ...made };
  };
  const muteRows = (kv: Record<string, unknown>) =>
    Object.entries(kv)
      .filter(([k]) => k.startsWith("m:"))
      .map(([, v]) => v as any);

  test("replaces the engine's :eyes: with :mute: on the trigger message", async () => {
    const { result, counters, kv } = await dropped();
    expect(result).toEqual({ action: "block", reason: expect.stringContaining("reaction_only") });
    const removes = slackCalls.filter((c) => c.method === "reactions.remove");
    expect(removes.map((c) => c.body.name).sort()).toEqual(
      ["eyes", "heavy_plus_sign", "speech_balloon", "zap"].sort(),
    );
    for (const c of slackCalls) {
      expect(c.body.channel).toBe("C123");
      expect(c.body.timestamp).toBe("1700000099.000200");
      expect(c.auth).toBe("Bearer xoxb-test");
    }
    expect(slackCalls.at(-1)).toMatchObject({ method: "reactions.add", body: { name: "mute" } });
    expect(counters.muted).toBe(1);
    expect(muteRows(kv)).toEqual([
      expect.objectContaining({ action: "muted", removed: ["eyes"], added: true, errors: [] }),
    ]);
    // `last` keeps the verdict, not the mute outcome.
    expect((kv.last as any).action).toBe("skipped");
  });

  test("removes configured SLACK_REACTION_* overrides instead of the defaults", async () => {
    process.env.SLACK_REACTION_ACCEPTED = ":Robot_Face:";
    try {
      await dropped();
    } finally {
      delete process.env.SLACK_REACTION_ACCEPTED;
    }
    const removed = slackCalls
      .filter((c) => c.method === "reactions.remove")
      .map((c) => c.body.name);
    expect(removed).toContain("robot_face");
    expect(removed).not.toContain("eyes");
  });

  test("an already-muted message counts as muted", async () => {
    slackReply = (method, body) =>
      method === "reactions.add"
        ? Response.json({ ok: false, error: "already_reacted" })
        : slackOk(method, body);
    const { counters } = await dropped();
    expect(counters.muted).toBe(1);
  });

  const failures: Array<[string, SlackReply]> = [
    [
      "Slack rejects the add",
      (m, b) =>
        m === "reactions.add"
          ? Response.json({ ok: false, error: "missing_scope" })
          : slackOk(m, b),
    ],
    ["Slack HTTP 500", () => new Response("boom", { status: 500 })],
    ["network error", () => Promise.reject(new Error("ECONNRESET"))],
  ];
  for (const [label, reply] of failures) {
    test(`${label}: still dropped, error logged to KV`, async () => {
      slackReply = reply;
      const { result, counters, kv } = await dropped();
      expect(result).toEqual({ action: "block", reason: expect.any(String) });
      expect(counters["mute-error"]).toBe(1);
      expect(counters.muted).toBeUndefined();
      const [row] = muteRows(kv);
      expect(row.action).toBe("mute-error");
      expect(row.errors.length).toBeGreaterThan(0);
    });
  }

  test("missing Slack token: still dropped, no Slack call, error logged", async () => {
    const { result, counters, kv } = await dropped({}, { slackToken: "" });
    expect(result).toEqual({ action: "block", reason: expect.any(String) });
    expect(slackCalls).toHaveLength(0);
    expect(counters["mute-error"]).toBe(1);
    expect(muteRows(kv)[0].errors[0]).toContain("no SLACK_BOT_TOKEN");
  });

  test("the drop does not wait for Slack", async () => {
    const held: Array<() => void> = [];
    slackReply = () =>
      new Promise<Response>((resolve) => {
        held.push(() => resolve(Response.json({ ok: true })));
      });
    jevChoice("reaction_only", 0.95);
    const { ctx, counters } = makeCtx({ mode: "enforce" });
    const result = await handler(slackEvent(["lol"]), ctx);
    expect(result).toEqual({ action: "block", reason: expect.any(String) });
    expect(counters.muted).toBeUndefined();
    // Release the held Slack calls (removes first, then the add).
    for (let i = 0; i < 10 && counters.muted === undefined; i++) {
      for (const r of held.splice(0)) r();
      await new Promise((r) => setTimeout(r, 5));
    }
    await mod.settleMutes();
    expect(counters.muted).toBe(1);
  });

  test('muteReaction "" only removes the acceptance reactions, adds nothing', async () => {
    const { result, counters, kv } = await dropped({ muteReaction: "" });
    expect(result).toEqual({ action: "block", reason: expect.any(String) });
    expect(slackCalls.some((c) => c.method === "reactions.add")).toBe(false);
    expect(
      slackCalls
        .filter((c) => c.method === "reactions.remove")
        .map((c) => c.body.name)
        .sort(),
    ).toEqual(["eyes", "heavy_plus_sign", "speech_balloon", "zap"].sort());
    expect(counters.unreacted).toBe(1);
    expect(counters.muted).toBeUndefined();
    expect(muteRows(kv)).toEqual([
      expect.objectContaining({ action: "unreacted", removed: ["eyes"], added: false, errors: [] }),
    ]);
  });

  test('muteReaction "": a failed removal is logged as mute-error', async () => {
    slackReply = (m, b) =>
      m === "reactions.remove" && b.name === "eyes"
        ? Response.json({ ok: false, error: "missing_scope" })
        : slackOk(m, b);
    const { result, counters, kv } = await dropped({ muteReaction: "" });
    expect(result).toEqual({ action: "block", reason: expect.any(String) });
    expect(counters["mute-error"]).toBe(1);
    expect(counters.unreacted).toBeUndefined();
    expect(muteRows(kv)[0].errors).toEqual(["remove eyes: missing_scope"]);
  });

  test("a custom muteReaction is added after the removals", async () => {
    const { counters } = await dropped({ muteReaction: ":zipper_mouth_face:" });
    expect(slackCalls.at(-1)).toMatchObject({
      method: "reactions.add",
      body: { name: "zipper_mouth_face" },
    });
    expect(slackCalls.filter((c) => c.method === "reactions.add")).toHaveLength(1);
    expect(counters.muted).toBe(1);
  });

  test("no reaction for shadow skips, replies, mentions or fail-open", async () => {
    jevChoice("reaction_only", 0.95);
    await handler(slackEvent(["lol"]), makeCtx({ mode: "shadow" }).ctx);
    jevChoice("direct_ask", 0.95);
    await handler(slackEvent(["can you check?"]), makeCtx({ mode: "enforce" }).ctx);
    await handler(slackEvent(["@lead lol"]), makeCtx({ mode: "enforce" }).ctx);
    mockJev(() => new Response("boom", { status: 500 }));
    await handler(slackEvent(["lol"]), makeCtx({ mode: "enforce" }).ctx);
    await mod.settleMutes();
    expect(slackCalls).toHaveLength(0);
  });
});

describe("on the real system-one-decide tool", () => {
  const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
  const CF_TOKEN = "cf-reply-gate-example-token";
  const CLEF_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/cloudflare/clef`;
  let agentId: string;
  let workersAi: Array<{ url: string; authorization: string | null; body: any }> = [];

  beforeAll(async () => {
    initDb(":memory:");
    agentId = (await createAgent({ name: "reply-gate-ext", isLead: false, status: "idle" })).id;
    await upsertSwarmConfig({ scope: "global", key: "CLOUDFLARE_ACCOUNT_ID", value: CF_ACCOUNT });
  });
  afterAll(() => closeDb());

  /** `ctx.swarm.systemOne_decide` as the MCP bridge serves it, backed by the registered tool. */
  const viaTool = (ctx: any) => {
    const server = new McpServer({ name: "reply-gate-decide", version: "1" });
    registerSystemOneDecideTool(server);
    const tool = (server as any)._registeredTools["system-one-decide"];
    ctx.swarm.systemOne_decide = async (args: any) => {
      jevCalls.push({ provider: args.provider, body: args });
      const result = await tool.handler(args, {
        sessionId: "extension",
        requestInfo: { headers: { "x-agent-id": agentId } },
      });
      return { success: true, status: 200, data: result.structuredContent };
    };
  };

  /** Workers AI answering in its REST envelope; Slack calls go to `slackReply`. */
  const mockWorkersAi = (choice: string, p: number) => {
    workersAi = [];
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.startsWith("https://slack.com/api/")) {
        const method = url.slice("https://slack.com/api/".length);
        slackCalls.push({ method, body, auth: String(init?.headers?.authorization ?? "") });
        return slackReply(method, body);
      }
      workersAi.push({ url, authorization: new Headers(init?.headers).get("authorization"), body });
      const labels = Object.keys(mod.REASONS);
      const rest = (1 - p) / (labels.length - 1);
      const probabilities = Object.fromEntries(labels.map((l) => [l, l === choice ? p : rest]));
      return Response.json({
        result: {
          model: "clef",
          answers: { reason: { type: "choice", choice, probabilities, confidence: p } },
          usage: { input_tokens: 412, output_tokens: 0 },
        },
        success: true,
        errors: [],
        messages: [],
      });
    }) as typeof fetch;
  };

  test("Clef classifies on the server; the hook never holds the token", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_TOKEN",
      value: CF_TOKEN,
      isSecret: true,
    });
    mockWorkersAi("reaction_only", 0.9);
    const { ctx, kv } = makeCtx(
      { mode: "enforce" },
      { key: "", cloudflareToken: "present", cloudflareAccount: CF_ACCOUNT },
    );
    viaTool(ctx);

    const result = await handler(slackEvent(["lol nice"]), ctx);
    expect(result).toEqual({ action: "block", reason: expect.stringContaining("reaction_only") });
    expect(workersAi).toHaveLength(1);
    expect(workersAi[0]).toMatchObject({ url: CLEF_URL, authorization: `Bearer ${CF_TOKEN}` });
    expect(workersAi[0]!.body.model).toBe("clef");
    expect(kv.last).toMatchObject({
      provider: "cloudflare",
      reason: "reaction_only",
      action: "skipped",
    });
    expect(JSON.stringify(kv)).not.toContain(CF_TOKEN);
  });

  test("auto skips OpenRouter behind a gateway, which the server refuses, and reaches Clef", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_TOKEN",
      value: CF_TOKEN,
      isSecret: true,
    });
    const prevBase = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = "https://llm-gateway.example.com/v1";
    try {
      mockWorkersAi("reaction_only", 0.9);
      const { ctx, kv } = makeCtx(
        { mode: "enforce" },
        {
          key: "",
          openrouterKey: "or-gateway-token",
          cloudflareToken: "present",
          cloudflareAccount: CF_ACCOUNT,
        },
      );
      viaTool(ctx);

      const result = await handler(slackEvent(["lol nice"]), ctx);
      expect(result).toEqual({ action: "block", reason: expect.stringContaining("reaction_only") });
      expect(jevCalls.map((c) => c.provider)).toEqual(["openrouter", "cloudflare"]);
      expect(workersAi).toHaveLength(1);
      expect(workersAi[0]!.url).toBe(CLEF_URL);
      expect(kv.last).toMatchObject({ provider: "cloudflare", action: "skipped" });
    } finally {
      if (prevBase === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = prevBase;
    }
  });

  test("a token missing on the server fails open, as before", async () => {
    await getDbClient().run("DELETE FROM swarm_config WHERE key = 'CLOUDFLARE_API_TOKEN'");
    mockWorkersAi("reaction_only", 0.9);
    const { ctx, kv, counters } = makeCtx({ mode: "enforce", provider: "cloudflare" }, { key: "" });
    viaTool(ctx);

    expect(await handler(slackEvent(["lol"]), ctx)).toBeUndefined();
    expect(workersAi).toHaveLength(0);
    expect(counters.error).toBe(1);
    expect(kv.last).toMatchObject({
      action: "fail-open",
      error: expect.stringContaining("CLOUDFLARE_API_TOKEN is not configured"),
    });
  });
});
