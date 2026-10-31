/**
 * Hardcoded colors in an HTML page body. A design version 2 page should take
 * every color from a theme token. A body with `COLOR_LITERAL_THRESHOLD` or more
 * hardcoded colors gets two things: `create_page` steers its author toward
 * tokens (`NUDGES.create_page`), and `/p/:id` serves it light also when the
 * viewer asks for dark mode, because its hardcoded light surfaces would put
 * dark-mode text on them.
 */

/** From this many hardcoded colors on, a page counts as hardcoded. */
export const COLOR_LITERAL_THRESHOLD = 8;

/**
 * A `<style>` block (an unclosed one runs to the end of the body), a `style="..."`
 * attribute, or a `class="..."` attribute. The tag's own attributes are capped at
 * 200 characters: an unbounded `[^>]*` makes a body of many unterminated `<style`
 * tags cost quadratic time.
 */
const STYLE_BLOCK = /<style\b[^>]{0,200}>([\s\S]*?)(?:<\/style\s*>|$)/gi;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CLASS_ATTRIBUTE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/**
 * In style regions: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and the rgb, rgba,
 * hsl, hsla and oklch functions.
 */
const COLOR_LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|oklch)\(/gi;
/**
 * In style regions: the `white` and `black` keywords as values, not inside a name
 * such as `white-space`, `.white` or `--black`. Lowercase only, so a font name such
 * as "Archivo Black" does not count.
 */
const NAMED_COLOR = /(?<![\w.#-])(?:white|black)(?![\w-])/g;
const PALETTE_UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "outline",
  "divide",
  "fill",
  "stroke",
  "from",
  "via",
  "to",
  "decoration",
  "accent",
  "caret",
  "placeholder",
  "shadow",
];
const TAILWIND_PALETTE = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];
/**
 * In class attributes: Tailwind palette classes (`bg-blue-500`, `hover:text-gray-600/80`),
 * `bg-white`, `bg-black`, `text-white`, `text-black`, and arbitrary color values
 * (`bg-[#fff]`, `text-[rgb(0_0_0)]`, `-[hsl`, `-[oklch`).
 */
const COLOR_CLASS = new RegExp(
  `(?<![\\w-])(?:(?:${PALETTE_UTILITIES.join("|")})-(?:${TAILWIND_PALETTE.join("|")})-\\d+|(?:bg|text)-(?:white|black))(?![\\w-])|-\\[(?:#|rgb|hsl|oklch)`,
  "g",
);

function attributeValues(html: string, attribute: RegExp): string[] {
  return Array.from(html.matchAll(attribute), (match) => match[1] ?? match[2] ?? "");
}

/** The values of every `class="..."` attribute in an HTML body. */
export function classAttributeValues(html: string): string[] {
  return attributeValues(html, CLASS_ATTRIBUTE);
}

function countMatches(regions: string[], pattern: RegExp): number {
  return regions.reduce((total, region) => total + (region.match(pattern)?.length ?? 0), 0);
}

/**
 * Counts the hardcoded colors of an HTML page body: color literals and the
 * `white` / `black` keywords in its `<style>` blocks and `style="..."`
 * attributes, and color classes in its `class="..."` attributes. A page on the
 * design system should use theme tokens instead, so a high count means a theme
 * switch will not restyle it.
 */
export function countColorLiterals(html: string): number {
  const styles = [
    ...Array.from(html.matchAll(STYLE_BLOCK), (match) => match[1] ?? ""),
    ...attributeValues(html, STYLE_ATTRIBUTE),
  ];
  return (
    countMatches(styles, COLOR_LITERAL) +
    countMatches(styles, NAMED_COLOR) +
    countMatches(classAttributeValues(html), COLOR_CLASS)
  );
}
