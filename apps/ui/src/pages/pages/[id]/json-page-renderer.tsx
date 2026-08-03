/**
 * JsonPageRenderer — renders a page whose body is a `@json-render/core` spec.
 * Mounted from `ui/src/pages/pages/[id]/page.tsx` when the page's
 * `contentType === "application/json"`.
 *
 * Step-7 scope (db-backed-pages plan):
 *   - Uses the swarm component catalog (Container, Card, Heading, Text,
 *     Button, Metric, Alert — plus the Badge/Table/Form additions shared with
 *     the swarm-apps runtime), which now lives in `@/lib/json-render`.
 *   - Registers TWO custom action types:
 *       - `swarm.sdk` (`{sdk, args}`) — dispatch to in-SPA `SwarmSDK`.
 *       - `swarm.call` (`{method, endpoint, body?}`) — raw HTTP escape hatch.
 *     The catalog's `app.mutate` / `app.refresh` actions belong to the
 *     swarm-apps runtime (`/apps/:id`), which owns an app definition and a
 *     query cache; on this surface they are registered as inert stubs that
 *     surface a "not available" error instead of silently no-opping.
 *   - Both action types use the viewer's bearer (`getConfig().apiKey`). No
 *     page-session cookie / `/@swarm/api/*` proxy is involved — per
 *     `root.md` "What We're NOT Doing".
 *   - On a malformed JSON body, surfaces a friendly error with the raw body.
 *
 * `needs_credentials` is reserved but not surfaced in the UI here — see
 * `root.md` for the deferred-credential-prompt rationale.
 */

import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/react";
import { AlertCircle } from "lucide-react";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { AlertCallout } from "@/components/ui/alert-callout";
import { createSwarmActionHandlers, swarmCatalog, swarmComponents } from "@/lib/json-render";

// Re-exported for backwards compatibility with existing importers of the
// action schemas / catalog (they now live in `@/lib/json-render`).
export { swarmCallActionSchema, swarmCatalog, swarmSdkActionSchema } from "@/lib/json-render";

// ─── Renderer entry ────────────────────────────────────────────────────────

export interface JsonPageRendererProps {
  body: string;
  /** Test-injection: override `fetch` so swarm.call/swarm.sdk dispatch is mockable. */
  fetchImpl?: typeof fetch;
}

interface ActionState {
  lastResponse: unknown;
  actionError: string | null;
}

export function JsonPageRenderer({ body, fetchImpl }: JsonPageRendererProps) {
  const [state, setState] = useState<ActionState>({
    lastResponse: undefined,
    actionError: null,
  });
  // Refs so the action factory closes over the latest state pointer w/o
  // capturing a stale closure (matches the @json-render docs' ref pattern).
  const stateRef = useRef(state);
  const setStateRef = useRef(setState);
  stateRef.current = state;
  setStateRef.current = setState;

  // Compute spec + registry + handlers. `registry` is stable across re-renders
  // for a given body — handlers are recomputed per render so they pick up
  // the latest fetchImpl override (test injection).
  type CompiledOk = {
    kind: "ok";
    spec: unknown;
    registry: ReturnType<typeof defineRegistry>["registry"];
    handlers: Record<string, (params: Record<string, unknown>) => Promise<void>>;
  };
  type CompiledErr = { kind: "err"; parseError: string };
  const compiled = useMemo<CompiledOk | CompiledErr>(() => {
    let spec: unknown;
    try {
      spec = JSON.parse(body);
    } catch (e) {
      return {
        kind: "err",
        parseError: e instanceof Error ? e.message : "Unknown parse error",
      };
    }
    const updateState = (patch: Partial<ActionState>) => {
      setStateRef.current?.((prev) => ({ ...prev, ...patch }));
    };
    const swarmActions = createSwarmActionHandlers({
      fetchImpl,
      onResponse: (result) => updateState({ lastResponse: result }),
      onError: (actionError) => updateState({ actionError }),
    });
    const unsupported = (action: string) => async () => {
      updateState({
        actionError: `${action} is only available inside a swarm app (/apps/:id).`,
      });
    };
    const { registry, handlers } = defineRegistry(swarmCatalog, {
      components: swarmComponents,
      actions: {
        ...swarmActions,
        "app.mutate": unsupported("app.mutate"),
        "app.refresh": unsupported("app.refresh"),
        "app.action": unsupported("app.action"),
        "app.navigate": unsupported("app.navigate"),
      },
    });
    // handlers factory: pass setState/state getters that the registered
    // action fns ignore — our action fns close over `updateState` directly
    // (the catalog actions don't write into the StateProvider's state model).
    const handlerMap = handlers(
      () => () => {
        /* no-op SetState — we manage UI state via updateState above */
      },
      () => ({}),
    );
    return { kind: "ok", spec, registry, handlers: handlerMap };
  }, [body, fetchImpl]);

  if (compiled.kind === "err") {
    return (
      <div className="space-y-3" data-testid="json-page-renderer-error">
        <AlertCallout tone="error" icon={AlertCircle} title="Page body is not valid JSON">
          <p className="mb-2">The page renderer couldn't parse this body. Raw body:</p>
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-2 text-xs">
            {body}
          </pre>
          <p className="mt-2 text-xs">
            Parser said: <code className="font-mono">{compiled.parseError}</code>
          </p>
        </AlertCallout>
      </div>
    );
  }

  // After the `kind === "err"` early-return above, `compiled` is narrowed to
  // the success variant by TS's flow analysis.
  const { spec, registry, handlers } = compiled;

  let renderedSpec: React.ReactNode;
  try {
    renderedSpec = <Renderer spec={spec as never} registry={registry} />;
  } catch (e) {
    return (
      <AlertCallout tone="error" icon={AlertCircle} title="Failed to render JSON spec">
        <p>{e instanceof Error ? e.message : String(e)}</p>
      </AlertCallout>
    );
  }

  return (
    <div className="space-y-4" data-testid="json-page-renderer">
      {state.actionError && (
        <AlertCallout tone="error" icon={AlertCircle} title="Action failed">
          {state.actionError}
        </AlertCallout>
      )}
      <StateProvider>
        <VisibilityProvider>
          <ActionProvider handlers={handlers}>{renderedSpec}</ActionProvider>
        </VisibilityProvider>
      </StateProvider>
      {state.lastResponse !== undefined && (
        <details className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Last action response</summary>
          <pre className="mt-2 max-h-48 overflow-auto" data-testid="last-action-response">
            {JSON.stringify(state.lastResponse, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
