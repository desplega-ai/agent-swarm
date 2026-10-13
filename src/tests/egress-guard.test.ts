import { afterEach, describe, expect, test } from "bun:test";
import { patchFetchWithCredentialBroker } from "../scripts-runtime/credential-broker";
import { scriptEgressPolicy } from "../scripts-runtime/loader";
import {
  assertUrlSafe,
  createGuardedFetch,
  type EgressPolicy,
  isPrivateAddress,
  parseEgressAllowlist,
  validateEgressAllowlist,
} from "../utils/egress-guard";

const BLOCKED_URLS = [
  "https://127.0.0.1/",
  "https://127.8.9.10/",
  "https://10.1.2.3/",
  "https://100.64.0.1/",
  "https://100.127.255.255/",
  "https://0.0.0.0/",
  "https://169.254.169.254/latest/meta-data",
  "https://172.16.0.1/",
  "https://172.31.255.255/",
  "https://192.168.1.1/",
  "https://192.0.0.8/",
  "https://198.18.0.1/",
  "https://224.0.0.1/",
  "https://255.255.255.255/",
  // Decimal, octal and hex IPv4 forms (normalized by the URL parser).
  "https://2130706433/",
  "https://0177.0.0.1/",
  "https://0x7f000001/",
  "https://0x7f.1/",
  "https://[::1]/",
  "https://[::]/",
  "https://[::ffff:127.0.0.1]/",
  "https://[::ffff:a9fe:a9fe]/",
  "https://[::ffff:10.0.0.1]/",
  "https://[64:ff9b::a00:1]/",
  "https://[2002:a00:1::]/",
  "https://[fe80::1]/",
  "https://[fc00::1]/",
  "https://[fd12:3456::1]/",
  "https://[ff02::1]/",
  "https://localhost/",
  "https://localhost./",
  "https://api.localhost/",
];

const ALLOWED_URLS = [
  "https://8.8.8.8/",
  "https://1.1.1.1/",
  "https://100.63.255.255/",
  "https://100.128.0.0/",
  "https://172.32.0.1/",
  "https://172.15.255.255/",
  "https://192.169.0.1/",
  "https://[2606:4700:4700::1111]/",
  "https://[::ffff:8.8.8.8]/",
  "https://[64:ff9b::808:808]/",
  "https://example.com/",
  // A name that merely starts with fc/fd is not a ULA literal.
  "https://fdexample.com/",
  "https://fcc.gov/",
  "https://localhost.example.com/",
];

describe("assertUrlSafe ranges", () => {
  for (const url of BLOCKED_URLS) {
    test(`refuses ${url}`, () => {
      expect(() => assertUrlSafe(url)).toThrow(/Refusing (loopback|private)/);
    });
  }
  for (const url of ALLOWED_URLS) {
    test(`control: allows ${url}`, () => {
      expect(() => assertUrlSafe(url)).not.toThrow();
    });
  }

  test("allowPrivateHosts opens every blocked form", () => {
    for (const url of BLOCKED_URLS) {
      expect(() => assertUrlSafe(url, { allowPrivateHosts: true })).not.toThrow();
    }
  });

  test("isPrivateAddress reads raw DNS answers", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700::6810:84e5")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(false);
  });
});

type Hop = { url: string; method: string; auth: string | null; apiKey: string | null };

/** A fake network: `routes` maps a URL to a response; every request is recorded. */
function fakeNetwork(routes: Record<string, () => Response>) {
  const hops: Hop[] = [];
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    hops.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
    });
    const route = routes[url];
    return route ? route() : new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { base, hops };
}

const redirect =
  (location: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location } });

const DNS: Record<string, string[]> = {
  "public.example": ["93.184.216.34"],
  "other.example": ["93.184.216.35"],
  "internal.example": ["10.0.0.7"],
  // One public and one private answer: a rebinding setup.
  "rebind.example": ["93.184.216.34", "127.0.0.1"],
  "v6private.example": ["fd00::5"],
};
const resolve = async (host: string) => {
  const answer = DNS[host];
  if (!answer) throw new Error("ENOTFOUND");
  return answer;
};
const DENY: EgressPolicy = { allowPrivate: false, allowlist: null };

