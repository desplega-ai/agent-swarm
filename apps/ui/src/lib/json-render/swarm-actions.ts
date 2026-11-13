/**
 * `swarm.sdk` / `swarm.call` action implementations, moved verbatim (modulo
 * the injected `onResponse` / `onError` callbacks) out of
 * `pages/pages/[id]/json-page-renderer.tsx` so the swarm-apps runtime can
 * register the same two escape hatches.
 *
 * Both use the viewer's bearer (`getConfig().apiKey`). No page-session cookie
 * / `/@swarm/api/*` proxy is involved.
 */

import type { z } from "zod";
import { getConfig } from "@/lib/config";
import { makeSwarmSDK, type SwarmSdkMethod } from "@/lib/swarm-sdk";
import type { swarmCallActionSchema, swarmSdkActionSchema } from "./catalog";
import { haltChain } from "./chain-halt";

export type SwarmSdkActionParams = z.infer<typeof swarmSdkActionSchema>;
export type SwarmCallActionParams = z.infer<typeof swarmCallActionSchema>;

/** Absolute API origin — the JSON-render path never relies on the dev proxy. */
export function getAbsoluteApiUrl(): string {
  const config = getConfig();
  return (config.apiUrl || "http://localhost:3013").replace(/\/+$/, "");
}

export function getBearerHeaders(): Record<string, string> {
  const config = getConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

/** A `/`-rooted path; `//` and `/\` are rejected as protocol-relative forms. */
function isApiPath(endpoint: unknown): endpoint is string {
  return typeof endpoint === "string" && /^\/(?![/\\])/.test(endpoint);
}

export interface SwarmActionCallbacks {
  /** Test-injection: override `fetch` so dispatch is mockable. */
  fetchImpl?: typeof fetch;
  onResponse: (result: unknown) => void;
  /** Clears (null) or sets the surface's error banner. */
  onError: (message: string | null) => void;
  /**
   * Reports a failed call before the chain halts. Defaults to `onError`; the
   * app runtime passes an error toast instead.
   */
  onFailure?: (message: string) => void;
}

export function createSwarmActionHandlers({
  fetchImpl,
  onResponse,
  onError,
  onFailure,
}: SwarmActionCallbacks) {
  const fail = (message: string): never => haltChain(message, onFailure ?? onError);
  return {
    "swarm.sdk": async (params: SwarmSdkActionParams | undefined) => {
      onError(null);
      if (!params) return;
      const sdk = makeSwarmSDK({
        apiUrl: getAbsoluteApiUrl(),
        getHeaders: getBearerHeaders,
        fetch: fetchImpl,
      });
      let result: unknown;
      try {
        result = await sdk.invoke(params.sdk as SwarmSdkMethod, params.args ?? {});
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      onResponse(result);
    },
    "swarm.call": async (params: SwarmCallActionParams | undefined) => {
      onError(null);
      if (!params) return;
      // The endpoint is appended to the API URL and sent with the viewer's
      // bearer, so it must be a path: anything else can change the host.
      if (!isApiPath(params.endpoint)) {
        return fail(`swarm.call endpoint must be a path starting with "/": ${params.endpoint}`);
      }
      let res: Response;
      let text: string;
      try {
        const f = fetchImpl ?? fetch.bind(globalThis);
        res = await f(`${getAbsoluteApiUrl()}${params.endpoint}`, {
          method: params.method,
          headers: getBearerHeaders(),
          body: params.body ? JSON.stringify(params.body) : undefined,
        });
        text = await res.text();
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      let parsedBody: unknown = text;
      if (text) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          /* keep as text */
        }
      }
      onResponse({ status: res.status, body: parsedBody });
      if (!res.ok) fail(`swarm.call ${params.method} ${params.endpoint}: ${res.status}`);
    },
  };
}
