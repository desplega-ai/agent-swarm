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

export interface SwarmActionCallbacks {
  /** Test-injection: override `fetch` so dispatch is mockable. */
  fetchImpl?: typeof fetch;
  onResponse: (result: unknown) => void;
  onError: (message: string | null) => void;
}

export function createSwarmActionHandlers({
  fetchImpl,
  onResponse,
  onError,
}: SwarmActionCallbacks) {
  return {
    "swarm.sdk": async (params: SwarmSdkActionParams | undefined) => {
      onError(null);
      if (!params) return;
      const sdk = makeSwarmSDK({
        apiUrl: getAbsoluteApiUrl(),
        getHeaders: getBearerHeaders,
        fetch: fetchImpl,
      });
      try {
        const result = await sdk.invoke(params.sdk as SwarmSdkMethod, params.args ?? {});
        onResponse(result);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    "swarm.call": async (params: SwarmCallActionParams | undefined) => {
      onError(null);
      if (!params) return;
      try {
        const f = fetchImpl ?? fetch.bind(globalThis);
        const res = await f(`${getAbsoluteApiUrl()}${params.endpoint}`, {
          method: params.method,
          headers: getBearerHeaders(),
          body: params.body ? JSON.stringify(params.body) : undefined,
        });
        const text = await res.text();
        let parsedBody: unknown = text;
        if (text) {
          try {
            parsedBody = JSON.parse(text);
          } catch {
            /* keep as text */
          }
        }
        onResponse({ status: res.status, body: parsedBody });
        if (!res.ok) {
          onError(`swarm.call ${params.method} ${params.endpoint}: ${res.status}`);
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