describe("createGuardedFetch", () => {
  test("allows a public name and denies names that resolve privately", async () => {
    const { base, hops } = fakeNetwork({});
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    expect((await guarded("https://public.example/x")).status).toBe(200);
    await expect(guarded("https://internal.example/x")).rejects.toThrow(/private or loopback/);
    await expect(guarded("https://v6private.example/x")).rejects.toThrow(/private or loopback/);
    await expect(guarded("http://127.0.0.1:3013/api")).rejects.toThrow(/private or loopback/);
    await expect(guarded("https://missing.example/")).rejects.toThrow(/could not resolve/);
    expect(hops.map((hop) => hop.url)).toEqual(["https://public.example/x"]);
  });

  test("DNS rebinding: any private answer denies", async () => {
    const { base, hops } = fakeNetwork({});
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    await expect(guarded("https://rebind.example/")).rejects.toThrow(/private or loopback/);
    expect(hops).toHaveLength(0);
  });

  test("a redirect to a private address is denied at the hop", async () => {
    const { base, hops } = fakeNetwork({
      "https://public.example/go": redirect("http://169.254.169.254/latest/meta-data"),
      "https://public.example/name": redirect("https://internal.example/"),
    });
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    await expect(guarded("https://public.example/go")).rejects.toThrow(/private or loopback/);
    await expect(guarded("https://public.example/name")).rejects.toThrow(/private or loopback/);
    expect(hops.map((hop) => hop.url)).toEqual([
      "https://public.example/go",
      "https://public.example/name",
    ]);
  });

  test("control: a public redirect is followed, credentials stay same-origin", async () => {
    const { base, hops } = fakeNetwork({
      "https://public.example/a": redirect("/b", 307),
      "https://public.example/b": redirect("https://other.example/c", 303),
    });
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    const response = await guarded("https://public.example/a", {
      method: "POST",
      body: "x",
      headers: { authorization: "Bearer user-token" },
    });
    expect(response.status).toBe(200);
    expect(hops).toEqual([
      { url: "https://public.example/a", method: "POST", auth: "Bearer user-token", apiKey: null },
      { url: "https://public.example/b", method: "POST", auth: "Bearer user-token", apiKey: null },
      { url: "https://other.example/c", method: "GET", auth: null, apiKey: null },
    ]);
  });

  test("stops after 5 redirects; manual mode returns the 3xx", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) routes[`https://public.example/${i}`] = redirect(`/${i + 1}`);
    const { base } = fakeNetwork(routes);
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    await expect(guarded("https://public.example/0")).rejects.toThrow(/more than 5 redirects/);
    const manual = await guarded("https://public.example/0", { redirect: "manual" });
    expect(manual.status).toBe(302);
  });

  test("the allowlist restricts public hosts and can open a private one", async () => {
    const { base } = fakeNetwork({});
    const guarded = createGuardedFetch(base, {
      policy: { allowPrivate: false, allowlist: ["internal.example", "*.public.example:443"] },
      resolve,
    });
    expect((await guarded("https://internal.example/")).status).toBe(200);
    expect((await guarded("https://api.public.example/")).status).toBe(200);
    await expect(guarded("https://public.example/")).rejects.toThrow(
      /not in SCRIPT_EGRESS_ALLOWLIST/,
    );
    await expect(guarded("https://api.public.example:8443/")).rejects.toThrow(
      /not in SCRIPT_EGRESS_ALLOWLIST/,
    );
    await expect(guarded("https://other.example/")).rejects.toThrow(
      /not in SCRIPT_EGRESS_ALLOWLIST/,
    );
  });

  test("allowPrivate and isTrusted skip the private-range check", async () => {
    const { base } = fakeNetwork({});
    const open = createGuardedFetch(base, {
      policy: { allowPrivate: true, allowlist: null },
      resolve,
    });
    expect((await open("http://127.0.0.1:3013/")).status).toBe(200);
    const trusted = createGuardedFetch(base, {
      policy: DENY,
      resolve,
      isTrusted: (url) => url.origin === "http://127.0.0.1:3013",
    });
    expect((await trusted("http://127.0.0.1:3013/api")).status).toBe(200);
    await expect(trusted("http://127.0.0.1:3014/api")).rejects.toThrow(/private or loopback/);
  });

  test("refuses non-http protocols", async () => {
    const { base } = fakeNetwork({});
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    await expect(guarded("file:///etc/hostname")).rejects.toThrow(/unsupported protocol/);
  });
});

describe("credential broker redirects", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("never carries a substituted credential to another host", async () => {
    const { base, hops } = fakeNetwork({
      "https://api.example.com/start": redirect("https://evil.example/collect"),
      "https://api.example.com/same": redirect("https://api.example.com/next", 307),
    });
    globalThis.fetch = base;
    patchFetchWithCredentialBroker([
      {
        configKey: "EXAMPLE_TOKEN",
        allowedHosts: ["api.example.com"],
        headerTemplate: "Bearer {value}",
        scope: "global",
        active: true,
        authKind: "config",
        placeholder: "[REDACTED:EXAMPLE_TOKEN]",
        value: "real-secret-value",
      },
    ]);

    await globalThis.fetch("https://api.example.com/start", {
      headers: { "x-api-key": "[REDACTED:EXAMPLE_TOKEN]" },
    });
    await globalThis.fetch("https://api.example.com/same", {
      headers: { "x-api-key": "[REDACTED:EXAMPLE_TOKEN]" },
    });

    expect(hops).toEqual([
      {
        url: "https://api.example.com/start",
        method: "GET",
        auth: null,
        apiKey: "real-secret-value",
      },
      { url: "https://evil.example/collect", method: "GET", auth: null, apiKey: null },
      {
        url: "https://api.example.com/same",
        method: "GET",
        auth: null,
        apiKey: "real-secret-value",
      },
      {
        url: "https://api.example.com/next",
        method: "GET",
        auth: null,
        apiKey: "real-secret-value",
      },
    ]);
  });
});

describe("egress config", () => {
  test("defaults deny private egress with no allowlist", () => {
    expect(scriptEgressPolicy({})).toEqual({ allowPrivate: false, allowlist: null });
    expect(
      scriptEgressPolicy({
        SCRIPT_EGRESS_ALLOW_PRIVATE: "true",
        SCRIPT_EGRESS_ALLOWLIST: " a.com, *.b.io:8443 ,",
      }),
    ).toEqual({ allowPrivate: true, allowlist: ["a.com", "*.b.io:8443"] });
  });

  test("allowlist validation", () => {
    expect(parseEgressAllowlist("")).toBeNull();
    expect(validateEgressAllowlist("")).toBeNull();
    expect(
      validateEgressAllowlist("api.example.com, *.corp.example:8443, 10.0.0.5:80, [fd00::1]:443"),
    ).toBeNull();
    expect(validateEgressAllowlist("https://api.example.com")).toContain(
      "Invalid SCRIPT_EGRESS_ALLOWLIST",
    );
    expect(validateEgressAllowlist("api.example.com/path")).toContain(
      "Invalid SCRIPT_EGRESS_ALLOWLIST",
    );
    expect(validateEgressAllowlist("*")).toContain("Invalid SCRIPT_EGRESS_ALLOWLIST");
  });
});
