// The Comb markdown renderer: Streamdown configured so every block carries
// document-absolute source lines (step-7 anchors comments on them).
//
// This module uses relative imports only, so `bun:test` can render it from the
// repo root (where `@/` resolves to the API's `src/`).

import { ChevronRight, Image as ImageIcon } from "lucide-react";
import {
  type ComponentProps,
  type ComponentType,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { type Components, defaultRehypePlugins, Streamdown } from "streamdown";
import { HIGHLIGHT_MAX_CHARS, prismLanguageForFence } from "../../../lib/comb/code-language";
import {
  type Frontmatter,
  type FrontmatterValue,
  splitFrontmatter,
} from "../../../lib/comb/frontmatter";
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
import { MermaidBlock } from "./mermaid-block";

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
  /** The image's source lines, for its frame (`AssetFrameProps.lines`). */
  lines?: SourceLines;
}

/** An asset the markdown shows: an image (a drive file or a web URL), or a rendered diagram. */
export type AssetSource =
  | { kind: "image"; src: string; alt: string; file: DrivePath | null }
  | { kind: "diagram"; svg: string; svgId: string };

/**
 * Props of the frame around an asset (Maximize and Comment on hover). The
 * caller passes the component in (`asset-frame.tsx`): this module keeps
 * relative imports only. `block`: the asset takes its own row (a diagram).
 */
export interface AssetFrameProps {
  asset: AssetSource;
  block?: boolean;
  /**
   * The asset's source lines. Streamdown takes an image alone in its
   * paragraph out of the `<p>`, so the frame carries the lines itself: a
   * comment on the asset anchors on them.
   */
  lines?: SourceLines;
  children: ReactNode;
}

/** First and last source line of a markdown element. */
export interface SourceLines {
  start: number;
  end: number;
}

/** The source lines of a hast node (`node.position`), when it has them. */
function sourceLines(node: unknown): SourceLines | undefined {
  const position = (node as { position?: { start?: { line?: number }; end?: { line?: number } } })
    ?.position;
  const start = position?.start?.line;
  if (typeof start !== "number") return undefined;
  const end = position?.end?.line;
  return { start, end: typeof end === "number" && end >= start ? end : start };
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
  AssetFrame?: ComponentType<AssetFrameProps>;
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

function CombImage({ node, src, alt, ...rest }: ElementProps<"img">) {
  const ctx = useContext(CombDocContext);
  const doc = ctx?.doc;
  const lines = sourceLines(node);
  if (typeof src !== "string" || !src) return null;
  if (WEB_IMAGE_RE.test(src)) {
    const image = (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-4 inline-block max-w-full rounded-lg"
        {...rest}
      />
    );
    const Frame = ctx?.AssetFrame;
    return Frame ? (
      <Frame asset={{ kind: "image", src, alt: alt ?? "", file: null }} lines={lines}>
        {image}
      </Frame>
    ) : (
      image
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
  return (
    <DriveImage
      file={{ ...doc, path: target.path }}
      alt={alt ?? ""}
      fallback={placeholder}
      lines={lines}
    />
  );
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
 * - A ```mermaid fence draws as a diagram (`MermaidBlock`, mermaid loads lazily).
 * - Fenced code is a `<pre><code>` text block, highlighted by `CombCode`.
 *   Monaco (used by `MarkdownView`) builds its own DOM, which comment anchors
 *   cannot address. `pre` marks its child the way Streamdown's own `pre` does,
 *   so `code` renders blocks and `inlineCode` renders inline spans.
 * - Relative links, agent-fs live links, and dashboard file links open the
 *   target file in Comb.
 * - Web images load. Drive images load through `DriveImage`. Without it, they
 *   show a placeholder that links to the file.
 */
const PRE_CLASS =
  "my-4 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed";

/** The text of a fence's `<code>` child, when it is a ```mermaid fence. */
function mermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: unknown; children?: unknown };
  if (typeof props.className !== "string" || !/\blanguage-mermaid\b/.test(props.className)) {
    return null;
  }
  const text = props.children;
  if (typeof text === "string") return text;
  if (Array.isArray(text) && text.every((part) => typeof part === "string")) return text.join("");
  return null;
}

function CombPre({ node: _node, children, ...rest }: ElementProps<"pre">) {
  const ctx = useContext(CombDocContext);
  const codeTheme = ctx?.codeTheme ?? "dark";
  const block = isValidElement(children)
    ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        "data-block": "true",
      })
    : children;
  const mermaid = mermaidSource(children);
  if (mermaid !== null) {
    // The wrapper takes the fence's `data-line-*` stamps.
    return (
      <MermaidBlock
        source={mermaid}
        theme={codeTheme}
        frame={ctx?.AssetFrame}
        fallback={<pre className={PRE_CLASS}>{block}</pre>}
        {...(rest as ComponentProps<"div">)}
      />
    );
  }
  return (
    <pre className={PRE_CLASS} {...rest}>
      {block}
    </pre>
  );
}

