import { useActions, useStateStore } from "@json-render/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { lazy, type ReactNode, type RefObject, Suspense, useEffect, useId, useRef } from "react";
import { api } from "@/api/client";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/hooks/use-theme";
import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import {
  type AppContextActionResult,
  type AppContextSnapshot,
  appFrameQuery,
  createAppContextHost,
  frameParams,
} from "./app-context-bridge";
import { useAppScopeId } from "./app-scope";
import { OUTCOME_PARAM } from "./assemble";
import { useJsonRenderTheme } from "./theme-scope";

// Lazy: the page route imports the JSON page renderer, which imports this catalog.
const PagePreviewBody = lazy(() =>
  import("@/pages/pages/[id]/page").then((m) => ({ default: m.PagePreviewBody })),
);

/** Same shape the page route accepts as an id (slugs are not resolved here). */
export const PAGE_FRAME_ID = /^[a-f0-9]{32}$/i;
/** Width of the `device: "mobile"` frame, a common phone viewport. */
export const PAGE_FRAME_MOBILE_WIDTH = 390;
// shortcut: polls the whole page row (body included) every 3 s, upgrade to a page change stream once one exists.
export const PAGE_FRAME_POLL_MS = 3000;

export type PageFrameProps = {
  pageId: string;
  device?: "desktop" | "mobile";
  height?: string;
  fill?: boolean;
  /** Instance-namespaced state id: `appContext.emit` lands at `/ui/<id>/message`. */
  id?: string;
  params?: Record<string, string | number | boolean>;
  /** App actions the page may run (`appContext.action`). */
  actions?: string[];
  /** App state paths the page may read (`appContext.state`). */
  expose?: string[];
};

type Emit = (event: string) => void | Promise<void>;

/**
 * A live swarm Page. Inside an app an HTML page also gets `window.appContext`
 * (`AppPageFrame`); outside one (a JSON page embedding a page) it is the plain
 * frame and the page sees `appContext === null`.
 */
export function PageFrameComponent({ props, emit }: { props: PageFrameProps; emit?: Emit }) {
  const appId = useAppScopeId();
  if (appId) return <AppPageFrame appId={appId} props={props} emit={emit} />;
  return <PageFrameView props={props} />;
}

/** The API origin the page iframe is served from (`/p/<id>`). */
function apiOrigin(): string {
  try {
    return new URL(getConfig().apiUrl || "http://localhost:3013").origin;
  } catch {
    return "";
  }
}

/**
 * The app half of `window.appContext` (rules in `app-context-bridge.ts`): a
 * handshake pinned to this frame's iframe and the API origin, then one
 * `MessageChannel` port per page load. Snapshot changes (route, exposed
 * state, theme) are pushed to the page as they happen.
 */
