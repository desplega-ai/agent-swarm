// Syntax-highlighted code for Comb: the Prism themes the dashboard uses for
// code (`script-runs/source-view.tsx`, `shared/session-log-viewer.tsx`), and
// token rendering that keeps the DOM text equal to the source text, so comment
// anchors (`lib/comb/dom-text-space.ts`) read the same text as before.
//
// Relative imports only: `bun:test` renders `comb-markdown.tsx`, which uses
// this module, from the repo root.

import {
  Highlight,
  type PrismTheme,
  type RenderProps,
  type Token,
  themes,
} from "prism-react-renderer";
import { Fragment } from "react";

export type CodeTheme = "dark" | "light";

/** The Prism theme for a dashboard theme. Comb drops the theme background. */
export function prismTheme(theme: CodeTheme): PrismTheme {
  return theme === "dark" ? themes.vsDark : themes.github;
}

/**
 * One source line of tokens. A colored token is a span with the theme's
 * inline style, a plain token is bare text, and the empty-line marker renders
 * nothing, so the line's DOM text is exactly its source text. Prism's class
 * names stay off: some of them (`table`) are also Tailwind utilities.
 */
export function LineTokens({
  line,
  getTokenProps,
}: {
  line: Token[];
  getTokenProps: RenderProps["getTokenProps"];
}) {
  return (
    <>
      {line.map((token, index) => {
        if (token.empty || !token.content) return null;
        const { style } = getTokenProps({ token });
        // The tokens of one line never reorder, so the index is a stable key.
        return style ? (
          <span key={index} style={style}>
            {token.content}
          </span>
        ) : (
          <Fragment key={index}>{token.content}</Fragment>
        );
      })}
    </>
  );
}

const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * A fenced code block's `<code>`, highlighted. The line breaks between the
 * token lines are the source's own (Prism splits on CRLF, CR, and LF), so the
 * element's text is `text` unchanged.
 */
export function HighlightedCode({
  text,
  language,
  theme,
  className,
}: {
  text: string;
  language: string;
  theme: CodeTheme;
  className?: string;
}) {
  const prism = prismTheme(theme);
  const breaks = text.match(LINE_BREAK) ?? [];
  return (
    <Highlight code={text} language={language} theme={prism}>
      {({ tokens, getTokenProps }) => (
        <code className={className} style={{ color: prism.plain.color }}>
          {tokens.map((line, index) => (
            // Lines are positional and never reorder, so the index is a stable key.
            <Fragment key={index}>
              {index > 0 ? (breaks[index - 1] ?? "\n") : null}
              <LineTokens line={line} getTokenProps={getTokenProps} />
            </Fragment>
          ))}
        </code>
      )}
    </Highlight>
  );
}
