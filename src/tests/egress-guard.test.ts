import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { patchFetchWithCredentialBroker } from "../scripts-runtime/credential-broker";
import { scriptEgressPolicy } from "../scripts-runtime/loader";
import {
  assertUrlSafe,
  createGuardedFetch,
  type EgressPolicy,
  isPrivateAddress,
  MAX_REPLAY_BODY_BYTES,
  parseEgressAllowlist,
  pinToAddress,
  RequestBodyTooLargeError,
  validateEgressAllowlist,
} from "../utils/egress-guard";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

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

/**
 * A fake network: `routes` maps a URL to a response; every request is
 * recorded. A request pinned to an address is recorded under its Host name in
 * `hops`, and as sent (address and TLS server name) in `connects`.
 */
function fakeNetwork(routes: Record<string, () => Response>) {
  const hops: Hop[] = [];
  const connects: Array<{ url: string; serverName: string | null }> = [];
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const tls = (init as { tls?: { serverName?: string } } | undefined)?.tls;
    connects.push({ url: raw.href, serverName: tls?.serverName ?? null });
    const host = headers.get("host");
    const url = host ? `${raw.protocol}//${host}${raw.pathname}${raw.search}` : raw.href;
    hops.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
    });
    const route = routes[url];
    return route ? route() : new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { base, hops, connects };
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

  test("a checked name connects to the checked address, keeping its name for Host and TLS", async () => {
    const { base, hops, connects } = fakeNetwork({
      "https://public.example/a": redirect("http://other.example:8080/b"),
    });
    const guarded = createGuardedFetch(base, { policy: DENY, resolve });
    const response = await guarded("https://public.example/a");
    expect(response.status).toBe(200);
    expect(response.url).toBe("http://other.example:8080/b");
    expect(connects).toEqual([
      { url: "https://93.184.216.34/a", serverName: "public.example" },
      { url: "http://93.184.216.35:8080/b", serverName: null },
    ]);
    expect(hops.map((hop) => hop.url)).toEqual([
      "https://public.example/a",
      "http://other.example:8080/b",
    ]);
  });

  test("an allowlisted name and an IP literal are not re-pinned", async () => {
    const { base, connects } = fakeNetwork({});
    const guarded = createGuardedFetch(base, {
      policy: { allowPrivate: false, allowlist: ["internal.example", "93.184.216.34"] },
      resolve,
    });
    await guarded("https://internal.example/");
    await guarded("https://93.184.216.34/");
    expect(connects).toEqual([
      { url: "https://internal.example/", serverName: null },
      { url: "https://93.184.216.34/", serverName: null },
    ]);
  });
});

