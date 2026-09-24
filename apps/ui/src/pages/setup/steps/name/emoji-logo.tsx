import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Emoji logos served by the Emoji Family API as SVG, always in the Fluent
 * pack: `https://www.emoji.family/api/emojis/<hexcode>/fluent/svg`.
 *
 * Checked with real requests on 2026-09-24: Fluent answers 200 for every
 * suggestion below, with or without FE0F. The API sends no CORS headers, so
 * the UI checks an image by loading it, never with `fetch`.
 */
const EMOJI_SUGGESTIONS = [
  "🐝",
  "🤖",
  "🧠",
  "🚀",
  "⚡",
  "🛰️",
  "🦾",
  "🧪",
  "🔧",
  "🌊",
  "🔥",
  "🌱",
  "🦉",
  "🐙",
  "🎯",
  "🧭",
];

const EMOJI_API = "https://www.emoji.family/api/emojis";
/** Any pack: an older logo in another pack still opens as its emoji. */
const EMOJI_URL_RE =
  /^https:\/\/www\.emoji\.family\/api\/emojis\/([0-9A-F]+(?:-[0-9A-F]+)*)\/[a-z]+\/svg$/i;

/** Code points in uppercase hex, hyphen-separated ("1F41D", "2764-FE0F-200D-1F525"). */
function hexcode(emoji: string, withoutFe0f: boolean): string {
  return [...emoji]
    .map((char) => char.codePointAt(0)?.toString(16).toUpperCase() ?? "")
    .filter((hex) => hex && !(withoutFe0f && hex === "FE0F"))
    .join("-");
}

/** Two emoji are the same when they match without variation selectors. */
function sameEmoji(a: string, b: string): boolean {
  return a !== "" && hexcode(a, true) === hexcode(b, true);
}

/**
 * Fluent URLs to try, in order: every code point first, then without FE0F
 * (the API answers 404 for some sequences in one form and 200 in the other).
 */
export function emojiLogoCandidates(emoji: string): string[] {
  const full = `${EMOJI_API}/${hexcode(emoji, false)}/fluent/svg`;
  const bare = `${EMOJI_API}/${hexcode(emoji, true)}/fluent/svg`;
  return full === bare ? [full] : [full, bare];
}

/** The emoji of a stored emoji.family logo URL, or null for any other URL. */
export function parseEmojiLogo(url: string | null | undefined): string | null {
  const match = url?.trim().match(EMOJI_URL_RE);
  if (!match) return null;
  try {
    return String.fromCodePoint(...match[1].split("-").map((hex) => Number.parseInt(hex, 16)));
  } catch {
    return null;
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// The last alternative is U+20E3, the keycap mark of "1️⃣".
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/** The last emoji in `text` (the one just typed or pasted), or "" when it has none. */
export function lastEmoji(text: string): string {
  const parts = [...graphemes.segment(text)].map((part) => part.segment);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (EMOJI_RE.test(parts[i])) return parts[i];
  }
  return "";
}

function imageLoads(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

export type EmojiImage =
  | { status: "empty" | "checking" | "missing"; url: null }
  | { status: "ok"; url: string };

/** The first candidate URL that loads as an image. */
export function useEmojiImage(candidates: string[]): EmojiImage {
  const key = candidates.join(" ");
  const [result, setResult] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void (async () => {
      for (const url of key.split(" ")) {
        if (await imageLoads(url)) {
          if (!cancelled) setResult({ key, url });
          return;
        }
      }
      if (!cancelled) setResult({ key, url: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!key) return { status: "empty", url: null };
  if (result?.key !== key) return { status: "checking", url: null };
  return result.url ? { status: "ok", url: result.url } : { status: "missing", url: null };
}

/** Sixteen suggestions, one click each. */
export function EmojiSuggestions({
  selected,
  onPick,
}: {
  selected: string;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-1">
      {EMOJI_SUGGESTIONS.map((emoji) => {
        const active = sameEmoji(selected, emoji);
        return (
          <Button
            key={emoji}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Use ${emoji}`}
            aria-pressed={active}
            onClick={() => onPick(emoji)}
            className={cn("text-lg", active && "bg-primary/10 ring-1 ring-primary/50")}
          >
            {emoji}
          </Button>
        );
      })}
    </div>
  );
}
