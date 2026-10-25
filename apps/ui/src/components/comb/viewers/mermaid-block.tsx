// A ```mermaid fence in Comb's markdown preview, drawn as a diagram. Mermaid
// loads on first use (a dynamic import, its own chunk). The content is
// agent-written, so mermaid runs with `securityLevel: "strict"` (no click
// handlers, labels sanitized). Until the diagram renders, and when it cannot,
// the block shows its source like any other fence.

import {
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { CodeTheme } from "./code-tokens";
import type { AssetFrameProps } from "./comb-markdown";

type MermaidApi = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidPromise;
}

// `initialize` sets mermaid's global config, so one render at a time keeps
// each diagram on the theme it asked for.
let queue: Promise<unknown> = Promise.resolve();

async function renderDiagram(id: string, source: string, theme: CodeTheme): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
    });
    try {
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      // A failed render can leave its scratch element behind in <body>.
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Fit the diagram to the column: a wide diagram shrinks until all of it
 * shows (Maximize opens it as large as the screen), a small one keeps its
 * own size.
 */
function fitWidth(host: HTMLElement) {
  const svg = host.querySelector("svg");
  const width = svg?.viewBox?.baseVal?.width;
  if (!svg || !width) return;
  svg.setAttribute("width", "100%");
  svg.removeAttribute("height");
  svg.style.maxWidth = `${width}px`;
  svg.style.display = "block";
  svg.style.margin = "0 auto";
}

type Status =
  | { kind: "loading" }
  | { kind: "ready"; svg: string }
  | { kind: "error"; message: string };

export function MermaidBlock({
  source,
  theme,
  fallback,
  frame: Frame,
  ...rest
}: {
  source: string;
  theme: CodeTheme;
  /** The fence as a plain code block: shown while loading and on a parse error. */
  fallback: ReactNode;
  /** The frame with Maximize and Comment (`asset-frame.tsx`). None: the bare diagram. */
  frame?: ComponentType<AssetFrameProps>;
} & Omit<ComponentProps<"div">, "children">) {
  const id = `comb-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    renderDiagram(id, source, theme).then(
      (svg) => {
        if (!cancelled) setStatus({ kind: "ready", svg });
      },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message: message.split("\n")[0] ?? message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, source, theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || status.kind !== "ready") return;
    host.innerHTML = status.svg;
    fitWidth(host);
  }, [status]);

  if (status.kind === "ready") {
    // The diagram is not document text: comments anchor on the source lines,
    // not on the SVG labels (`data-comb-skip`).
    const diagram = (
      <div className="overflow-x-auto rounded-md border border-border p-3">
        <div ref={hostRef} data-comb-skip role="img" aria-label="Mermaid diagram" />
      </div>
    );
    return (
      <div {...rest} className="my-4">
        {Frame ? (
          <Frame asset={{ kind: "diagram", svg: status.svg, svgId: id }} block>
            {diagram}
          </Frame>
        ) : (
          diagram
        )}
      </div>
    );
  }
  return (
    <div {...rest}>
      {fallback}
      {status.kind === "error" && (
        <p data-comb-skip className="-mt-2 mb-4 text-xs text-destructive">
          Mermaid diagram could not render: {status.message}
        </p>
      )}
    </div>
  );
}
