import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { App } from "@slack/bolt";
import { createAssistant } from "../slack/assistant";
import * as eventDedup from "../slack/event-dedup";
import { registerMessageHandler } from "../slack/handlers";

type Listener = (args: Record<string, unknown>) => Promise<unknown>;

afterEach(() => mock.restore());

for (const listener of [
  "threadStarted",
  "threadContextChanged",
  "userMessage",
  "message",
] as const) {
  test(`${listener} retry log identifies the message without user content`, async () => {
    const output = spyOn(console, "log").mockImplementation(() => {});
    spyOn(eventDedup, "wasEventSeen").mockReturnValue(true);
    let handler: Listener;
    if (listener === "message") {
      registerMessageHandler({
        event: (name: string, callback: Listener) => {
          if (name === "message") handler = callback;
        },
      } as unknown as App);
    } else {
      handler = (createAssistant() as unknown as Record<string, Listener[]>)[listener][0];
    }
    const message = {
      channel: "D_LOG_TEST",
      ts: "1730000001.000002",
      thread_ts: "1730000000.000001",
      text: "PRIVATE MESSAGE TEXT",
      files: [{ name: "PRIVATE FILE NAME" }],
    };
    const args = {
      body: { event_id: "Ev_LOG_TEST", retry_attempt: 99, retry_reason: "wrong location" },
      context: { retryNum: 0, retryReason: "timeout" },
      message,
      event: {
        ...message,
        event_ts: message.ts,
        assistant_thread: { channel_id: message.channel, thread_ts: message.thread_ts },
      },
    };
    await handler!(args);
    const drop = `[Slack] dropping Slack retry: event_id=Ev_LOG_TEST channel=D_LOG_TEST ts=${message.ts} thread_ts=${message.thread_ts} retry_num=0 retry_reason=timeout`;
    expect(output.mock.calls.map(([line]) => line)).toEqual(
      listener === "userMessage"
        ? [
            `[Slack] assistant message channel=D_LOG_TEST ts=${message.ts} thread=${message.thread_ts} event_id=Ev_LOG_TEST`,
            drop,
          ]
        : [drop],
    );

    output.mockClear();
    await handler!({ ...args, context: {} });
    expect(output.mock.calls.at(-1)?.[0]).toBe(
      drop.replace("retry_num=0 retry_reason=timeout", "retry_num=unknown retry_reason=unknown"),
    );
  });
}
