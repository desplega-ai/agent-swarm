import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useLayoutEffect } from "react";

/*
 * The DOM and the fake API behind the AI providers tab tests
 * (`ai-*-tab.test.tsx`). Import it first, then `await installAiTabDom(...)`
 * with the file's `bun:test` hooks (this file is in the app build, which has
 * no `bun:test` types): the module loads once per process, but each file
 * needs its own DOM and hooks. The DOM is registered before react-dom loads,
 * and removed after each file so other files keep their server-render
 * environment. The `@/` aliases that `bun test` does not read map to the
 * real modules (each mock keeps every export).
 */

/** The `bun:test` functions the helper needs. */
export interface TestHooks {
  mock: { module: (path: string, factory: () => unknown) => void };
  beforeEach: (fn: () => void) => void;
  afterEach: (fn: () => void) => void;
  afterAll: (fn: () => Promise<void>) => void;
}

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const ALIASES = [
  "lib/agent-runtime-models",
  "lib/azure-embeddings",
  "components/ui/label",
  "components/ui/settings-row",
  "components/shared/setup-chip",
  "components/shared/setup-card",
  "api/hooks/use-models-catalog",
  "components/shared/fade-in",
  "components/shared/collapsible-section",
  "components/shared/animated-reveal",
  "lib/deployment-config",
  "lib/connection-url-params",
  "hooks/use-config",
  "components/ui/textarea",
  "components/ui/spinner",
  "lib/use-can",
  "lib/semver",
  "api/hooks/use-feature-gate",
  "api/hooks/status-query",
  "api/client",
  "api/hooks/use-config-api",
  "api/hooks/use-integrations-meta",
  "api/hooks/use-onboarding",
  "api/hooks/use-pool-keys",
  "components/integrations/memory-embeddings-section",
  "components/kibo-ui/spinner",
  "components/onboarding/autosave-secret-field",
  "components/onboarding/onboarding-redirect",
  "components/onboarding/save-indicator",
  "components/providers/provider-logo",
  "components/shared/brand-logo",
  "components/shared/empty-state",
  "components/shared/key-status-pill",
  "components/shared/model-logo",
  "components/shared/provider-icon",
  "components/shared/secret-input",
  "components/shared/status-icon",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/info-tip",
  "components/ui/input",
  "components/ui/segmented-control",
  "components/ui/select",
  "components/ui/sheet",
  "components/ui/skeleton",
  "components/ui/tooltip",
  "hooks/use-autosave",
  "lib/ai-providers",
  "lib/config",
  "lib/env-presence-batch",
  "lib/model-vendor",
  "lib/system-one-hosts",
  "lib/transcription-status",
  "lib/utils",
  "pages/setup/steps/step-memory",
];

let aliased = false;
let TooltipProvider: typeof import("../../components/ui/tooltip").TooltipProvider;

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
export const routes: Record<string, Handler> = {};
export const calls: Array<{ method: string; path: string; body: unknown }> = [];

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

/** The DOM, the stored connection and the fake API for one test file. */
export async function installAiTabDom({ mock, beforeEach, afterEach, afterAll }: TestHooks) {
  if (!aliased) {
    aliased = true;
    mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
    for (const path of ALIASES) mock.module(`@/${path}`, () => require(`../../${path}`));
    ({ TooltipProvider } = await import("../../components/ui/tooltip"));
  }
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  // The API client sends nothing without a stored connection.
  const { addConnection } = await import("../../lib/config");
  addConnection({ name: "test", apiUrl: "http://api.test", apiKey: "test-key" });
  beforeEach(() => {
    for (const key of Object.keys(routes)) delete routes[key];
    calls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://api.test");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) return json({ error: `no route ${method} ${url.pathname}` }, 404);
      return handler(url, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    document.body.innerHTML = "";
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}

/** `GET /api/config/env-presence`: the asked keys, true when listed in `set`. */
export function presenceRoute(set: string[]): Handler {
  return (url) => {
    const keys = (url.searchParams.get("keys") ?? "").split(",").filter(Boolean);
    return json({ presence: Object.fromEntries(keys.map((k) => [k, set.includes(k)])) });
  };
}

/** A global config row as `GET /api/config` returns it. */
export function configRow(key: string, value: string, isSecret = false) {
  return {
    id: `id-${key}`,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret,
    envPath: null,
    description: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    lastUpdatedAt: "2026-11-04T00:00:00.000Z",
  };
}

export async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TooltipProvider>{node}</TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { cleanup: () => act(async () => root.unmount()) };
}

/** Let fetches and React Query settle. */
export async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

export function text(): string {
  return document.body.textContent ?? "";
}

export function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

export async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

export async function press(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
