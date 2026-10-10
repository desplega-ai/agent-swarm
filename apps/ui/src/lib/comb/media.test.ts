import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../agent-fs/client";
import type { SignedUrlResult } from "../agent-fs/types";
import {
  blobUrlPlan,
  freshPresignedUrl,
  MEDIA_URL_EXPIRY_MARGIN_MS,
  type MediaSource,
  mediaSourceFrom,
} from "./media";

const MINTED_AT = 1_000_000;

function signed(kind: SignedUrlResult["kind"], expiresIn = 3600): SignedUrlResult {
  return {
    url: `https://storage.example/pic.png?kind=${kind}`,
    path: "/pic.png",
    expiresIn,
    expiresAt: "",
    kind,
  };
}

describe("mediaSourceFrom", () => {
  test("a presigned result is used, with its expiry counted from the mint time", () => {
    expect(mediaSourceFrom({ result: signed("presigned") }, MINTED_AT)).toEqual({
      kind: "presigned",
      url: "https://storage.example/pic.png?kind=presigned",
      expiresAt: MINTED_AT + 3600 * 1000,
    });
  });

  test("an app link falls back to blob mode", () => {
    expect(mediaSourceFrom({ result: signed("app", 0) }, MINTED_AT)).toEqual({ kind: "blob" });
  });

  test("a 422 (no presigned URLs on this backend) falls back to blob mode", () => {
    const error = new AgentFsError(422, "UnsupportedOperation", "Not supported");
    expect(mediaSourceFrom({ error }, MINTED_AT)).toEqual({ kind: "blob" });
  });

  test("other errors surface", () => {
    for (const error of [
      new AgentFsError(404, "NotFound", "No such file"),
      new AgentFsError(403, "Forbidden", "No access"),
      new AgentFsError(0, "NetworkError", "Offline"),
      new Error("boom"),
    ]) {
      expect(mediaSourceFrom({ error }, MINTED_AT)).toEqual({ kind: "error", error });
    }
  });
});

describe("freshPresignedUrl", () => {
  const source: MediaSource = { kind: "presigned", url: "u", expiresAt: 10 * 60_000 };

  test("a URL outside the expiry margin is used", () => {
    expect(freshPresignedUrl(source, 0)).toBe("u");
    expect(freshPresignedUrl(source, source.expiresAt - MEDIA_URL_EXPIRY_MARGIN_MS - 1)).toBe("u");
  });

  test("a URL within 5 minutes of its expiry counts as missing", () => {
    expect(freshPresignedUrl(source, source.expiresAt - MEDIA_URL_EXPIRY_MARGIN_MS)).toBeNull();
    expect(freshPresignedUrl(source, source.expiresAt + 1)).toBeNull();
  });

  test("blob mode and no data have no presigned URL", () => {
    expect(freshPresignedUrl({ kind: "blob" }, 0)).toBeNull();
    expect(freshPresignedUrl(undefined, 0)).toBeNull();
  });
});

describe("blobUrlPlan", () => {
  const octet = { as: "object-url", type: "application/octet-stream" };

  test("raster images and video never keep their stored type", () => {
    expect(blobUrlPlan("image", "/a/pic.png", "image/png")).toEqual(octet);
    expect(blobUrlPlan("image", "/a/x.png", "text/html")).toEqual(octet);
    expect(blobUrlPlan("image", "/a/photo.JPG")).toEqual(octet);
    expect(blobUrlPlan("video", "/a/clip.mp4", "video/mp4")).toEqual(octet);
    expect(blobUrlPlan("video", "/a/clip.svg", "image/svg+xml")).toEqual(octet);
  });

  test("a PDF is always application/pdf", () => {
    expect(blobUrlPlan("pdf", "/a/doc.pdf", "text/html")).toEqual({
      as: "object-url",
      type: "application/pdf",
    });
  });

  test("SVG by extension or by stored type becomes a data URL", () => {
    const svg = { as: "data-url", type: "image/svg+xml" };
    expect(blobUrlPlan("image", "/a/logo.svg", "text/html")).toEqual(svg);
    expect(blobUrlPlan("image", "/a/LOGO.SVG")).toEqual(svg);
    expect(blobUrlPlan("image", "/a/logo", "image/svg+xml; charset=utf-8")).toEqual(svg);
  });
});
