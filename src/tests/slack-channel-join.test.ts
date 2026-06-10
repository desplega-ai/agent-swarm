import { describe, expect, mock, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { withAutoJoin } from "../slack/channel-join";

// Mirrors the shape @slack/web-api's platformErrorFromResult produces:
// message = "An API error occurred: <code>", data.error = "<code>"
function makePlatformError(code: string): Error {
  const err = new Error(`An API error occurred: ${code}`);
  (err as unknown as { data: { error: string } }).data = { error: code };
  return err;
}

describe("withAutoJoin", () => {
  test("success: fn called once, join not called", async () => {
    const joinFn = mock(() => Promise.resolve({}));
    const client = { conversations: { join: joinFn } } as unknown as WebClient;
    const fn = mock(() => Promise.resolve("ok"));

    const result = await withAutoJoin(client, "C123", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(joinFn).not.toHaveBeenCalled();
  });

  test("not_in_channel: calls join then retries fn exactly once", async () => {
    const joinFn = mock(() => Promise.resolve({}));
    const client = { conversations: { join: joinFn } } as unknown as WebClient;
    let callCount = 0;
    const fn = mock(async () => {
      callCount++;
      if (callCount === 1) throw makePlatformError("not_in_channel");
      return "retried-ok";
    });

    const result = await withAutoJoin(client, "CPUB", fn);
    expect(result).toBe("retried-ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(joinFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledWith({ channel: "CPUB" });
  });

  test("private channel: join fails with method_not_supported_for_channel_type → descriptive error", async () => {
    const joinFn = mock(() => {
      throw makePlatformError("method_not_supported_for_channel_type");
    });
    const client = { conversations: { join: joinFn } } as unknown as WebClient;
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "CPRIV", fn)).rejects.toThrow("invite the bot");
    expect(joinFn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("non-not_in_channel error: rethrown without join", async () => {
    const joinFn = mock(() => Promise.resolve({}));
    const client = { conversations: { join: joinFn } } as unknown as WebClient;
    const fn = mock(() => {
      throw makePlatformError("channel_not_found");
    });

    await expect(withAutoJoin(client, "C123", fn)).rejects.toThrow("channel_not_found");
    expect(joinFn).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retry is bounded: second fn error propagates without another join", async () => {
    const joinFn = mock(() => Promise.resolve({}));
    const client = { conversations: { join: joinFn } } as unknown as WebClient;
    // Every call throws not_in_channel, but we only join once and retry once
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "C123", fn)).rejects.toThrow("not_in_channel");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(joinFn).toHaveBeenCalledTimes(1); // no infinite loop
  });
});
