import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SHARE_EXPIRY_SECONDS,
  describeExpiry,
  SHARE_EXPIRY_CHOICES,
  shareDescription,
  shareLinkUrl,
} from "./share";

describe("share expiry", () => {
  test("choices run from 1 hour to the 7-day server maximum, default 24 hours", () => {
    const seconds = SHARE_EXPIRY_CHOICES.map((choice) => choice.seconds);
    expect(seconds).toEqual([3600, 86_400, 259_200, 604_800]);
    expect(Math.max(...seconds)).toBe(7 * 24 * 3600);
    expect(seconds).toContain(DEFAULT_SHARE_EXPIRY_SECONDS);
    expect(DEFAULT_SHARE_EXPIRY_SECONDS).toBe(86_400);
  });

  test("each choice label matches describeExpiry", () => {
    for (const choice of SHARE_EXPIRY_CHOICES) {
      expect(describeExpiry(choice.seconds)).toBe(choice.label);
    }
  });

  test("describeExpiry reads minutes, hours, and days", () => {
    expect(describeExpiry(30)).toBe("1 minute");
    expect(describeExpiry(900)).toBe("15 minutes");
    expect(describeExpiry(3600)).toBe("1 hour");
    expect(describeExpiry(47 * 3600)).toBe("47 hours");
    expect(describeExpiry(48 * 3600)).toBe("2 days");
  });
});

describe("shareLinkUrl", () => {
  test("builds the link from the browser's agent-fs URL", () => {
    expect(
      shareLinkUrl("https://fs.example.com/", {
        url: "http://agent-fs:7433/share/abc",
        sharePath: "/share/abc",
      }),
    ).toBe("https://fs.example.com/share/abc");
  });

  test("keeps a path prefix on the endpoint", () => {
    expect(shareLinkUrl("https://ui.example.com/fs", { url: "", sharePath: "/share/abc" })).toBe(
      "https://ui.example.com/fs/share/abc",
    );
  });

  test("falls back to the server's url without a sharePath", () => {
    expect(
      shareLinkUrl("https://fs.example.com", { url: "https://x/share/abc", sharePath: "" }),
    ).toBe("https://x/share/abc");
  });
});

describe("shareDescription", () => {
  test("an HTML page warns that files next to it do not load", () => {
    expect(shareDescription("/site/page.html")).toContain("Only this file is shared");
    expect(shareDescription("/site/PAGE.HTM")).toContain("Only this file is shared");
  });

  test("other files can be viewed and downloaded", () => {
    expect(shareDescription("/docs/a.md")).toContain("view and download");
  });
});
