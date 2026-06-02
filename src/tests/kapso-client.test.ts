import { afterEach, describe, expect, test } from "bun:test";
import {
  markKapsoMessageRead,
  sendKapsoReaction,
  sendKapsoText,
} from "../integrations/kapso/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("sendKapsoText", () => {
  test("success → returns outbound wamid", async () => {
    let captured: { url: string; body: unknown } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT123" }] }), { status: 200 });
    }) as typeof fetch;

    const result = await sendKapsoText({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "k",
      phoneNumberId: "1035039933036854",
      to: "34679077777",
      body: "hola",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("wamid.OUT123");
    expect(captured!.url).toBe(
      "https://api.kapso.ai/meta/whatsapp/v24.0/1035039933036854/messages",
    );
    expect(captured!.body).toMatchObject({
      messaging_product: "whatsapp",
      to: "34679077777",
      type: "text",
      text: { body: "hola", preview_url: false },
    });
  });

  test("quote-reply sets context.message_id", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.R" }] }), { status: 200 });
    }) as typeof fetch;

    await sendKapsoText({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "k",
      phoneNumberId: "p",
      to: "34679077777",
      body: "re",
      contextMessageId: "wamid.IN999",
    });

    expect(body!.context).toEqual({ message_id: "wamid.IN999" });
  });

  test("24h-window error (code 131047) → sessionWindowExpired", async () => {
    mockFetch(400, {
      error: { code: 131047, message: "Message failed: more than 24 hours since last reply" },
    });
    const result = await sendKapsoText({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "k",
      phoneNumberId: "p",
      to: "34679077777",
      body: "late",
    });
    expect(result.ok).toBe(false);
    expect(result.sessionWindowExpired).toBe(true);
  });

  test("generic error → not flagged as session-window", async () => {
    mockFetch(401, { error: { code: 0, message: "Invalid API key" } });
    const result = await sendKapsoText({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "bad",
      phoneNumberId: "p",
      to: "34679077777",
      body: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.sessionWindowExpired).toBe(false);
    expect(result.errorMessage).toContain("Invalid API key");
  });
});

describe("Kapso message actions", () => {
  test("markKapsoMessageRead can include the typing indicator", async () => {
    let captured: { url: string; body: unknown } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const result = await markKapsoMessageRead({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "k",
      phoneNumberId: "p",
      messageId: "wamid.IN",
      typingIndicatorType: "text",
    });

    expect(result.ok).toBe(true);
    expect(captured!.url).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/p/messages");
    expect(captured!.body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.IN",
      typing_indicator: { type: "text" },
    });
  });

  test("sendKapsoReaction posts the eyes reaction payload", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.REACT" }] }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await sendKapsoReaction({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "k",
      phoneNumberId: "p",
      to: "34679077777",
      messageId: "wamid.IN",
      emoji: "👀",
    });

    expect(result.ok).toBe(true);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "34679077777",
      type: "reaction",
      reaction: { message_id: "wamid.IN", emoji: "👀" },
    });
  });

  test("message action errors return structured failures", async () => {
    mockFetch(400, { error: { message: "bad message id" } });

    const result = await markKapsoMessageRead({
      apiBaseUrl: "https://api.kapso.ai",
      apiKey: "k",
      phoneNumberId: "p",
      messageId: "wamid.BAD",
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("bad message id");
  });
});
