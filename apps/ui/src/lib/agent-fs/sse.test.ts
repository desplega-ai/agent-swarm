import { describe, expect, test } from "bun:test";
import { createSseParser, SSE_MAX_PENDING, type SseMessage, SseOverflowError } from "./sse";

const encoder = new TextEncoder();

/** Every message the parser dispatches for these chunks. */
function parse(chunks: Uint8Array[]): SseMessage[] {
  const messages: SseMessage[] = [];
  const parser = createSseParser((message) => messages.push(message));
  for (const chunk of chunks) parser.push(chunk);
  return messages;
}

const SAMPLE = [
  ": ping",
  "",
  "event: ready",
  'data: {"driveId":"d1","at":"2026-09-30T10:00:00.000Z"}',
  "",
  ": ping",
  "",
  "event: file.changed",
  'data: {"path":"/notes/é.md"}',
  "",
  "data: line one",
  "data:line two",
  "data",
  "",
  "id: 7",
  "event: comment.changed",
  'data: {"commentId":"c1"}',
  "",
  "event: comment.changed",
  "retry: 100",
  "unknown: field",
  'data: {"commentId":"c2"}',
  "",
  "event: ready",
  "",
  "event: partial",
  "data: never dispatched",
].join("\n");

const EXPECTED: SseMessage[] = [
  { event: "ready", data: '{"driveId":"d1","at":"2026-09-30T10:00:00.000Z"}', id: undefined },
  { event: "file.changed", data: '{"path":"/notes/é.md"}', id: undefined },
  { event: "message", data: "line one\nline two\n", id: undefined },
  { event: "comment.changed", data: '{"commentId":"c1"}', id: "7" },
  { event: "comment.changed", data: '{"commentId":"c2"}', id: "7" },
];

describe("createSseParser", () => {
  test("dispatches on a blank line, joins data lines, and skips pings and empty events", () => {
    expect(parse([encoder.encode(SAMPLE)])).toEqual(EXPECTED);
  });

  test("gives the same events for a split at every byte offset", () => {
    const bytes = encoder.encode(SAMPLE);
    for (let offset = 0; offset <= bytes.length; offset++) {
      const chunks = [bytes.slice(0, offset), bytes.slice(offset)];
      expect(parse(chunks)).toEqual(EXPECTED);
    }
  });

  test("gives the same events fed one byte at a time", () => {
    const bytes = encoder.encode(SAMPLE);
    const chunks = Array.from(bytes, (_, index) => bytes.slice(index, index + 1));
    expect(parse(chunks)).toEqual(EXPECTED);
  });

  test("accepts CRLF and CR line ends, also when a chunk splits the CRLF", () => {
    for (const lineEnd of ["\r\n", "\r"]) {
      const bytes = encoder.encode(`${SAMPLE.split("\n").join(lineEnd)}${lineEnd}${lineEnd}ping`);
      const expected = [...EXPECTED, { event: "partial", data: "never dispatched", id: "7" }];
      for (let offset = 0; offset <= bytes.length; offset++) {
        expect(parse([bytes.slice(0, offset), bytes.slice(offset)])).toEqual(expected);
      }
    }
  });

  test("dispatches nothing for a stream of pings", () => {
    expect(parse([encoder.encode(": ping\n\n: ping\n\n:\n\n")])).toEqual([]);
  });

  test("keeps a trailing partial event until its blank line arrives", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((message) => messages.push(message));
    parser.push(encoder.encode("event: file.changed\ndata: {}\n"));
    expect(messages).toEqual([]);
    parser.push(encoder.encode("\n"));
    expect(messages).toEqual([{ event: "file.changed", data: "{}", id: undefined }]);
  });

  test("a CR at the end of a chunk ends its line at once", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((message) => messages.push(message));
    // No later chunk: the event must not wait for the next ping.
    parser.push(encoder.encode("event: file.changed\rdata: {}\r\r"));
    expect(messages).toEqual([{ event: "file.changed", data: "{}", id: undefined }]);
  });

  test("a LF that starts the next chunk completes the CRLF, not a blank line", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((message) => messages.push(message));
    parser.push(encoder.encode("data: one\r"));
    // An empty chunk (a split multi-byte character, say) keeps the CR pending.
    parser.push(new Uint8Array());
    parser.push(encoder.encode("\ndata: two\r"));
    expect(messages).toEqual([]);
    parser.push(encoder.encode("\n\r"));
    expect(messages).toEqual([{ event: "message", data: "one\ntwo", id: undefined }]);
    // The LF after that last CR is skipped too: it adds no blank line.
    parser.push(encoder.encode("\ndata: three\n\n"));
    expect(messages).toEqual([
      { event: "message", data: "one\ntwo", id: undefined },
      { event: "message", data: "three", id: undefined },
    ]);
  });

  test("reads a long line in small chunks in linear time", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((message) => messages.push(message));
    const value = "x".repeat(1_000_000);
    const bytes = encoder.encode(`data: ${value}`);
    // A parser that scans the whole unfinished line on every chunk takes
    // many seconds here.
    for (let offset = 0; offset < bytes.length; offset += 64) {
      parser.push(bytes.slice(offset, offset + 64));
    }
    parser.push(encoder.encode("\n\n"));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data.length).toBe(value.length);
  }, 2000);

  test("throws when an unfinished line passes the limit", () => {
    const parser = createSseParser(() => {});
    parser.push(encoder.encode(`data: ${"x".repeat(SSE_MAX_PENDING - 10)}`));
    expect(() => parser.push(encoder.encode("x".repeat(10)))).toThrow(SseOverflowError);
  });

  test("throws when the data lines of one event pass the limit", () => {
    const parser = createSseParser(() => {});
    const line = `data: ${"x".repeat(1000)}\n`;
    const lines = Math.floor(SSE_MAX_PENDING / 1000);
    expect(() => parser.push(encoder.encode(line.repeat(lines - 1)))).not.toThrow();
    expect(() => parser.push(encoder.encode(line.repeat(2)))).toThrow(SseOverflowError);
  });

  test("the limit applies to one event, not to the whole stream", () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((message) => messages.push(message));
    const event = `data: ${"x".repeat(SSE_MAX_PENDING / 2)}\n\n`;
    for (let i = 0; i < 4; i++) parser.push(encoder.encode(event));
    expect(messages).toHaveLength(4);
  });
});
