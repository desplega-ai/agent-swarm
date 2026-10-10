import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DraftStorage } from "./drafts";
import {
  fitPresence,
  fromGapPointer,
  fromLinePointer,
  fromMediaPointer,
  mergePeers,
  nextExpiry,
  PEER_COLOR_COUNT,
  PEER_TTL_MS,
  type PeerState,
  POINTER_IDLE_MS,
  PRESENCE_MAX_BYTES,
  type PresenceData,
  parsePeer,
  peerColor,
  presenceNamespace,
  readShowCursors,
  SELECTION_EXACT_MAX,
  SELECTION_TTL_MS,
  selectionQuote,
  toGapPointer,
  toLinePointer,
  toMediaPointer,
  visiblePeers,
  writeShowCursors,
} from "./presence";

function data(overrides: Partial<PresenceData> = {}): PresenceData {
  return {
    v: 1,
    who: { id: "u-bob", name: "Bob Chen" },
    file: { path: "/docs/spec.md", version: 4 },
    sel: null,
    ptr: null,
    t: 1_000,
    ...overrides,
  };
}

function raw(connection: string, value: unknown, kind = "guest") {
  return { userId: connection, name: "Guest abc123", kind, data: value };
}

describe("parsePeer", () => {
  test("accepts a valid peer and keeps the server connection id", () => {
    const sel = { exact: "the goal", prefix: "open questions. ", suffix: " of", lineStart: 3 };
    const peer = parsePeer(raw("guest-1", data({ sel, ptr: { line: 3.5, frac: 0.25 } })));
    expect(peer).toEqual({
      connection: "guest-1",
      data: data({ sel: { ...sel, lineEnd: 3 }, ptr: { line: 3.5, frac: 0.25 } }),
    });
  });

  test("rejects agents, other versions, and malformed data", () => {
    expect(parsePeer(raw("a", data(), "agent"))).toBeNull();
    expect(parsePeer(raw("a", { ...data(), v: 2 }))).toBeNull();
    expect(parsePeer(raw("a", { ...data(), t: "now" }))).toBeNull();
    expect(parsePeer(raw("a", { ...data(), who: { name: "No id" } }))).toBeNull();
    expect(
      parsePeer(raw("a", { ...data(), who: { id: "x".repeat(200), name: "Long" } })),
    ).toBeNull();
    expect(parsePeer(raw("", data()))).toBeNull();
    expect(parsePeer({ userId: "a", kind: "guest" })).toBeNull();
    expect(parsePeer("peer")).toBeNull();
    expect(parsePeer(null)).toBeNull();
    // The server's empty presence before the first publish.
    expect(parsePeer(raw("a", {}))).toBeNull();
  });

  test("cleans the name: control and bidi characters go, length is capped", () => {
    const peer = parsePeer(
      raw("a", data({ who: { id: "u1", name: ` Eve‮\u0000 ${"x".repeat(200)}` } })),
    );
    expect(peer?.data.who.name.startsWith("Eve ")).toBe(true);
    expect(peer?.data.who.name).not.toContain("‮");
    expect(peer?.data.who.name.length).toBe(80);
    // An empty name falls back to the start of the id.
    expect(
      parsePeer(raw("a", data({ who: { id: "user-1234567", name: " " } })))?.data.who.name,
    ).toBe("user-123");
  });

  test("keeps only an https avatar", () => {
    const avatar = (value: string) =>
      parsePeer(raw("a", data({ who: { id: "u", name: "U", avatar: value } })))?.data.who.avatar;
    expect(avatar("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(avatar("javascript:alert(1)")).toBeUndefined();
    expect(avatar("http://example.com/a.png")).toBeUndefined();
  });

  test("drops a bad file, and with it the selection and pointer", () => {
    for (const file of [
      { path: "docs/spec.md", version: 1 },
      { path: "/docs/spec.md", version: 0 },
      { path: `/${"a".repeat(2000)}`, version: 1 },
      "spec.md",
    ]) {
      const peer = parsePeer(
        raw("a", { ...data(), file, sel: { exact: "x" }, ptr: { x: 0.5, y: 0.5 } }),
      );
      expect(peer?.data.file).toBeNull();
      expect(peer?.data.sel).toBeNull();
      expect(peer?.data.ptr).toBeNull();
    }
  });

  test("caps the selection and clamps pointers", () => {
    const long = "a".repeat(SELECTION_EXACT_MAX + 50);
    const peer = parsePeer(
      raw(
        "a",
        data({
          sel: {
            exact: long,
            prefix: "p".repeat(100),
            suffix: "s".repeat(100),
            lineStart: 9,
            lineEnd: 2,
          },
          ptr: { line: 12, frac: 7 },
        }),
      ),
    );
    expect(peer?.data.sel?.exact.length).toBe(SELECTION_EXACT_MAX);
    expect(peer?.data.sel?.prefix?.length).toBe(32);
    expect(peer?.data.sel?.suffix?.length).toBe(32);
    expect(peer?.data.sel?.lineEnd).toBe(9);
    expect(peer?.data.ptr).toEqual({ line: 12, frac: 1 });
    expect(parsePeer(raw("a", data({ ptr: { x: -3, y: 9 } })))?.data.ptr).toEqual({ x: 0, y: 1 });
    expect(parsePeer(raw("a", data({ ptr: { line: 0, frac: 0.5 } })))?.data.ptr).toBeNull();
    expect(
      parsePeer(raw("a", { ...data(), ptr: { line: Number.NaN, frac: 0 } }))?.data.ptr,
    ).toBeNull();
    expect(parsePeer(raw("a", data({ sel: { exact: "   " } })))?.data.sel).toBeNull();
  });
});

function state(connection: string, value: PresenceData, at: number): PeerState {
  return { connection, data: value, seenAt: at, selAt: at, ptrAt: at };
}

describe("mergePeers", () => {
  test("keeps a peer's times when a frame repeats its data", () => {
    const first = mergePeers(new Map(), [{ connection: "a", data: data() }], 100);
    const again = mergePeers(first, [{ connection: "a", data: data() }], 5_000);
    expect(again.get("a")).toBe(first.get("a"));
  });

  test("moves only the times of what changed", () => {
    const sel = { exact: "goal" };
    const first = mergePeers(new Map(), [{ connection: "a", data: data({ sel }) }], 100);
    const moved = mergePeers(
      first,
      [{ connection: "a", data: data({ sel, ptr: { line: 4, frac: 0.5 }, t: 2_000 }) }],
      900,
    );
    expect(moved.get("a")).toMatchObject({ seenAt: 900, selAt: 100, ptrAt: 900 });
  });

  test("forgets connections missing from the frame", () => {
    const first = mergePeers(
      new Map(),
      [
        { connection: "a", data: data() },
        { connection: "b", data: data({ who: { id: "u-carol", name: "Carol" } }) },
      ],
      0,
    );
    expect([...mergePeers(first, [{ connection: "b", data: data() }], 10).keys()]).toEqual(["b"]);
  });
});

describe("visiblePeers", () => {
  const none = new Set<string>();

  test("one entry per person: a tab on a file beats a fresher tab on no file", () => {
    const peers = visiblePeers(
      [
        state("tab-1", data({ t: 1 }), 100),
        state("tab-2", data({ file: null, t: 2 }), 900),
        state("tab-3", data({ t: 3, file: { path: "/b.md", version: 1 } }), 500),
      ],
      1_000,
      none,
    );
    expect(peers).toHaveLength(1);
    expect(peers[0].file?.path).toBe("/b.md");
  });

  test("leaves out me and the swarm service account", () => {
    const peers = visiblePeers(
      [
        state("a", data({ who: { id: "me", name: "Me" } }), 0),
        state("b", data({ who: { id: "swarm", name: "Swarm" } }), 0),
        state("c", data(), 0),
      ],
      10,
      new Set(["me", "swarm"]),
    );
    expect(peers.map((p) => p.id)).toEqual(["u-bob"]);
  });

  test("expires an idle pointer, then the selection, then the peer", () => {
    const peer = state(
      "a",
      data({
        sel: { exact: "goal" },
        ptr: { x: 0.5, y: 0.5 },
        file: { path: "/i.png", version: 1 },
      }),
      0,
    );
    const at = (now: number) => visiblePeers([peer], now, none)[0];
    expect(at(POINTER_IDLE_MS).ptr).not.toBeNull();
    expect(at(POINTER_IDLE_MS + 1).ptr).toBeNull();
    expect(at(POINTER_IDLE_MS + 1).sel).not.toBeNull();
    expect(at(SELECTION_TTL_MS + 1).sel).toBeNull();
    expect(at(SELECTION_TTL_MS + 1)).toBeDefined();
    expect(at(PEER_TTL_MS + 1)).toBeUndefined();
  });

  test("a heartbeat keeps the selection, the pointer still idles out", () => {
    const peer: PeerState = {
      connection: "a",
      data: data({ sel: { exact: "goal" }, ptr: { line: 2, frac: 0 } }),
      seenAt: 20_000,
      selAt: 0,
      ptrAt: 0,
    };
    const [shown] = visiblePeers([peer], 25_000, none);
    expect(shown.sel).not.toBeNull();
    expect(shown.ptr).toBeNull();
  });

  test("names come from the label function and sort by name", () => {
    const peers = visiblePeers(
      [
        state("a", data({ who: { id: "u2", name: "zed" } }), 0),
        state("b", data({ who: { id: "u1", name: "Anna" } }), 0),
      ],
      0,
      none,
      (id, name) => (id === "u2" ? "Aaron" : name),
    );
    expect(peers.map((p) => p.name)).toEqual(["Aaron", "Anna"]);
  });

  test("nextExpiry is the earliest pending expiry", () => {
    const peer = state("a", data({ ptr: { line: 1, frac: 0 }, sel: { exact: "x" } }), 1_000);
    expect(nextExpiry([peer], 1_000)).toBe(1_000 + POINTER_IDLE_MS + 1);
    expect(nextExpiry([peer], 1_000 + POINTER_IDLE_MS + 1)).toBe(1_000 + SELECTION_TTL_MS + 1);
    expect(nextExpiry([], 0)).toBeNull();
  });
});

describe("peerColor", () => {
  test("is stable and in range", () => {
    expect(peerColor("u-bob")).toBe(peerColor("u-bob"));
    for (let i = 0; i < 200; i++) {
      const color = peerColor(`user-${i}`);
      expect(color).toBeGreaterThanOrEqual(1);
      expect(color).toBeLessThanOrEqual(PEER_COLOR_COUNT);
    }
  });

  test("spreads ids over every slot", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => peerColor(crypto.randomUUID() + i)));
    expect(used.size).toBe(PEER_COLOR_COUNT);
  });
});

