import { describe, expect, test } from "bun:test";
import {
  MEDIA_ICON_MAX_BYTES,
  mediaIconFileError,
  mediaIconPath,
  parseMediaIconUrl,
  uploadMediaIcon,
} from "./upload-media-icon";

describe("parseMediaIconUrl", () => {
  test("accepts an https link", () => {
    expect(parseMediaIconUrl(" https://example.com/i.png ")).toEqual({
      ok: true,
      icon: { type: "url", url: "https://example.com/i.png" },
    });
  });

  test("rejects http, other schemes, credentials, blanks, and long links", () => {
    expect(parseMediaIconUrl("http://example.com/x.png")).toEqual({
      ok: false,
      error: "Use an https URL.",
    });
    expect(parseMediaIconUrl("javascript:alert(1)").ok).toBe(false);
    expect(parseMediaIconUrl("https://u:p@example.com/x.png").ok).toBe(false);
    expect(parseMediaIconUrl("   ").ok).toBe(false);
    expect(parseMediaIconUrl("not a url").ok).toBe(false);
    expect(parseMediaIconUrl(`https://example.com/${"a".repeat(2048)}`).ok).toBe(false);
  });
});

describe("mediaIconFileError", () => {
  test("accepts each supported image type up to 1 MB", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]) {
      expect(mediaIconFileError({ type, size: MEDIA_ICON_MAX_BYTES })).toBeNull();
    }
  });

  test("rejects other types", () => {
    expect(mediaIconFileError({ type: "text/plain", size: 10 })).toContain("PNG");
    expect(mediaIconFileError({ type: "", size: 10 })).toContain("PNG");
    expect(mediaIconFileError({ type: "image/tiff", size: 10 })).toContain("PNG");
  });

  test("rejects a file over 1 MB", () => {
    expect(mediaIconFileError({ type: "image/png", size: MEDIA_ICON_MAX_BYTES + 1 })).toContain(
      "1 MB",
    );
  });
});

describe("mediaIconPath", () => {
  test("appends the time and the extension for the type", () => {
    expect(mediaIconPath("/apps/a1/icon", "image/png", 42)).toBe("/apps/a1/icon-42.png");
    expect(mediaIconPath("/apps/a1/icon", "image/jpeg", 42)).toBe("/apps/a1/icon-42.jpg");
    expect(mediaIconPath("/apps/a1/icon", "image/svg+xml", 42)).toBe("/apps/a1/icon-42.svg");
  });

  test("makes a relative prefix absolute", () => {
    expect(mediaIconPath("apps/a1/icon", "image/gif", 7)).toBe("/apps/a1/icon-7.gif");
  });

  test("throws on an unsupported type", () => {
    expect(() => mediaIconPath("/apps/a1/icon", "text/plain", 1)).toThrow();
  });
});

describe("uploadMediaIcon", () => {
  const drive = { orgId: "org", driveId: "drive" };

  test("writes create-only and returns the agent-fs icon", async () => {
    const calls: unknown[][] = [];
    const client = {
      putRaw: async (...args: unknown[]) => {
        calls.push(args);
        return {} as never;
      },
    };
    const file = new File([new Uint8Array(8)], "x.png", { type: "image/png" });
    const icon = await uploadMediaIcon(client as never, drive, "/apps/a1/icon", file, () => 99);
    expect(icon).toEqual({ type: "agent-fs", path: "/apps/a1/icon-99.png" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(["org", "drive", "/apps/a1/icon-99.png", file]);
    expect(calls[0]?.[4]).toMatchObject({ ifNoneMatch: true });
  });

  test("rejects an invalid file without uploading", async () => {
    let called = false;
    const client = {
      putRaw: async () => {
        called = true;
        return {} as never;
      },
    };
    const file = new File(["hello"], "x.txt", { type: "text/plain" });
    await expect(uploadMediaIcon(client as never, drive, "/apps/a1/icon", file)).rejects.toThrow(
      "PNG",
    );
    expect(called).toBe(false);
  });
});
