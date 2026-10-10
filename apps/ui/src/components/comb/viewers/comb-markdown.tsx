// The Comb markdown renderer: Streamdown configured so every block carries
// document-absolute source lines (step-7 anchors comments on them).
//
// This module uses relative imports only, so `bun:test` can render it from the
// repo root (where `@/` resolves to the API's `src/`).

import { Image as ImageIcon } from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { Link } from "react-router-dom";
import { type Components, defaultRehypePlugins, Streamdown } from "streamdown";
import { HIGHLIGHT_MAX_CHARS, prismLanguageForFence } from "../../../lib/comb/code-language";
import { combPathForLink } from "../../../lib/comb/links";
import {
  baseName,
  combPath,
  type DrivePath,
  isAbsoluteUrl,
  isFolderPath,
  resolveRelative,
} from "../../../lib/comb/paths";
import { rehypeSourceLines } from "../../../lib/comb/rehype-source-lines";
import { type CodeTheme, HighlightedCode } from "./code-tokens";

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

/**
 * Props of the component that renders one drive image inside the markdown. It
 * shows `fallback` (the placeholder) until the image loads, and when it cannot
 * load.
 */
export interface DriveImageProps {
  file: DrivePath;
  alt: string;
  fallback: ReactNode;
}

/**
 * The file being rendered (relative links resolve against it), its drive image
 * renderer, and the agent-fs live UI host (`useAgentFs().liveUrl`), so live
 * links to drive files open in Comb (step-13). `CombMarkdown` provides it.
 * `codeTheme` picks the fenced code colors.
 */
const CombDocContext = createContext<{
  doc: DrivePath;
  DriveImage?: ComponentType<DriveImageProps>;
  liveUrl: string | null;
  codeTheme: CodeTheme;
} | null>(null);

type ElementProps<Tag extends keyof React.JSX.IntrinsicElements> = ComponentProps<Tag> & {
  node?: unknown;
};

const LINK_CLASS = "text-primary underline underline-offset-2 hover:opacity-80";

function CombLink({ node: _node, href, children, ...rest }: ElementProps<"a">) {
  const ctx = useContext(CombDocContext);
  const doc = ctx?.doc;
  const liveUrl = ctx?.liveUrl ?? null;
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
  // step-13: an agent-fs live link or a dashboard file link also opens in Comb.
  // Comb renders a file only while connected, so no state check is needed.
  const appOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const combTo = href ? combPathForLink(href, { liveUrl, appOrigin }) : null;
  if (combTo) {
    return (
      <Link to={combTo} className={LINK_CLASS}>
        {children}
      </Link>
    );
  }
  // An in-page anchor stays in the tab. Other links open a new tab.
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
  const ctx = useContext(CombDocContext);
  const doc = ctx?.doc;
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
  // A drive image. `DriveImage` loads it through a media URL. The placeholder
  // opens the file in Comb, and shows while the image loads, when it cannot
  // load, and for a `src` that does not resolve into the drive. It is not
  // document text (`data-comb-skip`).
  const target = doc ? resolveRelative(doc.path, src) : null;
  const label = alt || baseName(target?.path ?? src) || "Image";
  const placeholder = (
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
  const DriveImage = ctx?.DriveImage;
  if (!doc || !target || !DriveImage || isFolderPath(target.path)) return placeholder;
  return <DriveImage file={{ ...doc, path: target.path }} alt={alt ?? ""} fallback={placeholder} />;
}

/**
 * A fenced code block's `<code>`. A fence that names a language with a bundled
 * Prism grammar is highlighted (`code-tokens.tsx`, the same text in token
 * spans). Other fences, and fences over `HIGHLIGHT_MAX_CHARS`, stay plain.
 */
function CombCode({ node: _node, children, className }: ElementProps<"code">) {
  const codeTheme = useContext(CombDocContext)?.codeTheme ?? "dark";
  const language = prismLanguageForFence(className);
  const text =
    typeof children === "string"
      ? children
      : Array.isArray(children) && children.every((child) => typeof child === "string")
        ? children.join("")
        : null;
  if (!language || text === null || text.length > HIGHLIGHT_MAX_CHARS) {
    return <code className={className}>{children}</code>;
  }
  return (
    <HighlightedCode text={text} language={language} theme={codeTheme} className={className} />
  );
}

/**
 * Component overrides:
 * - Fenced code is a `<pre><code>` text block, highlighted by `CombCode`.
 *   Monaco (used by `MarkdownView`) builds its own DOM, which comment anchors
 *   cannot address. `pre` marks its child the way Streamdown's own `pre` does,
 *   so `code` renders blocks and `inlineCode` renders inline spans.
 * - Relative links, agent-fs live links, and dashboard file links open the
 *   target file in Comb.
 * - Web images load. Drive images load through `DriveImage`. Without it, they
 *   show a placeholder that links to the file.
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
  code: CombCode,
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

/**
 * Render a markdown file. `doc` is the file itself (its links resolve against
 * it). `DriveImage` renders relative images from the drive. This module keeps
 * relative imports only, so the caller passes the data-loading component in.
 * `liveUrl` is the agent-fs live UI host: live links to drive files open in
 * Comb (step-13). `codeTheme` is the dashboard theme (`useTheme().theme`),
 * for the fenced code colors.
 */
export function CombMarkdown({
  text,
  doc,
  DriveImage,
  liveUrl = null,
  codeTheme = "dark",
}: {
  text: string;
  doc: DrivePath;
  DriveImage?: ComponentType<DriveImageProps>;
  liveUrl?: string | null;
  codeTheme?: CodeTheme;
}): ReactNode {
  const { orgId, driveId, path } = doc;
  const ctx = useMemo(
    () => ({ doc: { orgId, driveId, path }, DriveImage, liveUrl, codeTheme }),
    [orgId, driveId, path, DriveImage, liveUrl, codeTheme],
  );
  return (
    <CombDocContext.Provider value={ctx}>
      {/* step-11: remount per text. Streamdown memoizes each block by its
          source position only, so an edit that keeps a block's line and
          columns (a same-length fix) never rendered. */}
      <Streamdown
        key={text}
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
