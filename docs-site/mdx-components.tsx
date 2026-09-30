import defaultMdxComponents from "fumadocs-ui/mdx";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { Mermaid } from "@/components/mdx/mermaid";
import { JsonLd } from "@/components/mdx/json-ld";
import { APIPage } from "@/components/api-page";
import type { MDXComponents } from "mdx/types";
import { isValidElement, type ComponentProps, type ReactNode } from "react";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/**
 * Fumadocs renders every scrollable code block as a focusable `role="region"`, which
 * needs a name, and two regions on one page must not share one. Fumadocs passes no
 * language, so the name is the block's title or, when it has none, its line count and
 * first line.
 */
function codeBlockLabel({ title, children }: { title?: unknown; children?: ReactNode }): string {
  if (typeof title === "string" && title) return `${title} source code`;
  const lines = textOf(children)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "Code sample";
  const first = lines[0].length > 48 ? `${lines[0].slice(0, 47)}…` : lines[0];
  return `Code sample, ${lines.length} ${lines.length === 1 ? "line" : "lines"}: ${first}`;
}

function NamedCodeBlock(props: ComponentProps<typeof CodeBlock>) {
  return (
    <CodeBlock
      {...props}
      viewportProps={{ "aria-label": codeBlockLabel(props), ...props.viewportProps }}
    >
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    pre: NamedCodeBlock,
    Mermaid,
    JsonLd,
    APIPage,
    ...components,
  };
}