// WCAG contrast of the palette in `styles/globals.css`: the first block of
// values is the light theme (`@theme`), the second is `.dark`.
describe("peer palette contrast", () => {
  const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");
  const values = (name: string): string[] =>
    [...css.matchAll(new RegExp(`--color-${name}:\\s*(oklch\\([^)]*\\))`, "g"))].map((m) => m[1]);

  function luminance(oklch: string): number {
    const [L, C, h] = oklch.slice(6, -1).trim().split(/\s+/).map(Number);
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    // In the sRGB gamut, so no browser clipping shifts the color.
    for (const channel of rgb) {
      expect(channel).toBeGreaterThanOrEqual(-0.001);
      expect(channel).toBeLessThanOrEqual(1.001);
    }
    const [r, g, bl] = rgb.map((c) => Math.min(1, Math.max(0, c)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  }
  const contrast = (x: string, y: string) => {
    const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const [theme, index] of [
    ["light", 0],
    ["dark", 1],
  ] as const) {
    test(`${theme}: names are readable on every color, and every color stands out from the page`, () => {
      const foreground = values("peer-foreground")[index];
      const page = [values("background")[index], values("card")[index]];
      expect(foreground).toBeDefined();
      for (let slot = 1; slot <= PEER_COLOR_COUNT; slot++) {
        const color = values(`peer-${slot}`)[index];
        expect(color).toBeDefined();
        expect(contrast(color, foreground)).toBeGreaterThanOrEqual(4.5);
        for (const surface of page) expect(contrast(color, surface)).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe("pointer math", () => {
  const box = { left: 100, top: 200, width: 400, height: 60 };

  test("a line pointer maps down the block onto its source lines, and back", () => {
    // A paragraph over source lines 10 to 12, rendered 60px tall.
    const ptr = toLinePointer(box, 10, 12, 200, 230);
    expect(ptr).toEqual({ line: 11.5, frac: 0.25 });
    expect(fromLinePointer(box, 10, 12, ptr)).toEqual({ x: 200, y: 230 });
  });

  test("a line pointer lands proportionally in a block of another size", () => {
    const ptr = toLinePointer(box, 10, 12, 300, 215);
    const wider = { left: 0, top: 0, width: 800, height: 120 };
    expect(fromLinePointer(wider, 10, 12, ptr)).toEqual({ x: 400, y: 30 });
  });

  test("a line pointer clamps to its block and stays on the block's lines", () => {
    expect(toLinePointer(box, 7, 7, 50, 900)).toEqual({ line: 7.9999, frac: 0 });
    expect(toLinePointer(box, 7, 7, 900, 100)).toEqual({ line: 7, frac: 1 });
    // An empty box gives the block's first line.
    expect(toLinePointer({ left: 0, top: 0, width: 0, height: 0 }, 3, 5, 10, 10)).toEqual({
      line: 3,
      frac: 0,
    });
    expect(fromLinePointer(box, 10, 12, { line: 40, frac: 2 })).toEqual({ x: 500, y: 260 });
  });

  test("rounds, so a sub-pixel move is no change", () => {
    const a = toLinePointer(box, 1, 1, 200.00001, 230);
    const b = toLinePointer(box, 1, 1, 200.00002, 230);
    expect(a).toEqual(b);
  });

  test("a pointer between blocks maps onto the source lines between them, and back", () => {
    // A paragraph on line 3, an image on lines 4 to 6 (no block), a heading on line 7.
    const above = {
      box: { left: 100, top: 100, width: 400, height: 50 },
      lineStart: 3,
      lineEnd: 3,
    };
    const below = {
      box: { left: 100, top: 450, width: 400, height: 30 },
      lineStart: 7,
      lineEnd: 7,
    };
    const ptr = toGapPointer(above, below, 300, 300);
    expect(ptr).toEqual({ line: 5.5, frac: 0.5 });
    expect(fromGapPointer(above, below, ptr)).toEqual({ x: 300, y: 300 });
    // The image is 300px here and 600px on a wider screen: the pointer keeps its share.
    const wide = { ...below, box: { ...below.box, top: 750 } };
    expect(fromGapPointer(above, wide, ptr).y).toBe(450);
  });

  test("a gap with no line between the blocks sits at the bottom of the block above", () => {
    const above = { box: { left: 0, top: 0, width: 100, height: 40 }, lineStart: 2, lineEnd: 4 };
    const below = { box: { left: 0, top: 60, width: 100, height: 20 }, lineStart: 5, lineEnd: 5 };
    const ptr = toGapPointer(above, below, 50, 50);
    expect(ptr).toEqual({ line: 4.9997, frac: 0.5 });
    // After the last block the same holds.
    expect(toGapPointer(above, null, 50, 500)).toEqual(ptr);
    expect(fromLinePointer(above.box, 2, 4, ptr).y).toBeCloseTo(40, 1);
  });

  test("a media pointer is normalized to the media box and null outside it", () => {
    expect(toMediaPointer(box, 300, 215)).toEqual({ x: 0.5, y: 0.25 });
    expect(toMediaPointer(box, 99, 215)).toBeNull();
    expect(toMediaPointer(box, 300, 261)).toBeNull();
    expect(toMediaPointer({ left: 0, top: 0, width: 0, height: 10 }, 0, 0)).toBeNull();
    expect(
      fromMediaPointer({ left: 10, top: 20, width: 200, height: 100 }, { x: 0.5, y: 0.25 }),
    ).toEqual({
      x: 110,
      y: 45,
    });
  });
});

describe("selectionQuote", () => {
  const text = "The goal of this introduction is to give every reader enough background.";

  test("trims the edges and keeps context on both sides", () => {
    const start = text.indexOf(" give");
    const picked = selectionQuote(text, start, text.indexOf(" enough"));
    expect(picked?.quote.exact).toBe("give every reader");
    expect(picked?.quote.prefix).toBe(text.slice(Math.max(0, start + 1 - 32), start + 1));
    expect(picked?.quote.suffix).toBe(" enough background.");
    expect(text.slice(picked?.start, picked?.end)).toBe("give every reader");
  });

  test("a long selection sends its first part with matching context", () => {
    const long = `${"word ".repeat(400)}tail`;
    const picked = selectionQuote(long, 0, long.length);
    expect(picked?.quote.exact.length).toBeLessThanOrEqual(SELECTION_EXACT_MAX);
    expect(long.slice(picked?.end, (picked?.end ?? 0) + 32)).toBe(picked?.quote.suffix ?? "");
  });

  test("whitespace alone is no selection", () => {
    expect(selectionQuote("a   b", 1, 4)).toBeNull();
  });
});

describe("fitPresence", () => {
  test("stays under the server's 8 KiB presence limit", () => {
    const small = data({ sel: { exact: "goal" } });
    expect(fitPresence(small)).toBe(small);
    // 1,000 control characters escape to 6,000 bytes of JSON. A long path does the rest.
    const escaped = data({
      file: { path: `/${"a".repeat(900)}`, version: 1 },
      sel: { exact: "\u0001".repeat(SELECTION_EXACT_MAX) },
    });
    const fitted = fitPresence(escaped);
    expect(fitted.sel).toBeNull();
    expect(fitted.file).toEqual(escaped.file);
    const hugePath = data({ file: { path: `/${"界".repeat(2_400)}`, version: 1 } });
    expect(fitPresence(hugePath).file).toBeNull();
    for (const value of [fitted, fitPresence(hugePath)]) {
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThanOrEqual(
        PRESENCE_MAX_BYTES,
      );
    }
  });
});

describe("presenceNamespace and the cursors choice", () => {
  test("builds the drive room namespace, or null for ids the server refuses", () => {
    expect(presenceNamespace("org-1", "drive_2")).toBe("presence:comb:org-1:drive_2");
    expect(presenceNamespace("org:1", "d")).toBeNull();
    expect(presenceNamespace("o", "x".repeat(65))).toBeNull();
  });

  test("Show cursors is on until turned off, per swarm", () => {
    const map = new Map<string, string>();
    const storage: DraftStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    };
    expect(readShowCursors(storage, "http://a")).toBe(true);
    writeShowCursors(storage, "http://a", false);
    expect(readShowCursors(storage, "http://a")).toBe(false);
    expect(readShowCursors(storage, "http://b")).toBe(true);
    expect(readShowCursors(null, "http://a")).toBe(true);
  });
});