describe("pinToAddress over real TLS", () => {
  let dir = "";
  let ready = false;
  const servers: https.Server[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "egress-pin-"));
    // A throwaway CA and two leaf certificates, for good.test and other.test.
    const openssl = async (args: string) =>
      (await runChild(["openssl", ...args.split(" ")], { cwd: dir })).exitCode === 0;
    try {
      ready = await openssl(
        "req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 1 -subj /CN=egress-test-ca -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign",
      );
      for (const name of ["good", "other"]) {
        await writeFile(join(dir, `${name}.ext`), `subjectAltName=DNS:${name}.test\n`);
        ready &&= await openssl(
          `req -newkey rsa:2048 -nodes -keyout ${name}.key -out ${name}.csr -subj /CN=${name}.test`,
        );
        ready &&= await openssl(
          `x509 -req -in ${name}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ${name}.crt -days 1 -extfile ${name}.ext`,
        );
      }
    } catch {
      ready = false;
    }
  }, CHILD_PROCESS_TEST_BUDGET_MS);

  afterAll(async () => {
    for (const server of servers) server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function tlsServer(cert: string) {
    const seen: Array<{ sni: string | false; host: string | undefined }> = [];
    const server = https.createServer(
      {
        key: await readFile(join(dir, `${cert}.key`)),
        cert: await readFile(join(dir, `${cert}.crt`)),
      },
      (req, res) => {
        seen.push({ sni: (req.socket as TLSSocket).servername, host: req.headers.host });
        res.end("ok");
      },
    );
    servers.push(server);
    const port = await listenOnFreePort(server, "127.0.0.1");
    return { port, seen };
  }

  test("connects to the address with the name's Host, SNI and certificate check", async () => {
    expect(ready).toBe(true); // openssl created the test certificates
    const ca = await readFile(join(dir, "ca.crt"), "utf8");
    const good = await tlsServer("good");
    const url = new URL(`https://good.test:${good.port}/x`);
    const response = await fetch(...pinToAddress(url, "127.0.0.1", { tls: { ca } } as RequestInit));
    expect(await response.text()).toBe("ok");
    expect(good.seen).toEqual([{ sni: "good.test", host: `good.test:${good.port}` }]);

    // The certificate is checked against the name, not the address.
    const other = await tlsServer("other");
    const wrong = new URL(`https://good.test:${other.port}/x`);
    await expect(
      fetch(...pinToAddress(wrong, "127.0.0.1", { tls: { ca } } as RequestInit)),
    ).rejects.toThrow();
    expect(other.seen).toHaveLength(0);
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

  test("the broker and the guard share one 5-hop redirect budget", async () => {
    // public.example (credential substituted) -> other.example/1 -> ... -> /<hops>
    const chain = (hops: number) => {
      const routes: Record<string, () => Response> = {
        "https://public.example/start": redirect("https://other.example/1"),
      };
      for (let i = 1; i < hops; i++) routes[`https://other.example/${i}`] = redirect(`/${i + 1}`);
      return routes;
    };
    const run = async (hops: number) => {
      const { base } = fakeNetwork(chain(hops));
      globalThis.fetch = createGuardedFetch(base, { policy: DENY, resolve });
      patchFetchWithCredentialBroker([
        {
          configKey: "EXAMPLE_TOKEN",
          allowedHosts: ["public.example"],
          headerTemplate: "Bearer {value}",
          scope: "global",
          active: true,
          authKind: "config",
          placeholder: "[REDACTED:EXAMPLE_TOKEN]",
          value: "real-secret-value",
        },
      ]);
      return globalThis.fetch("https://public.example/start", {
        headers: { authorization: "Bearer [REDACTED:EXAMPLE_TOKEN]" },
      });
    };
    expect((await run(5)).status).toBe(200);
    await expect(run(6)).rejects.toThrow(/5 redirects/);
  });
});

describe("redirect bodies over real fetch", () => {
  const originalFetch = globalThis.fetch;
  const received: Array<{ path: string; method: string; body: string; apiKey: string | null }> = [];
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        received.push({
          path: pathname,
          method: req.method,
          body: await req.text(),
          apiKey: req.headers.get("x-api-key"),
        });
        if (pathname === "/307")
          return new Response(null, { status: 307, headers: { location: "/end" } });
        if (pathname === "/308")
          return new Response(null, { status: 308, headers: { location: "/end" } });
        if (pathname === "/303")
          return new Response(null, { status: 303, headers: { location: "/end" } });
        return new Response("done");
      },
    });
  });
  afterAll(() => {
    server?.stop(true);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    received.length = 0;
  });

  const BINDING = {
    configKey: "EXAMPLE_TOKEN",
    allowedHosts: ["127.0.0.1"],
    headerTemplate: "{value}",
    scope: "global" as const,
    active: true,
    authKind: "config" as const,
    placeholder: "[REDACTED:EXAMPLE_TOKEN]",
    value: "real-secret-value",
  };
  const post = (path: string) =>
    new Request(`http://127.0.0.1:${server?.port}${path}`, {
      method: "POST",
      body: "payload",
      headers: { "x-api-key": "[REDACTED:EXAMPLE_TOKEN]", "content-type": "text/plain" },
    });

  for (const layers of ["broker", "guard + broker"] as const) {
    test(`${layers}: a Request POST body is sent again on 307/308 and dropped on 303`, async () => {
      if (layers === "guard + broker") {
        globalThis.fetch = createGuardedFetch(originalFetch, {
          policy: { allowPrivate: true, allowlist: null },
        });
      }
      patchFetchWithCredentialBroker([BINDING]);
      for (const status of ["307", "308"]) {
        const response = await globalThis.fetch(post(`/${status}`));
        expect(await response.text()).toBe("done");
      }
      const seeOther = await globalThis.fetch(post("/303"));
      expect(await seeOther.text()).toBe("done");
      const secret = BINDING.value;
      expect(received).toEqual([
        { path: "/307", method: "POST", body: "payload", apiKey: secret },
        { path: "/end", method: "POST", body: "payload", apiKey: secret },
        { path: "/308", method: "POST", body: "payload", apiKey: secret },
        { path: "/end", method: "POST", body: "payload", apiKey: secret },
        { path: "/303", method: "POST", body: "payload", apiKey: secret },
        { path: "/end", method: "GET", body: "", apiKey: secret },
      ]);
    });
  }

  test("guard alone: a Request POST body is sent again on 307", async () => {
    const guarded = createGuardedFetch(originalFetch, {
      policy: { allowPrivate: true, allowlist: null },
    });
    const response = await guarded(post("/307"));
    expect(await response.text()).toBe("done");
    expect(received.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/307", body: "payload" },
      { path: "/end", body: "payload" },
    ]);
  });
});