export const COMB_MD_COMPONENTS: Components = {
  pre: CombPre,
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
 * for the fenced code colors. `propertiesOpen` and `onPropertiesOpenChange`
 * hold the frontmatter block's open state (stored by the caller). Without
 * them it starts open and stays local.
 */
export function CombMarkdown({
  text,
  doc,
  DriveImage,
  AssetFrame,
  liveUrl = null,
  codeTheme = "dark",
  propertiesOpen,
  onPropertiesOpenChange,
}: {
  text: string;
  doc: DrivePath;
  DriveImage?: ComponentType<DriveImageProps>;
  /** The frame around images and diagrams (Maximize, Comment). None: bare assets. */
  AssetFrame?: ComponentType<AssetFrameProps>;
  liveUrl?: string | null;
  codeTheme?: CodeTheme;
  propertiesOpen?: boolean;
  onPropertiesOpenChange?: (open: boolean) => void;
}): ReactNode {
  const { orgId, driveId, path } = doc;
  const ctx = useMemo(
    () => ({ doc: { orgId, driveId, path }, DriveImage, AssetFrame, liveUrl, codeTheme }),
    [orgId, driveId, path, DriveImage, AssetFrame, liveUrl, codeTheme],
  );
  // A leading YAML block shows as a key/value table. Its lines stay in the
  // body as blank lines, so the blocks below keep the file's line numbers.
  const { frontmatter, body } = useMemo(() => splitFrontmatter(text), [text]);
  const [localOpen, setLocalOpen] = useState(true);
  const open = propertiesOpen ?? localOpen;
  return (
    <CombDocContext.Provider value={ctx}>
      {frontmatter && (
        <FrontmatterBlock
          frontmatter={frontmatter}
          open={open}
          onOpenChange={onPropertiesOpenChange ?? setLocalOpen}
        />
      )}
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
        {body}
      </Streamdown>
    </CombDocContext.Provider>
  );
}

const URL_RE = /^https?:\/\/\S+$/i;
/** A number, a boolean, or a date ("2026-10-14", with or without a time): set in mono. */
const NUMBER_OR_DATE_RE = /^(?:-?\d+(?:\.\d+)?|true|false|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?)$/;

function PropertyValue({ value }: { value: FrontmatterValue }): ReactNode {
  switch (value.kind) {
    case "list":
      return (
        <span className="flex flex-wrap gap-1">
          {value.items.map((item, index) => (
            <span
              key={`${index}:${item}`}
              className="rounded border border-border bg-background px-1.5 py-px [overflow-wrap:anywhere]"
            >
              {item}
            </span>
          ))}
        </span>
      );
    case "block":
      return (
        <pre className="m-0 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
          {value.text}
        </pre>
      );
    case "text":
      if (NUMBER_OR_DATE_RE.test(value.text)) {
        return <span className="font-mono">{value.text}</span>;
      }
      return URL_RE.test(value.text) ? (
        <a href={value.text} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {value.text}
        </a>
      ) : (
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value.text}</span>
      );
  }
}

/**
 * Frontmatter as a collapsible "Properties" block above the document: keys
 * and values, lists as chips, nested values as YAML. YAML that does not parse
 * is read line by line (`lenient`), and only text with no key at all shows
 * as the raw block. Not document text (`data-comb-skip`): comments anchor on
 * the markdown below.
 */
function FrontmatterBlock({
  frontmatter,
  open,
  onOpenChange,
}: {
  frontmatter: Frontmatter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const { entries, raw, error, lenient } = frontmatter;
  if (entries !== null && entries.length === 0) return null;
  const note = entries === null ? "Could not read" : lenient ? "Not valid YAML" : null;
  return (
    <section
      data-comb-skip
      data-frontmatter={entries === null ? "raw" : "table"}
      className="mb-6 rounded-md border border-border bg-muted/30 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="font-medium">Properties</span>
        {entries ? <span className="tabular-nums">{entries.length}</span> : null}
        {note ? (
          <span className="ml-auto truncate" title={error ?? undefined}>
            {note}
          </span>
        ) : null}
      </button>
      {!open ? null : entries === null ? (
        <div className="border-t border-border-subtle px-4 py-3">
          <pre className="m-0 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{raw}</pre>
          <p className="mt-2 text-muted-foreground">Frontmatter could not be parsed: {error}</p>
        </div>
      ) : (
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-border-subtle px-4 py-3">
          {entries.map(({ key, value }, index) => (
            <Fragment key={`${index}:${key}`}>
              <dt className="font-medium text-muted-foreground">{key}</dt>
              <dd className="m-0 min-w-0">
                <PropertyValue value={value} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}
