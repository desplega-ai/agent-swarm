import { describe, expect, test } from "bun:test";
import { createSseParser, type SseMessage } from "./sse";

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
});