function AppPageFrame({
  appId,
  props,
  emit,
}: {
  appId: string;
  props: PageFrameProps;
  emit?: Emit;
}) {
  const { get, set } = useStateStore();
  const { handlers } = useActions();
  const themePreset = useJsonRenderTheme();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const callKey = useId().replace(/[^A-Za-z0-9_-]/g, "");

  const snapshot: AppContextSnapshot = {
    app: { id: appId },
    route: get("/route") ?? null,
    params: frameParams(props.params),
    theme: { mode: theme, preset: themePreset },
    state: Object.fromEntries(
      (Array.isArray(props.expose) ? props.expose : [])
        .filter((path): path is string => typeof path === "string")
        .map((path) => [path, get(path) ?? null]),
    ),
  };
  const signature = JSON.stringify(snapshot);
  // Live reads for the long-lived listener below.
  const live = useRef({ snapshot, props, emit, handlers, get, set });
  live.current = { snapshot, props, emit, handlers, get, set };
  const portRef = useRef<MessagePort | null>(null);

  useEffect(() => {
    const origin = apiOrigin();
    let calls = 0;
    const host = createAppContextHost({
      allowedActions: () => {
        const actions = live.current.props.actions;
        return Array.isArray(actions) ? actions.filter((a) => typeof a === "string") : [];
      },
      messageId: () =>
        typeof live.current.props.id === "string" ? live.current.props.id : undefined,
      runAction: async (name, input): Promise<AppContextActionResult> => {
        const handler = live.current.handlers["app.action"];
        if (!handler) return { status: "error", error: "appContext: no app actions here" };
        // The app's own handler: `/actions/<name>` slot, refetch, toasts, all as the viewer.
        // The private outcome slot tells this call (not a concurrent one) how it ended.
        calls += 1;
        const outcome = `/pageFrame/${callKey}/${calls}`;
        try {
          await handler({ name, input, [OUTCOME_PARAM]: outcome });
        } catch {
          // A failed action halts its chain; the outcome slot still says why.
        }
        const slot = live.current.get(outcome) as
          | { status?: string; result?: unknown; error?: string; taskId?: string }
          | undefined;
        live.current.set(outcome, undefined);
        if (slot?.status === "ok") return { status: "ok", result: slot.result };
        if (slot?.status === "running") return { status: "running", taskId: slot.taskId };
        return { status: "error", error: slot?.error ?? `action ${name} failed` };
      },
      navigate: (page, params) => {
        void live.current.handlers["app.navigate"]?.({ page, params });
      },
      deliver: (id, message) => {
        live.current.set(`/ui/${id}/message`, message);
        void live.current.emit?.("message");
      },
    });

    const onMessage = (event: MessageEvent) => {
      const frame = containerRef.current?.querySelector("iframe");
      const target = frame?.contentWindow;
      if (!target || event.source !== target || event.origin !== origin) return;
      const data: unknown = event.data;
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { type?: unknown }).type !== "swarm-app:hello"
      ) {
        return;
      }
      // A reload (or a navigation inside the frame) says hello again: the old port dies with it.
      portRef.current?.close();
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      channel.port1.onmessage = (portEvent) => {
        void host.handle(portEvent.data).then((reply) => {
          if (reply && portRef.current === channel.port1) channel.port1.postMessage(reply);
        });
      };
      target.postMessage({ type: "swarm-app:init", snapshot: live.current.snapshot }, origin, [
        channel.port2,
      ]);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [callKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the change trigger; the snapshot is read live
  useEffect(() => {
    portRef.current?.postMessage({ type: "swarm-app:update", snapshot: live.current.snapshot });
  }, [signature]);

  return (
    <PageFrameView
      props={props}
      frameQuery={appFrameQuery(appId, props.params)}
      themePreset={themePreset}
      containerRef={containerRef}
    />
  );
}

/**
 * The page body `/pages/<id>` shows (a sandboxed iframe of the HTML page, or
 * the JSON renderer), reloaded whenever the page's `updatedAt` moves.
 */
function PageFrameView({
  props,
  frameQuery = "",
  themePreset,
  containerRef,
}: {
  props: PageFrameProps;
  frameQuery?: string;
  themePreset?: string | null;
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  const pageId = typeof props.pageId === "string" ? props.pageId.trim() : "";
  const valid = PAGE_FRAME_ID.test(pageId);
  const fill = props.fill === true;
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["page-frame", pageId],
    queryFn: () => api.getPage(pageId),
    enabled: valid,
    refetchInterval: PAGE_FRAME_POLL_MS,
    retry: false,
  });
  const revision = data?.updatedAt;

  // The body reads the page metadata query, cached forever: refetch it on each
  // new revision so a JSON page (rendered from that body) and a changed auth
  // mode follow too. The first revision is the load, not a change.
  const seenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!revision) return;
    const previous = seenRef.current;
    seenRef.current = revision;
    if (previous && previous !== revision) {
      void queryClient.invalidateQueries({ queryKey: ["page-metadata", pageId] });
    }
  }, [revision, pageId, queryClient]);

  let body: ReactNode;
  if (!pageId) body = <EmptyState compact icon={Globe} title="No page selected" />;
  else if (!valid) body = <EmptyState compact icon={Globe} title="Not a page id" />;
  // A failed poll keeps the last good frame; only a first load that fails shows the error.
  else if (!revision && error) {
    body = <EmptyState compact icon={Globe} title="This page could not be loaded" />;
  } else if (!revision) body = <Skeleton className="h-full min-h-40 w-full" />;
  else {
    body = (
      <Suspense fallback={<Skeleton className="h-full min-h-40 w-full" />}>
        <PagePreviewBody
          id={pageId}
          frameQuery={frameQuery}
          revision={revision}
          themePreset={themePreset}
          className="block h-full w-full border-0 bg-background"
        />
      </Suspense>
    );
  }

  const mobile = props.device === "mobile";
  return (
    <div
      className={cn("flex min-w-0 justify-center", fill ? "h-full min-h-0" : "h-[640px]")}
      style={props.height && !fill ? { height: props.height } : undefined}
      data-testid="json-render-page-frame"
      ref={containerRef}
    >
      <div
        className={cn(
          "h-full min-w-0 overflow-auto rounded-lg border border-border bg-background",
          // `box-content`: the page itself gets the full 390 px inside the border.
          mobile ? "box-content max-w-full" : "w-full",
        )}
        style={mobile ? { width: PAGE_FRAME_MOBILE_WIDTH } : undefined}
        data-device={mobile ? "mobile" : "desktop"}
      >
        {body}
      </div>
    </div>
  );
}
