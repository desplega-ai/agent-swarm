import { LogIn } from "lucide-react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ObjectEmbed } from "@/components/objects/object-embed";
import type { ObjectFetch } from "@/components/objects/use-object";

/** Who the page server says is viewing (`<meta name="swarm-viewer">`, `src/http/pages-public.ts`). */
export type PageViewer = "user" | "operator" | "guest";

/** No meta (a page from an older API, or not a swarm page) reads as a guest. */
export function readPageViewer(doc: Document = document): PageViewer {
  const value = doc.querySelector('meta[name="swarm-viewer"]')?.getAttribute("content");
  return value === "user" || value === "operator" ? value : "guest";
}

/** The page id in `/p/<id>`, which the proxy needs to pick this page's session cookie. */
export function currentPageId(pathname: string = location.pathname): string {
  const parts = pathname.split("/");
  return parts[1] === "p" && parts[2] ? (parts[2].split(".")[0] ?? "") : "";
}

/**
 * `/api/objects/...` through the page proxy: same origin, so the page-session
 * cookie rides along and connect-src stays 'self'.
 */
export function pageObjectFetch(pageId: string): ObjectFetch {
  return (path, init) => {
    const headers = new Headers(init?.headers);
    if (pageId) headers.set("X-Swarm-Page-Id", pageId);
    if (init?.body !== undefined) headers.set("Content-Type", "application/json");
    return fetch(`/@swarm/api/${path.replace(/^\/api\//, "")}`, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  };
}

function clampHeight(raw: string | null): number | undefined {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(1200, Math.max(160, value)) : undefined;
}

type SwarmObjectProps = {
  objectId: string;
  height?: number;
  readOnly: boolean;
  tab?: string;
  range?: string;
  viewer: PageViewer;
  fetch: ObjectFetch;
  theme: "light" | "dark";
  /** The dashboard page for this page, for the guest's sign-in link. */
  signInUrl: string | null;
};

/**
 * A guest sees a placeholder and the embed sends nothing: `/@swarm/api` refuses
 * guests anyway. An operator launch (the shared swarm key) is read-only.
 */
export function SwarmObject({ viewer, signInUrl, objectId, ...props }: SwarmObjectProps) {
  const height = props.height ?? 480;
  if (viewer === "guest") {
    return (
      <div
        className="flex w-full flex-col items-center justify-center gap-2 rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground"
        style={{ height: Math.min(height, 200) }}
        data-swarm-object-placeholder=""
      >
        <LogIn className="size-4" aria-hidden />
        <p>Sign in to the swarm to view this embed.</p>
        {signInUrl ? (
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href={signInUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in the swarm
          </a>
        ) : null}
      </div>
    );
  }
  if (!objectId) {
    return <p className="p-4 text-sm text-muted-foreground">Set an object-id to show an object.</p>;
  }
  return (
    <ObjectEmbed
      objectId={objectId}
      height={height}
      readOnly={props.readOnly || viewer === "operator"}
      tab={props.tab}
      range={props.range}
      fetch={props.fetch}
      theme={props.theme}
    />
  );
}

export type SwarmObjectStyles = {
  /** The shadow root's stylesheet (every rule of the bundle). */
  stylesheet: string;
  /** Rules that only work at document level (`@property`, `@font-face`). */
  documentStylesheet: string;
  /** The dashboard origin that served the bundle. */
  appOrigin: string;
};

export const OBSERVED_ATTRIBUTES = ["object-id", "height", "readonly", "tab", "range"] as const;

/**
 * Registers `<swarm-object object-id="…" height readonly tab range>`. It mounts
 * ObjectEmbed in a shadow root, so the page's own CSS (often Tailwind) and the
 * embed's cannot restyle each other. Idempotent: a second bundle on the page is a no-op.
 */
export function defineSwarmObject(styles: SwarmObjectStyles, registry = customElements) {
  if (registry.get("swarm-object")) return;

  let documentSheetAdded = false;
  const addDocumentSheet = () => {
    if (documentSheetAdded) return;
    documentSheetAdded = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = styles.documentStylesheet;
    document.head.append(link);
  };

  class SwarmObjectElement extends HTMLElement {
    static observedAttributes = [...OBSERVED_ATTRIBUTES];
    #root: Root | null = null;
    #mount: HTMLDivElement | null = null;
    #ready: Promise<void> | null = null;
    readonly #fetch = pageObjectFetch(currentPageId());

    connectedCallback() {
      if (!this.shadowRoot) {
        addDocumentSheet();
        const shadow = this.attachShadow({ mode: "open" });
        const host = document.createElement("style");
        host.textContent = ":host{display:block}";
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = styles.stylesheet;
        // Paint once the sheet is in, so the embed never flashes unstyled.
        this.#ready = new Promise((resolve) => {
          link.addEventListener("load", () => resolve(), { once: true });
          link.addEventListener("error", () => resolve(), { once: true });
        });
        this.#mount = document.createElement("div");
        shadow.append(host, link, this.#mount);
      }
      void this.#ready?.then(() => {
        if (!this.isConnected || !this.#mount) return;
        this.#root ??= createRoot(this.#mount);
        this.#render();
      });
    }

    attributeChangedCallback() {
      this.#render();
    }

    disconnectedCallback() {
      this.#root?.unmount();
      this.#root = null;
    }

    #render() {
      if (!this.#root || !this.#mount) return;
      const dark = document.documentElement.classList.contains("dark");
      // `.dark` on the wrapper: the dashboard's dark tokens are scoped to that class.
      this.#mount.className = dark ? "dark" : "";
      const pageId = currentPageId();
      this.#root.render(
        <StrictMode>
          <SwarmObject
            objectId={this.getAttribute("object-id")?.trim() ?? ""}
            height={clampHeight(this.getAttribute("height"))}
            readOnly={this.hasAttribute("readonly")}
            tab={this.getAttribute("tab") ?? undefined}
            range={this.getAttribute("range") ?? undefined}
            viewer={readPageViewer()}
            fetch={this.#fetch}
            theme={dark ? "dark" : "light"}
            signInUrl={pageId ? `${styles.appOrigin}/pages/${encodeURIComponent(pageId)}` : null}
          />
        </StrictMode>,
      );
    }
  }

  registry.define("swarm-object", SwarmObjectElement);
}
