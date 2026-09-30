// The Comb markdown renderer: Streamdown configured so every block carries
// document-absolute source lines (step-7 anchors comments on them).
//
// This module uses relative imports only, so `bun:test` can render it from the
// repo root (where `@/` resolves to the API's `src/`).

import { Image as ImageIcon } from "lucide-react";
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
import {
  baseName,
  combPath,
  type DrivePath,
  isAbsoluteUrl,
  resolveRelative,
} from "../../../lib/comb/paths";
import { rehypeSourceLines } from "../../../lib/comb/rehype-source-lines";

type Pluggable = (typeof defaultRehypePlugins)[string];

// `defaultRehypePlugins.sanitize` is `[rehypeSanitize, schema]`. Comb adds
// "style" to `strip`: sanitize unwraps an element it does not allow, so the CSS
// text inside `<style>` would render as a paragraph. `strip` drops the content.
const [sanitizePlugin, sanitizeSchema] = defaultRehypePlugins.sanitize as unknown as [
  unknown,
  { strip?: string[] },
];
const combSanitize = [
  sanitizePlugin,
  { ...sanitizeSchema, strip: [...(sanitizeSchema.strip ?? []), "style"] },
] as Pluggable;

/**
 * Streamdown's `rehypePlugins` prop replaces its defaults (raw → sanitize →
 * harden), so the list names them again. comb-markdown.test.tsx checks the
 * order:
 * - `rehypeSourceLines` runs last. `rehype-raw` and `rehype-sanitize` keep
 *   hast positions, and sanitize would strip the `data-line-*` stamps if they
 *   came first.
 * - `harden` is left out. It rewrites `./b.md` to `/b.md` and blocks a bare
 *   `b.md`, so links between drive files break. Sanitize already limits `href`
 *   and `src` to safe protocols (no `javascript:`, no `data:`).
 */
export const COMB_REHYPE_PLUGINS = [defaultRehypePlugins.raw, combSanitize, rehypeSourceLines];

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
  // A relative link that does not resolve into the drive (`%2e%2e/`, an
  // escaped "/") stays inert: it must not open a dashboard route.
  if (!href || !isAbsoluteUrl(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

/** Web images (http, https, protocol-relative). Any other `src` is a drive path. */
const WEB_IMAGE_RE = /^(?:https?:)?\/\//i;

function CombImage({ node: _node, src, alt, ...rest }: ElementProps<"img">) {
  const doc = useContext(CombDocContext);
  if (typeof src !== "string" || !src) return null;
  if (WEB_IMAGE_RE.test(src)) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-4 inline-block max-w-full rounded-lg"
        {...rest}
      />
    );
  }
  // A drive image. The dashboard origin cannot serve it, so show a placeholder
  // that opens the file in Comb. It is not document text (`data-comb-skip`).
  // step-6: render the image itself here, through a media URL.
  const target = doc ? resolveRelative(doc.path, src) : null;
  const label = alt || baseName(target?.path ?? src) || "Image";
  return (
    <span
      data-comb-skip
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-0.5 align-middle text-xs text-muted-foreground"
    >
      <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      {doc && target ? (
        <Link to={combPath({ ...doc, path: target.path })} className={LINK_CLASS}>
          {label}
        </Link>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </span>
  );
}

/**
 * Component overrides:
 * - Fenced code is a plain `<pre><code>` text block. Monaco (used by
 *   `MarkdownView`) builds its own DOM, which comment anchors cannot address.
 *   `pre` marks its child the way Streamdown's own `pre` does, so `code`
 *   renders blocks and `inlineCode` renders inline spans.
 * - Relative links open the target file in Comb.
 * - Web images load. Drive images show a placeholder that links to the file.
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
  img: CombImage,
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
