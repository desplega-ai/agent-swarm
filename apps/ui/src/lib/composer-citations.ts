import { useCallback, useMemo } from "react";
import { useComposerDraft } from "./composer-drafts";

export interface ComposerCitations {
  quotes: string[];
  remove: (index: number) => void;
  clear: () => void;
}

function readQuotes(text: string): string[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((quote) => typeof quote === "string") ? value : [];
  } catch {
    return [];
  }
}

export function useComposerCitations(sessionId: string | undefined) {
  const { text, setText, clear } = useComposerDraft(sessionId && `session-citations:${sessionId}`);
  const quotes = useMemo(() => readQuotes(text), [text]);
  const add = useCallback(
    (quote: string) => setText(JSON.stringify([...quotes, quote])),
    [quotes, setText],
  );
  return {
    quotes,
    add,
    remove: (index: number) => {
      if (quotes.length === 1) clear();
      else setText(JSON.stringify(quotes.filter((_, i) => i !== index)));
    },
    clear,
  };
}

export function messageWithCitations(draft: string, citations?: ComposerCitations): string {
  const quotes = citations?.quotes.map((quote) =>
    quote
      .split(/\r\n?|\n/)
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n"),
  );
  return [...(quotes ?? []), draft.trim()].filter(Boolean).join("\n\n");
}
