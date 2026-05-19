/* script-smoke
{
  "name": "scripts-smoke-fetch-variants",
  "description": "Smoke test runtime fetch JSON/text/retry/timeout/refused variants",
  "intent": "rich scripts api smoke fetch variants",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "jsonOk": true,
      "textOk": true,
      "retryOk": true,
      "retryAttempts": 3,
      "timeoutOk": true,
      "refusedOk": true
    }
  }
}
*/

import type { ScriptContext } from "swarm-sdk";

type RuntimeFetchOptions = RequestInit & {
  retries?: number;
  timeoutMs?: number;
};

declare const Bun: {
  serve(options: { port: number; fetch(req: Request): Response | Promise<Response> }): {
    port: number;
    stop(force?: boolean): void;
  };
  sleep(ms: number): Promise<void>;
};

export default async (_args: unknown, ctx: ScriptContext) => {
  const fetchRuntime = ctx.stdlib.fetch as (
    input: string | URL | Request,
    options?: RuntimeFetchOptions,
  ) => Promise<Response>;
  let retryAttempts = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);

      if (url.pathname === "/json") {
        return Response.json({ ok: true, variant: "json" });
      }

      if (url.pathname === "/text") {
        return new Response("plain text response", {
          headers: { "content-type": "text/plain" },
        });
      }

      if (url.pathname === "/retry") {
        retryAttempts += 1;
        if (retryAttempts < 3) {
          return new Response("try again", { status: 500 });
        }
        return Response.json({ ok: true, attempts: retryAttempts });
      }

      if (url.pathname === "/timeout") {
        await Bun.sleep(250);
        return new Response("too late");
      }

      return new Response("missing", { status: 404 });
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;

  try {
    const jsonResponse = await fetchRuntime(`${baseUrl}/json`, { retries: 1, timeoutMs: 1000 });
    const json = (await jsonResponse.json()) as {
      ok?: boolean;
      variant?: string;
    };
    const textResponse = await fetchRuntime(`${baseUrl}/text`, { retries: 1, timeoutMs: 1000 });
    const text = await textResponse.text();
    const retryResponse = await fetchRuntime(`${baseUrl}/retry`, { retries: 3, timeoutMs: 1000 });
    const retry = (await retryResponse.json()) as {
      ok?: boolean;
      attempts?: number;
    };

    let timeoutOk = false;
    try {
      await fetchRuntime(`${baseUrl}/timeout`, { retries: 1, timeoutMs: 50 });
    } catch {
      timeoutOk = true;
    }

    let refusedOk = false;
    try {
      await fetchRuntime("http://127.0.0.1:9/refused", { retries: 1, timeoutMs: 250 });
    } catch {
      refusedOk = true;
    }

    return {
      jsonOk: json.ok === true && json.variant === "json",
      textOk: text === "plain text response",
      retryOk: retry.ok === true && retry.attempts === 3,
      retryAttempts,
      timeoutOk,
      refusedOk,
    };
  } finally {
    server.stop(true);
  }
};