describe("redirect body collection", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const URL_ = "https://api.example.com/upload";
  const sent: number[] = [];
  // Set per test: the first request answers with this redirect, and the
  // hook runs when a request starts, before its body is read.
  let redirectFirst: number | null = null;
  let onRequest = () => {};
  const base = (async (_input: string | URL | Request, init?: RequestInit) => {
    onRequest();
    sent.push(init?.body ? (await new Response(init.body).arrayBuffer()).byteLength : 0);
    if (redirectFirst !== null && sent.length === 1) {
      return new Response(null, { status: redirectFirst, headers: { location: "/next" } });
    }
    return new Response("ok");
  }) as typeof fetch;
  afterEach(() => {
    sent.length = 0;
    redirectFirst = null;
    onRequest = () => {};
  });

  // Each layer gets a streamed POST body; the broker takes its substituting path.
  const LAYERS = {
    broker: () => {
      globalThis.fetch = base;
      patchFetchWithCredentialBroker([
        {
          configKey: "EXAMPLE_TOKEN",
          allowedHosts: ["api.example.com"],
          headerTemplate: "{value}",
          scope: "global",
          active: true,
          authKind: "config",
          placeholder: "[REDACTED:EXAMPLE_TOKEN]",
          value: "real-secret-value",
        },
      ]);
      return globalThis.fetch;
    },
    guard: () => createGuardedFetch(base, { policy: { allowPrivate: true, allowlist: null } }),
  };
  const upload = (doFetch: typeof fetch, body: ReadableStream, signal?: AbortSignal) =>
    doFetch(URL_, {
      method: "POST",
      body,
      signal,
      headers: { "x-api-key": "[REDACTED:EXAMPLE_TOKEN]" },
      duplex: "half",
    } as RequestInit);
  const settled = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => "resolved",
        (error: Error) => error,
      ),
      Bun.sleep(1_000).then(() => "pending"),
    ]);

  for (const [layer, make] of Object.entries(LAYERS)) {
    test(`${layer}: an abort during body collection rejects and cancels the source`, async () => {
      let cancelReason: unknown = null;
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel(reason) {
          cancelReason = reason;
        },
      });
      const controller = new AbortController();
      const pending = upload(make(), source, controller.signal);
      await Bun.sleep(20);
      controller.abort();
      const outcome = await settled(pending);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe("AbortError");
      expect((cancelReason as Error | null)?.name).toBe("AbortError");
    });

    // Chunks of a quarter of the cap; past the cap the source waits for the
    // request to start, so a layer that read the whole body first never sends.
    const CHUNK = MAX_REPLAY_BODY_BYTES / 4;
    const TOTAL_CHUNKS = 64;
    const overCapSource = () => {
      let requestStarted = () => {};
      const started = new Promise<void>((resolve) => {
        requestStarted = resolve;
      });
      onRequest = () => requestStarted();
      let pulled = 0;
      return new ReadableStream({
        async pull(controller) {
          if (pulled === TOTAL_CHUNKS) return controller.close();
          if (pulled * CHUNK > MAX_REPLAY_BODY_BYTES) await started;
          controller.enqueue(new Uint8Array(CHUNK));
          pulled++;
        },
      });
    };

    test(`${layer}: a body over the cap is sent as it is read, not held first`, async () => {
      expect(await settled(upload(make(), overCapSource()))).toBe("resolved");
      expect(sent).toEqual([CHUNK * TOTAL_CHUNKS]);
    });

    test(`${layer}: a body over the cap cannot follow a 307/308`, async () => {
      for (const status of [307, 308]) {
        sent.length = 0;
        redirectFirst = status;
        const outcome = await settled(upload(make(), overCapSource()));
        expect(outcome).toBeInstanceOf(RequestBodyTooLargeError);
        expect((outcome as Error).message).toContain("1 MiB");
        expect(sent).toEqual([CHUNK * TOTAL_CHUNKS]);
      }
    });

    test(`${layer}: a body over the cap still follows a 303 as a GET`, async () => {
      redirectFirst = 303;
      expect(await settled(upload(make(), overCapSource()))).toBe("resolved");
      expect(sent).toEqual([CHUNK * TOTAL_CHUNKS, 0]);
    });

    test(`${layer}: a failing source rejects with its error and releases the stream`, async () => {
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.error(new Error("source broke"));
        },
      });
      const outcome = await settled(upload(make(), source));
      expect((outcome as Error).message).toBe("source broke");
      expect(source.locked).toBe(false);
    });

    // A source whose cancel cleanup stays pending until the test ends it.
    const slowCancelSource = (pull: (controller: ReadableStreamDefaultController) => void) => {
      let finishCleanup = () => {};
      const state = { cancelled: false, cleanedUp: false };
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const source = new ReadableStream({
        pull,
        async cancel() {
          state.cancelled = true;
          await cleanup;
          state.cleanedUp = true;
        },
      });
      return { source, state, finishCleanup: () => finishCleanup() };
    };

    test(`${layer}: control: a body at the cap is sent again on a 307`, async () => {
      redirectFirst = 307;
      let pulled = 0;
      const source = new ReadableStream({
        pull(controller) {
          if (pulled++ < 4) controller.enqueue(new Uint8Array(CHUNK));
          else controller.close();
        },
      });
      expect(await settled(upload(make(), source))).toBe("resolved");
      expect(sent).toEqual([MAX_REPLAY_BODY_BYTES, MAX_REPLAY_BODY_BYTES]);
    });

    test(`${layer}: an already-aborted signal rejects before slow source cleanup ends`, async () => {
      sent.length = 0;
      const { source, state, finishCleanup } = slowCancelSource((controller) => {
        controller.enqueue(new Uint8Array(8));
      });
      try {
        const outcome = await settled(upload(make(), source, AbortSignal.abort()));
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).name).toBe("AbortError");
        expect(state.cancelled).toBe(true);
        expect(state.cleanedUp).toBe(false);
        expect(source.locked).toBe(false);
        expect(sent).toEqual([]);
      } finally {
        finishCleanup();
      }
    });
  }
});

// The name this machine is called by: the system resolver answers with one of
// its own (private) addresses, so a server on all interfaces receives it.
const machineName = hostname();
const machineAnswer = await lookup(machineName).then(
  (record) => record.address,
  () => null,
);

describe("DNS answers at check time and connect time", () => {
  test.skipIf(!machineAnswer || !isPrivateAddress(machineAnswer))(
    "the connection uses the checked answer, not a fresh lookup",
    async () => {
      let hits = 0;
      const server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch() {
          hits++;
          return new Response("reached");
        },
      });
      try {
        const url = `http://${machineName}:${server.port}/`;
        // Control: the system resolver sends a plain fetch of this name to the server.
        expect(await (await fetch(url)).text()).toBe("reached");
        expect(hits).toBe(1);

        // The check sees a public (documentation-range) answer; a fresh lookup
        // at connect time would reach the private server instead.
        const guarded = createGuardedFetch(fetch, {
          policy: DENY,
          resolve: async () => ["192.0.2.10"],
        });
        await expect(guarded(url, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
        expect(hits).toBe(1);
      } finally {
        server.stop(true);
      }
    },
  );
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
