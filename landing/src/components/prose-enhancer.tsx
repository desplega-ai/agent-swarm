"use client";

import { useEffect, useRef } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";

let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("ts", typescript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("yml", yaml);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("md", markdown);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("css", css);
  hljs.configure({
    classPrefix: "hljs-",
    ignoreUnescapedHTML: true,
  });
}

/**
 * Decorates every <pre> inside its subtree with:
 *  - basic syntax highlighting (auto-detect via highlight.js)
 *  - a copy-to-clipboard button
 * Runs once on mount and again whenever children change.
 */
export function ProseEnhancer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureRegistered();
    const root = ref.current;
    if (!root) return;

    const decorated: { btn: HTMLButtonElement; pre: HTMLElement; handler: () => void }[] = [];

    root.querySelectorAll("pre").forEach((preNode) => {
      const pre = preNode as HTMLElement;

      // Highlight the code element if not already done.
      const codeEl = pre.querySelector("code");
      if (codeEl && !codeEl.classList.contains("hljs")) {
        try {
          hljs.highlightElement(codeEl as HTMLElement);
        } catch {
          // ignore highlight failures
        }
      }

      // Add copy button if missing.
      if (pre.querySelector("[data-copy-btn]")) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prose-copy-btn";
      btn.dataset.copyBtn = "1";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.textContent = "Copy";

      const handler = async () => {
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = "Copied";
          btn.dataset.copied = "1";
          window.setTimeout(() => {
            btn.textContent = "Copy";
            delete btn.dataset.copied;
          }, 1500);
        } catch {
          btn.textContent = "Failed";
          window.setTimeout(() => {
            btn.textContent = "Copy";
          }, 1500);
        }
      };

      btn.addEventListener("click", handler);

      if (getComputedStyle(pre).position === "static") {
        pre.style.position = "relative";
      }
      pre.appendChild(btn);

      decorated.push({ btn, pre, handler });
    });

    return () => {
      decorated.forEach(({ btn, handler }) => {
        btn.removeEventListener("click", handler);
        btn.remove();
      });
    };
  }, [children]);

  return <div ref={ref}>{children}</div>;
}
