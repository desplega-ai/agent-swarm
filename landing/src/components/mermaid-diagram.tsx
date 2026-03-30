"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void;
      render: (
        id: string,
        definition: string,
      ) => Promise<{ svg: string }>;
    };
  }
}

const MERMAID_CDN =
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

function loadMermaid(): Promise<NonNullable<Window["mermaid"]>> {
  if (window.mermaid) return Promise.resolve(window.mermaid);

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MERMAID_CDN;
    script.onload = () => {
      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          fontFamily: "ui-monospace, monospace",
          flowchart: { curve: "basis" },
        });
        resolve(window.mermaid);
      } else {
        reject(new Error("mermaid failed to load"));
      }
    };
    script.onerror = () => reject(new Error("Failed to load mermaid CDN"));
    document.head.appendChild(script);
  });
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const mermaid = await loadMermaid();
      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      const { svg: renderedSvg } = await mermaid.render(id, chart);
      if (!cancelled) {
        setSvg(renderedSvg);
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  return (
    <div
      ref={containerRef}
      className="my-6 rounded-xl bg-zinc-50 border border-zinc-200 p-5 overflow-x-auto flex justify-center [&_svg]:max-w-full"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
