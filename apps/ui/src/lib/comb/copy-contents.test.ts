import { describe, expect, test } from "bun:test";
import {
  CANT_COPY_TYPE,
  type ClipboardEnv,
  COPY_CONTENTS_MAX_BYTES,
  CopyRejected,
  copyCheck,
  loadTextToCopy,
  TOO_LARGE_TO_COPY,
  textToCopy,
  writeTextWhenReady,
} from "./copy-contents";

const SMALL = 2_000;

describe("copyCheck", () => {
  test("the cap is 1 MiB", () => {
    expect(COPY_CONTENTS_MAX_BYTES).toBe(1024 * 1024);
  });

  test("text-like files copy", () => {
    for (const [path, contentType] of [
      ["/notes.md", "text/markdown"],
      ["/data.csv", "text/csv"],
      ["/src/app.ts", "application/octet-stream"],
      ["/config.yaml", undefined],
      ["/logo.svg", "image/svg+xml"],
      ["/report.json", "application/json"],
      // An unknown extension that agent-fs reports as text.
      ["/notes.weird", "text/plain"],
      ["/feed.unknown", "application/atom+xml"],
      ["/compose.conf2", "application/yaml"],
      // No extension and the generic type: the text viewer sniffs it.
      ["/README", "application/octet-stream"],
    ] as const) {
      expect(copyCheck(path, { size: SMALL, contentType })).toEqual({ copyable: true });
    }
  });

  test("other types do not copy, whatever the size", () => {
    for (const [path, contentType] of [
      ["/photo.png", "image/png"],
      ["/clip.mp4", "video/mp4"],
      ["/song.mp3", "audio/mpeg"],
      ["/report.pdf", "application/pdf"],
      ["/archive.zip", "application/zip"],
      ["/sheet.xlsx", "application/octet-stream"],
      ["/blob.bin", "text/plain"],
    ] as const) {
      expect(copyCheck(path, { size: SMALL, contentType })).toEqual({
        copyable: false,
        reason: CANT_COPY_TYPE,
      });
    }
  });

  test("text above 1 MiB is too large; exactly 1 MiB copies", () => {
    expect(copyCheck("/big.log", { size: COPY_CONTENTS_MAX_BYTES })).toEqual({ copyable: true });
    expect(copyCheck("/big.log", { size: COPY_CONTENTS_MAX_BYTES + 1 })).toEqual({
      copyable: false,
      reason: TOO_LARGE_TO_COPY,
    });
  });

  test("an unknown binary-typed file copies only while the viewer would sniff it", () => {
    const type = "application/octet-stream";
    expect(copyCheck("/LICENSE", { size: SMALL, contentType: type })).toEqual({ copyable: true });
    expect(copyCheck("/LICENSE", { size: 300 * 1024, contentType: type })).toEqual({
      copyable: false,
      reason: CANT_COPY_TYPE,
    });
  });

  test("a large unknown-type file names the type, not the size", () => {
    expect(copyCheck("/photo.png", { size: COPY_CONTENTS_MAX_BYTES * 5 })).toEqual({
      copyable: false,
      reason: CANT_COPY_TYPE,
    });
  });
});

describe("textToCopy", () => {
  test("passes text and rejects binary bytes", () => {
    expect(textToCopy("hello")).toBe("hello");
    expect(() => textToCopy("PK\u0000\u0003")).toThrow(CANT_COPY_TYPE);
  });
});

/** A clipboard that records what it got. `write` reads every item's text/plain blob. */
function fakeClipboard(opts: { writeFails?: boolean; writeTextFails?: boolean } = {}) {
  const calls: string[] = [];
  const clipboard = {
    write: async (items: ClipboardItems) => {
      calls.push("write");
      for (const item of items) {
        const blob = await (item as unknown as FakeItem).data["text/plain"];
        calls.push(`write:${await blob.text()}`);
      }
      if (opts.writeFails) throw new Error("NotAllowedError");
    },
    writeText: async (text: string) => {
      calls.push(`writeText:${text}`);
      if (opts.writeTextFails) throw new Error("NotAllowedError");
    },
  };
  return { calls, clipboard };
}

class FakeItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

function env(
  clipboard: ReturnType<typeof fakeClipboard>["clipboard"],
  withItem = true,
): ClipboardEnv {
  return {
    clipboard: clipboard as unknown as ClipboardEnv["clipboard"],
    ClipboardItem: withItem ? (FakeItem as unknown as typeof ClipboardItem) : undefined,
  };
}

