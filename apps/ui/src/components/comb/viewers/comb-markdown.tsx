// The Comb markdown renderer: Streamdown configured so every block carries
// document-absolute source lines (step-7 anchors comments on them).
//
// This module uses relative imports only, so `bun:test` can render it from the
// repo root (where `@/` resolves to the API's `src/`).

import {
  type ComponentProps,
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
} from "react";
import { Link } from "react-router-dom";
import { type Components, defaultRehypePlugins, Streamdown } from "streamdown";
import { combPath, type DrivePath, resolveRelative } from "../../../lib/comb/paths";
import { rehypeSourceLines } from "../../../lib/comb/rehype-source-lines";

/**
 * Streamdown's `rehypePlugins` prop replaces its defaults (raw → sanitize →
 * harden), so the list names them again. rehype-source-lines.test.tsx decided
 * the order:
 * - `rehypeSourceLines` runs last. `rehype-raw` and `rehype-sanitize` keep
 *   hast positions, and sanitize would strip the `data-line-*` stamps if they
 *   came first.
 * - `harden` is left out. It rewrites `./b.md` to `/b.md` and blocks a bare
 *   `b.md`, so links between drive files break. Sanitize already limits `href`
 *   and `src` to safe protocols (no `javascript:`, no `data:`).
 */
export const COMB_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  rehypeSourceLines,
];

/** The file being rendered, for resolving relative links. */
const CombDocContext = createContext<DrivePath | null>(null);

type ElementProps<Tag extends keyof React.JSX.IntrinsicElements> = ComponentProps<Tag> & {
  node?: unknown;
};

const LINK_CLASS = "text-primary underline underline-offset-2 hover:opacity-80";

function CombLink({ node: _node, href, children, ...rest }: ElementProps<"a">) {
  const doc = useContext(CombDocContext);
  const target = doc && href ? resolveRelative(doc.path, href) : null;
  if (doc && target) {
    return (
      <Link
        to={`${combPath({ ...doc, path: target.path })}${target.suffix}`}
        className={LINK_CLASS}
      >
        {children}
      </Link>
    );
  }
  // An in-page anchor stays in the tab. Other links open a new tab (step-13
  // turns agent-fs live links into Comb links).
  if (href?.startsWith("#")) {
    return (
      <a href={href} className={LINK_CLASS} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/**
 * Component overrides:
 * - Fenced code is a plain `<pre><code>` text block. Monaco (used by
 *   `MarkdownView`) builds its own DOM, which comment anchors cannot address.
 *   `pre` marks its child the way Streamdown's own `pre` does, so `code`
 *   renders blocks and `inlineCode` renders inline spans.
 * - Relative links open the target file in Comb.
 */
export const COMB_MD_COMPONENTS: Components = {
  pre({ node: _node, children, ...rest }: ElementProps<"pre">) {
    return (
      <pre
        className="my-4 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        {...rest}
      >
        {isValidElement(children)
          ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
              "data-block": "true",
            })
          : children}
      </pre>
    );
  },
  code({ node: _node, children, className }: ElementProps<"code"> & { "data-block"?: string }) {
    return <code className={className}>{children}</code>;
  },
  inlineCode({ node: _node, children, className: _className, ...rest }: ElementProps<"code">) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...rest}>
        {children}
      </code>
    );
  },
  a: CombLink,
};

/** Render a markdown file. `doc` is the file itself (its links resolve against it). */
export function CombMarkdown({ text, doc }: { text: string; doc: DrivePath }): ReactNode {
  return (
    <CombDocContext.Provider value={doc}>
      <Streamdown
        mode="static"
        parseIncompleteMarkdown={false}
        controls={false}
        rehypePlugins={COMB_REHYPE_PLUGINS}
        components={COMB_MD_COMPONENTS}
      >
        {text}
      </Streamdown>
    </CombDocContext.Provider>
  );
}
