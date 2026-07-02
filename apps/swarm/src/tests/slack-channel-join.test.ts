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

type ChannelShape = {
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
};

function makeClient(opts: {
  channel?: ChannelShape;
  infoResult?: () => unknown;
  joinResult?: () => unknown;
}): {
  client: WebClient;
  infoFn: ReturnType<typeof mock>;
  joinFn: ReturnType<typeof mock>;
} {
  const infoFn = mock(
    opts.infoResult
      ? opts.infoResult
      : () => Promise.resolve({ channel: opts.channel ?? { is_ext_shared: false } }),
  );
  const joinFn = mock(opts.joinResult ? opts.joinResult : () => Promise.resolve({}));
  const client = {
    conversations: { info: infoFn, join: joinFn },
  } as unknown as WebClient;
  return { client, infoFn, joinFn };
}

describe("withAutoJoin", () => {
  test("success: fn called once, join and info not called", async () => {
    const { client, infoFn, joinFn } = makeClient({});
    const fn = mock(() => Promise.resolve("ok"));

    const result = await withAutoJoin(client, "C123", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(infoFn).not.toHaveBeenCalled();
    expect(joinFn).not.toHaveBeenCalled();
  });

  test("not_in_channel on internal channel: fetches info, calls join, retries fn exactly once", async () => {
    const { client, infoFn, joinFn } = makeClient({
      channel: { is_ext_shared: false },
    });
    let callCount = 0;
    const fn = mock(async () => {
      callCount++;
      if (callCount === 1) throw makePlatformError("not_in_channel");
      return "retried-ok";
    });

    const result = await withAutoJoin(client, "CPUB", fn);
    expect(result).toBe("retried-ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(infoFn).toHaveBeenCalledTimes(1);
    expect(infoFn).toHaveBeenCalledWith({ channel: "CPUB" });
    expect(joinFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledWith({ channel: "CPUB" });
  });

  test("info failure falls back to join and retries fn", async () => {
    const { client, infoFn, joinFn } = makeClient({
      infoResult: () => {
        throw makePlatformError("channel_not_found");
      },
    });
    let callCount = 0;
    const fn = mock(async () => {
      callCount++;
      if (callCount === 1) throw makePlatformError("not_in_channel");
      return "retried-ok";
    });

    const result = await withAutoJoin(client, "CPUB", fn);
    expect(result).toBe("retried-ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(infoFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledWith({ channel: "CPUB" });
  });

  test("private channel: info returns internal, join fails with method_not_supported → descriptive error", async () => {
    const { client, infoFn, joinFn } = makeClient({
      channel: { is_ext_shared: false },
      joinResult: () => {
        throw makePlatformError("method_not_supported_for_channel_type");
      },
    });
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "CPRIV", fn)).rejects.toThrow("invite the bot");
    expect(infoFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("info failure preserves private-channel invite error from join", async () => {
    const { client, infoFn, joinFn } = makeClient({
      infoResult: () => {
        throw makePlatformError("not_in_channel");
      },
      joinResult: () => {
        throw makePlatformError("method_not_supported_for_channel_type");
      },
    });
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "CPRIV", fn)).rejects.toThrow("invite the bot");
    expect(infoFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("non-not_in_channel error: rethrown without info or join", async () => {
    const { client, infoFn, joinFn } = makeClient({});
    const fn = mock(() => {
      throw makePlatformError("channel_not_found");
    });

    await expect(withAutoJoin(client, "C123", fn)).rejects.toThrow("channel_not_found");
    expect(infoFn).not.toHaveBeenCalled();
    expect(joinFn).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retry is bounded: second fn error propagates without another join", async () => {
    const { client, infoFn, joinFn } = makeClient({
      channel: { is_ext_shared: false },
    });
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "C123", fn)).rejects.toThrow("not_in_channel");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(infoFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledTimes(1); // no infinite loop
  });

  // --- External channel guard tests ---

  test("external guard: is_ext_shared=true → throws invite error, join not called", async () => {
    const { client, joinFn } = makeClient({
      channel: { is_ext_shared: true },
    });
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "CEXT", fn)).rejects.toThrow("invite the bot");
    expect(joinFn).not.toHaveBeenCalled();
  });

  test("external guard: is_pending_ext_shared=true → throws invite error, join not called", async () => {
    const { client, joinFn } = makeClient({
      channel: { is_ext_shared: false, is_pending_ext_shared: true },
    });
    const fn = mock(() => {
      throw makePlatformError("not_in_channel");
    });

    await expect(withAutoJoin(client, "CPENDING", fn)).rejects.toThrow("invite the bot");
    expect(joinFn).not.toHaveBeenCalled();
  });

  test("external guard: internal public channel (is_ext_shared:false) → join proceeds", async () => {
    const { client, joinFn } = makeClient({
      channel: { is_ext_shared: false },
    });
    let callCount = 0;
    const fn = mock(async () => {
      callCount++;
      if (callCount === 1) throw makePlatformError("not_in_channel");
      return "joined-ok";
    });

    const result = await withAutoJoin(client, "CPUB", fn);
    expect(result).toBe("joined-ok");
    expect(joinFn).toHaveBeenCalledTimes(1);
  });

  test("external guard: Enterprise Grid org-shared channel (is_ext_shared:false, multiple teams) → join proceeds, no false-positive", async () => {
    // An internal org-shared channel on Enterprise Grid legitimately lists multiple
    // internal team IDs. The guard must rely solely on is_ext_shared/is_pending_ext_shared
    // — not team-ID comparison — to avoid false-positives here.
    const { client, joinFn } = makeClient({
      channel: { is_ext_shared: false },
    });
    let callCount = 0;
    const fn = mock(async () => {
      callCount++;
      if (callCount === 1) throw makePlatformError("not_in_channel");
      return "joined-ok";
    });

    const result = await withAutoJoin(client, "CGRID", fn);
    expect(result).toBe("joined-ok");
    expect(joinFn).toHaveBeenCalledTimes(1);
  });
});
