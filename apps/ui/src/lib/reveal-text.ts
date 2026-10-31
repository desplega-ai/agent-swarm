/**
 * Fake streaming for polled text. The dashboard polls about every 5 s, so the
 * text of a running task lands in chunks. `useRevealText`
 * (`hooks/use-reveal-text.ts`) shows the new part a few words at a time.
 * These pure helpers pick where each step cuts the text.
 */

/** One reveal step every 30 ms. */
export const REVEAL_STEP_MS = 30;

/**
 * The shown text never lags the real text by more than this. A step takes
 * more words when the words left do not fit in the steps left. It is under
 * the 5 s poll, so one chunk is done before the next one lands.
 */
export const REVEAL_MAX_LAG_MS = 4000;

/**
 * A word, with the markdown marks in front of it (a list dash, `1.`, `#`,
 * `>`, a table bar). A mark alone renders as something else for one step:
 * a dash under a line turns that line into a heading.
 */
const WORD = /(?:(?:[-*+>#|]+|\d+[.)])[ \t]+)*\S+/g;

function wordsAfter(text: string, from: number): number {
  WORD.lastIndex = from;
  let count = 0;
  while (WORD.exec(text)) count++;
  return count;
}

/** The end of the `count`th word after `from`. */
function wordEnd(text: string, from: number, count: number): number {
  WORD.lastIndex = from;
  let end = from;
  for (let i = 0; i < count; i++) {
    const match = WORD.exec(text);
    if (!match) break;
    end = match.index + match[0].length;
  }
  return end;
}

/**
 * Where the next step cuts `text` when `shown` characters show: one more
 * word, or more when the words left do not fit in the steps left before
 * `msLeft` runs out. It cuts only at the end of a word. With one step or
 * less left, it shows the whole text.
 */
export function nextRevealLength(text: string, shown: number, msLeft: number): number {
  const words = wordsAfter(text, shown);
  const steps = Math.floor(msLeft / REVEAL_STEP_MS);
  const take = Math.max(1, Math.ceil(words / Math.max(1, steps)));
  if (steps <= 1 || take >= words) return text.length;
  return wordEnd(text, shown, take);
}

/**
 * Where a reveal continues when the text changes. When the new text starts
 * with `shown` (the text grew), all of `shown` stays. Otherwise (the text was
 * replaced), the words that the two texts share at the start stay.
 */
export function revealStart(shown: string, text: string): number {
  if (text.startsWith(shown)) return shown.length;
  let cut = 0;
  while (cut < shown.length && shown[cut] === text[cut]) cut++;
  // Drop a word that the change cut in two, then the spaces before it.
  if (/\S/.test(text.charAt(cut))) {
    while (cut > 0 && /\S/.test(text.charAt(cut - 1))) cut--;
  }
  while (cut > 0 && /\s/.test(text.charAt(cut - 1))) cut--;
  return cut;
}
