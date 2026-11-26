import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

const path = (url: string) => `/api/link-preview?url=${encodeURIComponent(url)}`;

/** GET /api/link-preview: the SSRF guard and the dead-link fallback (no outbound network needed). */
export const linkPreview: Scenario = {
  name: "link-preview",
  order: 696,
  async run(ctx) {
    expectStatus(
      await ctx.api("GET", path("https://example.com"), { apiKey: null }),
      [401],
      "preview without authorization",
    );
    expectStatus(await ctx.api("GET", "/api/link-preview"), [400], "preview without url");
    for (const refused of [
      "http://127.0.0.1:3013/health",
      "http://localhost/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expectStatus(await ctx.api("GET", path(refused)), [400], `preview of ${refused}`);
    }
    // `.invalid` never resolves (RFC 6761): a dead link reads ok:false, not an error.
    const dead = await ctx.api("GET", path("https://dead-link.invalid/page"));
    expectStatus(dead, [200], "preview of a dead link");
    const body = asRecord(dead.json);
    expect(body.ok === false, "dead link reports ok:false");
    expect(body.title === null && body.image === null, "dead link has empty fields");
  },
};
