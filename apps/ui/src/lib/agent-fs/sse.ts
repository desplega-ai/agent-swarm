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
  /** Feed the next chunk of the body. Complete events go to `onMessage` in order. */
  push(chunk: Uint8Array): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  // Stream mode keeps a multi-byte character that a chunk splits.
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let lastId: string | undefined;

  function processLine(line: string) {
    if (line === "") {
      if (data.length > 0) {
        onMessage({ event: event || "message", data: data.join("\n"), id: lastId });
      }
      event = "";
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) lastId = value;
  }

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        if (char !== "\n" && char !== "\r") continue;
        // A CR at the end of the buffer can be the first half of a CRLF.
        if (char === "\r" && i === buffer.length - 1) break;
        processLine(buffer.slice(start, i));
        if (char === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}
