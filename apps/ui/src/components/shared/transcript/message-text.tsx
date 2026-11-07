import { MarkdownView } from "@/components/shared/markdown-view";

/**
 * A person's message text in a chat bubble: markdown, or the raw text that
 * was sent (`raw`, switched by `MessageRawToggle`). The bubble keeps
 * `whitespace-pre-wrap` for the raw text. HTML tags show as written (a
 * person's `Promise<void>` is prose). The markdown resets the whitespace, its
 * headings stay at the bubble's text size, and inline code takes the page
 * background so it shows on the muted bubble.
 */
export function MessageText({ text, raw }: { text: string; raw: boolean }) {
  if (raw) return text;
  return (
    <div
      data-slot="message-markdown"
      className="min-w-0 whitespace-normal [&_code]:bg-background [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:text-[1em] [&_:is(h1,h2,h3,h4,h5,h6)]:first:mt-0"
    >
      <MarkdownView text={text} html={false} />
    </div>
  );
}
