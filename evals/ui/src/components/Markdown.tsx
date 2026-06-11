import type { ReactNode } from "react";

/**
 * Minimal dependency-free markdown renderer (v4 item 8) for assistant text in
 * transcripts. Supported blocks: #–###### headings, fenced code blocks,
 * unordered (- or star) and ordered (1.) lists, > blockquotes, --- rules,
 * paragraphs. Inline: code spans, bold (double star), italic (star or
 * underscore), [links](https://…). Everything is rendered through React
 * (no innerHTML) — content stays escaped.
 */
export function Markdown(props: { text: string }): ReactNode {
  return <div className="md">{renderBlocks(props.text)}</div>;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)\s*(\S*)\s*$/;

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().length === 0) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(
        <pre className="md-code" key={key++} data-lang={lang || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      out.push(
        <Tag className={`md-h md-h${level}`} key={key++}>
          {renderInline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push(<hr className="md-hr" key={key++} />);
      i++;
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      const body: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(QUOTE_RE);
        if (!m) break;
        body.push(m[1]);
        i++;
      }
      out.push(
        <blockquote className="md-quote" key={key++}>
          {renderBlocks(body.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const children = items.map((item, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static parse output, never reorders
        <li key={j}>{renderInline(item)}</li>
      ));
      out.push(
        ordered ? (
          <ol className="md-list" key={key++}>
            {children}
          </ol>
        ) : (
          <ul className="md-list" key={key++}>
            {children}
          </ul>
        ),
      );
      continue;
    }

    // paragraph: consume until a blank line or another block construct
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !HEADING_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p className="md-p" key={key++}>
        {renderInline(para.join("\n"))}
      </p>,
    );
  }
  return out;
}

// Inline tokenizer: code spans first (their content is verbatim), then links,
// then bold, then italic — applied recursively to the remaining plain spans.
const INLINE_CODE_RE = /`([^`\n]+)`/;
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/;
const BOLD_RE = /\*\*([^*\n]+)\*\*/;
const ITALIC_RE = /(?:^|[^*\w])\*([^*\n]+)\*|(?:^|[^_\w])_([^_\n]+)_/;

function renderInline(text: string): ReactNode[] {
  return tokenize(text, 0);
}

/** stage: 0 = code, 1 = link, 2 = bold, 3 = italic, 4 = plain text. */
function tokenize(text: string, stage: number): ReactNode[] {
  if (text.length === 0) return [];
  if (stage >= 4) return [text];

  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    let m: RegExpMatchArray | null = null;
    if (stage === 0) m = rest.match(INLINE_CODE_RE);
    else if (stage === 1) m = rest.match(LINK_RE);
    else if (stage === 2) m = rest.match(BOLD_RE);
    else m = rest.match(ITALIC_RE);

    if (!m || m.index === undefined) {
      out.push(...tokenize(rest, stage + 1));
      break;
    }

    // ITALIC_RE may capture a leading non-word char — keep it in the "before" span.
    let start = m.index;
    let matched = m[0];
    if (stage === 3 && matched.length > 0 && !matched.startsWith("*") && !matched.startsWith("_")) {
      start += 1;
      matched = matched.slice(1);
    }

    if (start > 0) out.push(...tokenize(rest.slice(0, start), stage + 1));

    if (stage === 0) {
      out.push(
        <code className="md-inline-code" key={`c${key++}`}>
          {m[1]}
        </code>,
      );
    } else if (stage === 1) {
      out.push(
        <a className="md-link" href={m[2]} target="_blank" rel="noreferrer" key={`l${key++}`}>
          {tokenize(m[1], stage + 1)}
        </a>,
      );
    } else if (stage === 2) {
      out.push(<strong key={`b${key++}`}>{tokenize(m[1], stage + 1)}</strong>);
    } else {
      out.push(<em key={`i${key++}`}>{tokenize(m[1] ?? m[2] ?? "", stage + 1)}</em>);
    }

    rest = rest.slice(start + matched.length);
  }
  return out;
}
