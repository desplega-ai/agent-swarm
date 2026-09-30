// Incremental Server-Sent Events parser for a fetch body. Comb reads the
// agent-fs change stream with `fetch`, because `EventSource` cannot send the
// Bearer key.
//
// It follows the WHATWG event-stream rules that agent-fs can produce: lines
// end with CRLF, LF, or CR (also split across chunks), a line that starts
// with ":" is a comment (the `: ping` heartbeat), `data:` lines join with
// "\n", and a blank line dispatches the event. An event with no data is not
// dispatched. The last event of a stream that ends without a blank line is
// dropped. `retry:` and unknown fields are ignored.

/** One dispatched event. `event` is "message" when the stream names none. */
export interface SseMessage {
  event: string;
  data: string;
  /** The last event id the stream sent, if any (it carries over to later events). */
  id?: string;
}

export interface SseParser {
  /**
   * Feed the next chunk of the body. Complete events go to `onMessage` in
   * order. Throws `SseOverflowError` when the event being read grows past
   * `SSE_MAX_PENDING`: the caller must close the connection.
   */
  push(chunk: Uint8Array): void;
}

/** The largest event the parser holds (its data lines plus the unfinished line), in characters. */
export const SSE_MAX_PENDING = 1024 * 1024;

export class SseOverflowError extends Error {
  constructor() {
    super(`An event-stream event is larger than ${SSE_MAX_PENDING} characters`);
    this.name = "SseOverflowError";
  }
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  // Stream mode keeps a multi-byte character that a chunk splits.
  const decoder = new TextDecoder();
  // The pieces of the unfinished line. None holds a line end, so a push
  // scans only its own chunk, and a long line is joined once.
  let line: string[] = [];
  let lineSize = 0;
  // The last chunk ended with a CR, which ended its line at once. A LF at
  // the start of the next chunk is the second half of that CRLF.
  let skipLf = false;
  let event = "";
  let data: string[] = [];
  let dataSize = 0;
  let lastId: string | undefined;

  function processLine(line: string) {
    if (line === "") {
      if (data.length > 0) {
        onMessage({ event: event || "message", data: data.join("\n"), id: lastId });
      }
      event = "";
      data = [];
      dataSize = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      dataSize += value.length;
    } else if (field === "id" && !value.includes("\0")) lastId = value;
  }

  return {
    push(chunk) {
      let text = decoder.decode(chunk, { stream: true });
      if (skipLf && text.length > 0) {
        if (text[0] === "\n") text = text.slice(1);
        skipLf = false;
      }
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char !== "\n" && char !== "\r") continue;
        line.push(text.slice(start, i));
        processLine(line.join(""));
        line = [];
        lineSize = 0;
        if (char === "\r") {
          if (i === text.length - 1) skipLf = true;
          else if (text[i + 1] === "\n") i++;
        }
        start = i + 1;
      }
      if (start < text.length) {
        line.push(text.slice(start));
        lineSize += text.length - start;
      }
      if (lineSize + dataSize > SSE_MAX_PENDING) throw new SseOverflowError();
    },
  };
}
