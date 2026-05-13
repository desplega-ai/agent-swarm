/**
 * JsonPageRenderer — renders a page whose body is a `@json-render/core` spec.
 * Mounted from `ui/src/pages/pages/[id]/page.tsx` when the page's
 * `contentType === "application/json"`.
 *
 * Step-7 scope (db-backed-pages plan):
 *   - Defines a swarm-specific component catalog (Container, Card, Heading,
 *     Text, Button, Metric, Alert) — minimal but expressive enough for the
 *     status/report use cases pages targets.
 *   - Defines TWO custom action types:
 *       - `swarm.sdk` (`{sdk, args}`) — dispatch to in-SPA `SwarmSDK`.
 *       - `swarm.call` (`{method, endpoint, body?}`) — raw HTTP escape hatch.
 *   - Both action types use the viewer's bearer (`getConfig().apiKey`). No
 *     page-session cookie / `/@swarm/api/*` proxy is involved — per
 *     `root.md` "What We're NOT Doing".
 *   - On a malformed JSON body, surfaces a friendly error with the raw body.
 *
 * `needs_credentials` is reserved but not surfaced in the UI here — see
 * `root.md` for the deferred-credential-prompt rationale.
 */

import { defineCatalog } from "@json-render/core";
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  schema,
  VisibilityProvider,
} from "@json-render/react";
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle, Info } from "lucide-react";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "@/components/ui/card";
import { getConfig } from "@/lib/config";
import { makeSwarmSDK, SWARM_SDK_METHODS, type SwarmSdkMethod } from "@/lib/swarm-sdk";

// ─── Action schemas (also exported for the discovery endpoint mirror) ───────

export const swarmSdkActionSchema = z.object({
  sdk: z.enum(SWARM_SDK_METHODS as unknown as [SwarmSdkMethod, ...SwarmSdkMethod[]]),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const swarmCallActionSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  endpoint: z.string(),
  body: z.record(z.string(), z.unknown()).optional(),
});

// ─── Component catalog ──────────────────────────────────────────────────────

const containerProps = z.object({
  direction: z.enum(["row", "column"]).optional(),
  gap: z.enum(["none", "sm", "md", "lg"]).optional(),
});

const cardProps = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

const headingProps = z.object({
  text: z.string(),
  level: z.enum(["h1", "h2", "h3"]).optional(),
});

const textProps = z.object({
  content: z.string(),
  tone: z.enum(["default", "muted"]).optional(),
});

const buttonProps = z.object({
  label: z.string(),
  variant: z.enum(["default", "secondary", "outline", "ghost", "destructive"]).optional(),
});

const metricProps = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
});

const alertProps = z.object({
  message: z.string(),
  tone: z.enum(["info", "success", "warning", "error"]).optional(),
  title: z.string().optional(),
});

