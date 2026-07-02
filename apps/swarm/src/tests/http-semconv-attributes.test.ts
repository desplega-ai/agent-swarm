/**
 * Tests for `httpServerSemconvAttributes` — the OTel HTTP server
 * semantic-convention span attributes derived from an inbound request
 * (`server.address`, `url.scheme`, `network.protocol.version`,
 * `user_agent.original`).
 */

import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { httpServerSemconvAttributes } from "../http/utils";

function makeReq(
  headers: Record<string, string | string[] | undefined>,
  httpVersion = "1.1",
): IncomingMessage {
  return { headers, httpVersion } as unknown as IncomingMessage;
}

describe("httpServerSemconvAttributes", () => {
  test("strips the port from the Host header for server.address", () => {
    const attrs = httpServerSemconvAttributes(makeReq({ host: "api.example.com:3013" }));
    expect(attrs["server.address"]).toBe("api.example.com");
  });

  test("leaves a portless host unchanged", () => {
    const attrs = httpServerSemconvAttributes(makeReq({ host: "api.example.com" }));
    expect(attrs["server.address"]).toBe("api.example.com");
  });

  test("keeps a bracketed IPv6 literal intact while stripping its port", () => {
    expect(httpServerSemconvAttributes(makeReq({ host: "[::1]:3013" }))["server.address"]).toBe(
      "[::1]",
    );
    expect(httpServerSemconvAttributes(makeReq({ host: "[::1]" }))["server.address"]).toBe("[::1]");
  });

  test("prefers X-Forwarded-Host over the Host header", () => {
    const attrs = httpServerSemconvAttributes(
      makeReq({ host: "internal:3013", "x-forwarded-host": "public.example.com" }),
    );
    expect(attrs["server.address"]).toBe("public.example.com");
  });

  test("takes the first hop of a comma-joined X-Forwarded-Host", () => {
    const attrs = httpServerSemconvAttributes(
      makeReq({ "x-forwarded-host": "public.example.com, proxy.internal" }),
    );
    expect(attrs["server.address"]).toBe("public.example.com");
  });

  test("url.scheme honors X-Forwarded-Proto", () => {
    expect(
      httpServerSemconvAttributes(makeReq({ "x-forwarded-proto": "https" }))["url.scheme"],
    ).toBe("https");
  });

  test("url.scheme defaults to http when X-Forwarded-Proto is absent", () => {
    expect(httpServerSemconvAttributes(makeReq({}))["url.scheme"]).toBe("http");
  });

  test("url.scheme takes the first hop of a comma-joined X-Forwarded-Proto", () => {
    expect(
      httpServerSemconvAttributes(makeReq({ "x-forwarded-proto": "https,http" }))["url.scheme"],
    ).toBe("https");
  });

  test("network.protocol.version reflects the HTTP version", () => {
    expect(httpServerSemconvAttributes(makeReq({}, "2"))["network.protocol.version"]).toBe("2");
  });

  test("user_agent.original preserves commas inside the UA string", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";
    const attrs = httpServerSemconvAttributes(makeReq({ "user-agent": ua }));
    expect(attrs["user_agent.original"]).toBe(ua);
  });

  test("omits optional attributes when their headers are absent", () => {
    const attrs = httpServerSemconvAttributes(makeReq({}, ""));
    expect(attrs["server.address"]).toBeUndefined();
    expect(attrs["network.protocol.version"]).toBeUndefined();
    expect(attrs["user_agent.original"]).toBeUndefined();
    // url.scheme always has a value.
    expect(attrs["url.scheme"]).toBe("http");
  });

  test("normalizes array-valued headers to the first element", () => {
    const attrs = httpServerSemconvAttributes(
      makeReq({ host: ["a.example.com:80", "b.example.com"] }),
    );
    expect(attrs["server.address"]).toBe("a.example.com");
  });
});