describe("writeTextWhenReady", () => {
  test("writes a ClipboardItem before the text resolves (Safari keeps the gesture)", async () => {
    const { calls, clipboard } = fakeClipboard();
    let resolve: (text: string) => void = () => {};
    const text = new Promise<string>((r) => {
      resolve = r;
    });
    const done = writeTextWhenReady(text, env(clipboard));
    // The write started synchronously, with the text still loading.
    expect(calls).toEqual(["write"]);
    resolve("contents");
    expect(await done).toBe(true);
    expect(calls).toEqual(["write", "write:contents"]);
  });

  test("falls back to writeText without ClipboardItem", async () => {
    const { calls, clipboard } = fakeClipboard();
    expect(await writeTextWhenReady(Promise.resolve("plain"), env(clipboard, false))).toBe(true);
    expect(calls).toEqual(["writeText:plain"]);
  });

  test("falls back to writeText when the ClipboardItem write fails", async () => {
    const { calls, clipboard } = fakeClipboard({ writeFails: true });
    expect(await writeTextWhenReady(Promise.resolve("again"), env(clipboard))).toBe(true);
    expect(calls).toEqual(["write", "write:again", "writeText:again"]);
  });

  test("a failed load copies nothing", async () => {
    const { calls, clipboard } = fakeClipboard();
    const text = Promise.reject(new Error(TOO_LARGE_TO_COPY));
    expect(await writeTextWhenReady(text, env(clipboard, false))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a blocked clipboard and no clipboard resolve to false", async () => {
    const { clipboard } = fakeClipboard({ writeFails: true, writeTextFails: true });
    expect(await writeTextWhenReady(Promise.resolve("x"), env(clipboard))).toBe(false);
    expect(await writeTextWhenReady(Promise.resolve("x"), {})).toBe(false);
  });
});

describe("loadTextToCopy", () => {
  const STAT = { size: 4, contentType: "text/plain" };
  const OVER_CAP = "a".repeat(2 * 1024 * 1024);
  const noFetch = () => Promise.reject(new Error("fetched"));

  async function rejection(load: Promise<string>) {
    const err = await load.then(
      () => null,
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(CopyRejected);
    return (err as Error).message;
  }

  test("copies fetched text within the cap", async () => {
    let fetches = 0;
    const text = await loadTextToCopy("/a.txt", STAT, undefined, async () => {
      fetches++;
      return new Blob(["abcd"]);
    });
    expect(text).toBe("abcd");
    expect(fetches).toBe(1);
  });

  test("a small stat with 2 MiB fetched is too large", async () => {
    const load = loadTextToCopy("/a.txt", STAT, undefined, async () => new Blob([OVER_CAP]));
    expect(await rejection(load)).toBe(TOO_LARGE_TO_COPY);
  });

  test("cached text copies without a fetch", async () => {
    expect(await loadTextToCopy("/a.txt", STAT, "cached", noFetch)).toBe("cached");
  });

  test("a small stat with 2 MiB of cached text is too large", async () => {
    expect(await rejection(loadTextToCopy("/a.txt", STAT, OVER_CAP, noFetch))).toBe(
      TOO_LARGE_TO_COPY,
    );
  });

  test("the cached cap counts UTF-8 bytes, not characters", async () => {
    // 600k two-byte characters: under the cap in characters, over it in bytes.
    const wide = "é".repeat(600_000);
    expect(await rejection(loadTextToCopy("/a.txt", STAT, wide, noFetch))).toBe(TOO_LARGE_TO_COPY);
  });

  test("binary bytes are rejected as the wrong type", async () => {
    const load = loadTextToCopy(
      "/README",
      { size: 4, contentType: "application/octet-stream" },
      undefined,
      async () => new Blob([new Uint8Array([0, 1, 2, 0])]),
    );
    expect(await rejection(load)).toBe(CANT_COPY_TYPE);
  });

  test("a stat that fails copyCheck rejects before any load", async () => {
    const load = loadTextToCopy(
      "/photo.png",
      { size: 4, contentType: "image/png" },
      undefined,
      noFetch,
    );
    expect(await rejection(load)).toBe(CANT_COPY_TYPE);
  });
});