export const swarmCatalog = defineCatalog(schema, {
  components: {
    Container: {
      props: containerProps,
      slots: ["default"],
      description: "Layout container (flex row or column with gap).",
    },
    Card: {
      props: cardProps,
      slots: ["default"],
      description: "Bordered card with optional title and description.",
    },
    Heading: {
      props: headingProps,
      description: "Text heading (h1/h2/h3).",
    },
    Text: {
      props: textProps,
      description: "Paragraph text.",
    },
    Button: {
      props: buttonProps,
      description: "Interactive button. Wire to actions via `on.press`.",
    },
    Metric: {
      props: metricProps,
      description: "Single label/value tile for status pages.",
    },
    Alert: {
      props: alertProps,
      description: "Status-toned inline alert.",
    },
  },
  actions: {
    "swarm.sdk": {
      params: swarmSdkActionSchema,
      description: "Invoke a method on the in-SPA Swarm SDK with the viewer's bearer.",
    },
    "swarm.call": {
      params: swarmCallActionSchema,
      description: "Raw HTTP call to a swarm `/api/*` endpoint with the viewer's bearer.",
    },
  },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getAbsoluteApiUrl(): string {
  const config = getConfig();
  return (config.apiUrl || "http://localhost:3013").replace(/\/+$/, "");
}

function getBearerHeaders(): Record<string, string> {
  const config = getConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

// ─── React components ──────────────────────────────────────────────────────

const gapClass: Record<NonNullable<z.infer<typeof containerProps>["gap"]>, string> = {
  none: "gap-0",
  sm: "gap-2",
  md: "gap-4",
  lg: "gap-6",
};

const headingClass: Record<NonNullable<z.infer<typeof headingProps>["level"]>, string> = {
  h1: "text-2xl font-bold tracking-tight",
  h2: "text-xl font-semibold tracking-tight",
  h3: "text-lg font-semibold",
};

const alertTone: Record<
  NonNullable<z.infer<typeof alertProps>["tone"]>,
  { tone: "info" | "success" | "warning" | "error"; icon: typeof Info }
> = {
  info: { tone: "info", icon: Info },
  success: { tone: "success", icon: CheckCircle },
  warning: { tone: "warning", icon: AlertTriangle },
  error: { tone: "error", icon: AlertCircle },
};

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
    const apiUrl = getAbsoluteApiUrl();
    const updateState = (patch: Partial<ActionState>) => {
      setStateRef.current?.((prev) => ({ ...prev, ...patch }));
    };
    const { registry, handlers } = defineRegistry(swarmCatalog, {
      components: {
        Container: ({ props, children }) => {
          const direction = props.direction ?? "column";
          const gap = props.gap ?? "md";
          return (
            <div
              className={`flex ${direction === "row" ? "flex-row" : "flex-col"} ${gapClass[gap]}`}
            >
              {children}
            </div>
          );
        },
        Card: ({ props, children }) => (
          <UiCard>
            {(props.title || props.description) && (
              <CardHeader>
                {props.title && <CardTitle>{props.title}</CardTitle>}
                {props.description && <CardDescription>{props.description}</CardDescription>}
              </CardHeader>
            )}
            <CardContent>{children}</CardContent>
          </UiCard>
        ),
        Heading: ({ props }) => {
          const level = props.level ?? "h2";
          if (level === "h1") return <h1 className={headingClass.h1}>{props.text}</h1>;
          if (level === "h3") return <h3 className={headingClass.h3}>{props.text}</h3>;
          return <h2 className={headingClass.h2}>{props.text}</h2>;
        },
        Text: ({ props }) => (
          <p
            className={
              props.tone === "muted" ? "text-sm text-muted-foreground" : "text-sm text-foreground"
            }
          >
            {props.content}
          </p>
        ),
        Button: ({ props, emit }) => (
          <Button variant={props.variant ?? "default"} onClick={() => emit("press")}>
            {props.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        ),
        Metric: ({ props }) => (
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {props.label}
            </span>
            <span className="text-2xl font-semibold text-foreground">{String(props.value)}</span>
          </div>
        ),
        Alert: ({ props }) => {
          const tone = alertTone[props.tone ?? "info"];
          return (
            <AlertCallout tone={tone.tone} icon={tone.icon} title={props.title}>
              {props.message}
            </AlertCallout>
          );
        },
      },
      actions: {
        "swarm.sdk": async (params) => {
          updateState({ actionError: null });
          if (!params) return;
          const sdk = makeSwarmSDK({
            apiUrl,
            getHeaders: getBearerHeaders,
            fetch: fetchImpl,
          });
          try {
            const result = await sdk.invoke(params.sdk as SwarmSdkMethod, params.args ?? {});
            updateState({ lastResponse: result });
          } catch (e) {
            updateState({ actionError: e instanceof Error ? e.message : String(e) });
          }
        },
        "swarm.call": async (params) => {
          updateState({ actionError: null });
          if (!params) return;
          try {
            const f = fetchImpl ?? fetch.bind(globalThis);
            const res = await f(`${apiUrl}${params.endpoint}`, {
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
            const result = { status: res.status, body: parsedBody };
            updateState({ lastResponse: result });
            if (!res.ok) {
              updateState({
                actionError: `swarm.call ${params.method} ${params.endpoint}: ${res.status}`,
              });
            }
          } catch (e) {
            updateState({ actionError: e instanceof Error ? e.message : String(e) });
          }
        },
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
