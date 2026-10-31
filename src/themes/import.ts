/**
 * Theme importers: the boundary between outside theme formats and the page
 * token contract (`tokens.ts`).
 *
 * An importer turns an outside format into `PageThemeTokens`. Each importer
 * in `THEME_IMPORTERS` only reads its format into raw `name: value`
 * declarations per mode. `importThemeTokens` then maps the names onto the
 * contract and checks every value, the same way for every format. Pages
 * store the normalized result and render it, so nothing after this module
 * knows which format a theme came from.
 *
 * Formats today:
 * - `tokens` (the default): JSON maps `{ light, dark }` of token name to value.
 * - `css`: a CSS custom-property block, as shadcn, tweakcn and Tailwind v4
 *   produce. A selector list is split at its commas, and the block feeds each
 *   mode that one of its parts names (`:root, .dark` feeds both). Light:
 *   `:root`, `:host`, `html`, and `@theme` / `@theme inline`. Dark: `.dark`,
 *   `:root.dark`, `html.dark`, `[data-theme=dark]` (quoted or not), and a
 *   light selector inside `@media (prefers-color-scheme: dark)`.
 *   `@layer` wrappers are read through (shadcn for Tailwind v3 puts `:root`
 *   inside `@layer base`). The custom properties of every other block (other
 *   selectors, other media queries, nested rules) go to `ignored` with the
 *   block, for example `--ring (in .card)`. Comments and plain properties are
 *   skipped. Only CSS without a light or dark block throws.
 *
 * To add a format (for example Figma / DTCG), add three things:
 * 1. The importer: `importDtcg` reads a DTCG document into raw declarations.
 *    Register it in `THEME_IMPORTERS`, and add its input shape to
 *    `ThemeImportInput`.
 * 2. "dtcg" in `THEME_IMPORT_FORMATS`. The page input schema
 *    (`PageThemeTokensInputSchema` in src/types.ts) builds its `format` enum
 *    from this list.
 * 3. Only when the format needs a new payload field (for example a DTCG
 *    `document`): that one field in `PageThemeTokensInputSchema`.
 * Storage and rendering stay the same.
 *
 * Normalization, for every format:
 * - `--color-primary`, `--primary`, `primary` and `color-primary` all name
 *   `--color-primary`. Font and radius names map the same way (`font-sans`).
 * - shadcn `--radius` expands to the four radius tokens. An explicit radius
 *   token wins over the expansion.
 * - A bare HSL triplet (`222.2 47.4% 11.2%`) is wrapped as `hsl(...)`.
 * - `var()` references are renamed the same way (`var(--primary)` becomes
 *   `var(--color-primary)`, and `var(--radius)` becomes `var(--radius-lg)`).
 *   A declaration that references its own token (the `@theme inline`
 *   plumbing, `--color-primary: var(--primary)`) adds nothing and is dropped.
 *   A reference to a name outside the contract cannot resolve on the page,
 *   so that declaration goes to `ignored` with the reference, for example
 *   `--font-sans (references --font-geist-sans)`.
 * - Names outside the contract (`--sidebar`, `--shadow-2xs`, `--font-serif`)
 *   go to `ignored`. They never throw.
 * - A value must be 1 to 200 characters (a trailing `!important` is dropped
 *   first), without `; { } < > \`, control characters (newlines included),
 *   resource functions (`url`, `src`, `image`, `image-set`), `expression(`,
 *   `@import`, `javascript:` or comment markers, and
 *   with balanced quotes and parentheses, so it cannot break out of its
 *   declaration. A bad value throws. The length check runs before any regex,
 *   so a huge value costs one pass.
 */

import {
  PAGE_THEME_TOKENS,
  type PageThemeToken,
  type PageThemeTokens,
  type PageThemeTokenValues,
} from "./tokens";

export const THEME_IMPORT_FORMATS = ["tokens", "css"] as const;
export type ThemeImportFormat = (typeof THEME_IMPORT_FORMATS)[number];

export type ThemeImportInput =
  | { format?: "tokens"; light?: Record<string, string>; dark?: Record<string, string> }
  | { format: "css"; css: string };

/** A bad input shape or an unsafe value. The message names the bad key or value. */
export class ThemeImportError extends Error {
  override name = "ThemeImportError";
}

type ThemeMode = "light" | "dark";
type RawDeclaration = [name: string, value: string];
/**
 * Declarations per mode, in source order, with names not normalized yet, and
 * the `ignored` entries for what the importer read but could not place.
 */
type RawThemeTokens = Record<ThemeMode, RawDeclaration[]> & { skipped: string[] };
type ThemeImporter = (input: Record<string, unknown>) => RawThemeTokens;

const THEME_IMPORTERS: Record<ThemeImportFormat, ThemeImporter> = {
  tokens: readTokenMaps,
  css: readCssBlocks,
};

const MAX_VALUE_LENGTH = 200;
/** Room for a trailing `!important` and the spaces around it, on top of the value limit. */
const IMPORTANT_ROOM = 16;
/** Linear time: the only quantifier comes after the literal `!`. */
const IMPORTANT_SUFFIX = /!\s*important$/i;
const UNSAFE_CHARACTERS = ";{}<>\\";
const UNSAFE_PATTERN = /(?:url|src|image(?:-set)?|expression)\(|@import|javascript:|\/\*|\*\//i;
const HSL_TRIPLET = /^-?[\d.]+(?:deg)?\s+-?[\d.]+%\s+-?[\d.]+%(?:\s*\/\s*[\d.]+%?)?$/;
const VAR_REFERENCE = /var\(\s*--([\w-]+)/gi;
const CONTRACT_TOKENS: ReadonlySet<string> = new Set<string>(PAGE_THEME_TOKENS);
const RADIUS_STEPS: ReadonlyArray<[PageThemeToken, (radius: string) => string]> = [
  ["--radius-sm", (radius) => `calc(${radius} - 4px)`],
  ["--radius-md", (radius) => `calc(${radius} - 2px)`],
  ["--radius-lg", (radius) => radius],
  ["--radius-xl", (radius) => `calc(${radius} + 4px)`],
];

export function importThemeTokens(input: ThemeImportInput): {
  tokens: PageThemeTokens;
  ignored: string[];
} {
  const fields = readRecord(input, "themeTokens");
  const raw = THEME_IMPORTERS[readFormat(fields.format)](fields);
  const ignored = new Set<string>();
  const tokens: PageThemeTokens = {
    light: normalizeDeclarations(raw.light, "light", ignored),
    dark: normalizeDeclarations(raw.dark, "dark", ignored),
  };
  for (const entry of raw.skipped) ignored.add(entry);
  return { tokens, ignored: [...ignored] };
}

function readFormat(format: unknown): ThemeImportFormat {
  if (format === undefined || format === null) return "tokens";
  const known = THEME_IMPORT_FORMATS.find((candidate) => candidate === format);
  if (known) return known;
  throw new ThemeImportError(
    `unknown themeTokens format ${quote(format)}: use one of ${THEME_IMPORT_FORMATS.join(", ")}`,
  );
}

function readTokenMaps(input: Record<string, unknown>): RawThemeTokens {
  assertFields(input, "tokens", ["format", "light", "dark"]);
  return {
    light: readTokenMap(input.light, "light"),
    dark: readTokenMap(input.dark, "dark"),
    skipped: [],
  };
}

function readTokenMap(value: unknown, mode: ThemeMode): RawDeclaration[] {
  if (value === undefined || value === null) return [];
  return Object.entries(readRecord(value, `themeTokens.${mode}`)).map(
    ([name, tokenValue]): RawDeclaration => {
      if (typeof tokenValue !== "string") {
        throw new ThemeImportError(`themeTokens.${mode}[${quote(name)}] must be a string`);
      }
      return [name, tokenValue];
    },
  );
}

function readCssBlocks(input: Record<string, unknown>): RawThemeTokens {
  assertFields(input, "css", ["format", "css"]);
  if (typeof input.css !== "string") {
    throw new ThemeImportError('themeTokens.css must be a string of CSS (format "css")');
  }
  return parseCss(input.css);
}

/**
 * How a CSS block is read. A wrapper (the top level, `@layer`, the dark
 * color-scheme media query) reads the rules inside it. A theme rule feeds its
 * custom properties to its modes. Any other block reports its custom
 * properties as ignored, labeled with the outermost block that was not read.
 */
type CssBlock =
  | { kind: "wrapper"; dark: boolean }
  | { kind: "theme"; modes: ThemeMode[] }
  | { kind: "other"; label: string };

const TOP_LEVEL: CssBlock = { kind: "wrapper", dark: false };
const LIGHT_SELECTORS: ReadonlySet<string> = new Set([":root", ":host", "html"]);
const DARK_SELECTORS: ReadonlySet<string> = new Set([".dark", ":root.dark", "html.dark"]);
const DARK_ATTRIBUTE_SELECTOR = /^\[ ?data-theme ?= ?(["']?)dark\1 ?\]$/;
const DARK_MEDIA_QUERY = /^@media ?\( ?prefers-color-scheme ?: ?dark ?\)$/i;
const THEME_AT_RULE = /^@theme(?: [\w-]+)*$/;
const MAX_LABEL_LENGTH = 40;

function openCssBlock(prelude: string, parent: CssBlock): CssBlock {
  if (parent.kind === "other") return parent;
  const selector = prelude.trim().replace(/\s+/g, " ");
  if (parent.kind === "wrapper") {
    if (/^@layer(?: |$)/.test(selector)) return parent;
    if (DARK_MEDIA_QUERY.test(selector)) return { kind: "wrapper", dark: true };
    // `@theme` is a top-level Tailwind rule, so it does not count inside a media query.
    const modes: ThemeMode[] =
      THEME_AT_RULE.test(selector) && !parent.dark ? ["light"] : selectorModes(selector);
    if (modes.length > 0) return { kind: "theme", modes: parent.dark ? ["dark"] : modes };
  }
  const label =
    selector.length > MAX_LABEL_LENGTH ? `${selector.slice(0, MAX_LABEL_LENGTH)}...` : selector;
  return { kind: "other", label };
}

/** The modes that the parts of a selector list name. A part that names no mode adds nothing. */
function selectorModes(selector: string): ThemeMode[] {
  const modes = new Set<ThemeMode>();
  for (const part of selectorListParts(selector)) {
    if (LIGHT_SELECTORS.has(part)) modes.add("light");
    else if (DARK_SELECTORS.has(part) || DARK_ATTRIBUTE_SELECTOR.test(part)) modes.add("dark");
  }
  return [...modes];
}

/** Splits a selector list at the commas outside parentheses, brackets and strings. */
function selectorListParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === '"' || char === "'") index = closingQuoteIndex(selector, index);
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

/** Splits the CSS at `{`, `}` and `;` outside strings and parentheses, tracking block nesting. */
function parseCss(css: string): RawThemeTokens {
  const text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
  const raw: RawThemeTokens = { light: [], dark: [], skipped: [] };
  const blocks: CssBlock[] = [];
  let themeBlocks = 0;
  let start = 0;
  let parens = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = closingQuoteIndex(text, index);
      continue;
    }
    if (char === "(") parens++;
    else if (char === ")") parens = Math.max(0, parens - 1);
    if (parens > 0 || (char !== "{" && char !== "}" && char !== ";")) continue;
    const segment = text.slice(start, index);
    start = index + 1;
    const current = blocks.at(-1) ?? TOP_LEVEL;
    if (char === "{") {
      const block = openCssBlock(segment, current);
      if (block.kind === "theme") themeBlocks++;
      blocks.push(block);
      continue;
    }
    readCssDeclaration(segment, current, raw);
    if (char === "}" && blocks.pop() === undefined) {
      throw new ThemeImportError('themeTokens.css has an unmatched "}"');
    }
  }
  if (blocks.length > 0) throw new ThemeImportError('themeTokens.css has an unclosed "{" block');
  if (themeBlocks === 0) {
    throw new ThemeImportError("themeTokens.css has no :root, .dark, or @theme block");
  }
  return raw;
}

/** Index of the quote that closes the string opened at `open`. A CSS string also ends at a newline. */
function closingQuoteIndex(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === text[open] || char === "\n") return index;
  }
  return text.length;
}

/** Keeps custom properties only: a plain property such as `color` is not a theme token. */
function readCssDeclaration(segment: string, block: CssBlock, raw: RawThemeTokens): void {
  if (block.kind === "wrapper") return;
  const colon = segment.indexOf(":");
  if (colon === -1) return;
  const name = segment.slice(0, colon).trim();
  if (!name.startsWith("--")) return;
  if (block.kind === "other") {
    raw.skipped.push(`${name} (in ${block.label})`);
    return;
  }
  const value = segment.slice(colon + 1).replace(/\s+/g, " ");
  for (const mode of block.modes) raw[mode].push([name, value]);
}

function normalizeDeclarations(
  declarations: RawDeclaration[],
  mode: ThemeMode,
  ignored: Set<string>,
): PageThemeTokenValues {
  const explicit: PageThemeTokenValues = {};
  const expanded: PageThemeTokenValues = {};
  for (const [rawName, rawValue] of declarations) {
    const name = rawName.trim();
    const bare = name.replace(/^--/, "");
    const token = contractToken(bare);
    if (!token && bare !== "radius") {
      ignored.add(name);
      continue;
    }
    const renamed = renameReferences(checkedValue(rawValue, name, mode));
    if (renamed.outside.length > 0) {
      ignored.add(`${name} (references ${renamed.outside.join(", ")})`);
      continue;
    }
    if (token) {
      if (!renamed.references.has(token)) explicit[token] = renamed.value;
      continue;
    }
    for (const [step, size] of RADIUS_STEPS) {
      if (!renamed.references.has(step)) expanded[step] = size(renamed.value);
    }
  }
  return { ...expanded, ...explicit };
}

function isContractToken(name: string): name is PageThemeToken {
  return CONTRACT_TOKENS.has(name);
}

/** `primary` and `color-primary` (so also `--primary` and `--color-primary`) name `--color-primary`. */
function contractToken(bare: string): PageThemeToken | null {
  const direct = `--${bare}`;
  if (isContractToken(direct)) return direct;
  const color = `--color-${bare}`;
  return isContractToken(color) ? color : null;
}

/** Renames each `var(--x)` to its contract name, and lists the references outside the contract. */
function renameReferences(value: string): {
  value: string;
  references: Set<PageThemeToken>;
  outside: string[];
} {
  const references = new Set<PageThemeToken>();
  const outside = new Set<string>();
  const renamed = value.replace(VAR_REFERENCE, (reference, bare: string) => {
    const token = bare === "radius" ? "--radius-lg" : contractToken(bare);
    if (!token) {
      outside.add(`--${bare}`);
      return reference;
    }
    references.add(token);
    return `var(${token}`;
  });
  return { value: renamed, references, outside: [...outside] };
}

function checkedValue(rawValue: string, name: string, mode: ThemeMode): string {
  const trimmed = rawValue.trim();
  // An over-long value skips the strip, so it fails on its length before any regex reads it.
  const value =
    trimmed.length > MAX_VALUE_LENGTH + IMPORTANT_ROOM
      ? trimmed
      : trimmed.replace(IMPORTANT_SUFFIX, "").trimEnd();
  const problem = valueProblem(value);
  if (problem) throw new ThemeImportError(`${mode} token ${quote(name)}: ${problem}`);
  return HSL_TRIPLET.test(value) ? `hsl(${value})` : value;
}

function valueProblem(value: string): string | null {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) {
    return `value must be 1 to ${MAX_VALUE_LENGTH} characters`;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return "value must not contain a newline or a control character";
    }
    if (UNSAFE_CHARACTERS.includes(char)) return `value must not contain ${quote(char)}`;
  }
  const pattern = UNSAFE_PATTERN.exec(value);
  if (pattern) return `value must not contain ${quote(pattern[0])}`;
  return balanced(value) ? null : "value has an unclosed quote or parenthesis";
}

function balanced(value: string): boolean {
  let depth = 0;
  let open: string | null = null;
  for (const char of value) {
    if (open) {
      if (char === open) open = null;
    } else if (char === '"' || char === "'") open = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0 && open === null;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeImportError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

/** Rejects a field the format does not take. A field set to `undefined` counts as absent. */
function assertFields(
  input: Record<string, unknown>,
  format: ThemeImportFormat,
  allowed: readonly string[],
): void {
  const extra = Object.keys(input).find(
    (key) => input[key] !== undefined && !allowed.includes(key),
  );
  if (extra !== undefined) {
    throw new ThemeImportError(
      `unknown themeTokens field ${quote(extra)} for format "${format}" (allowed: ${allowed.join(", ")})`,
    );
  }
}

function quote(value: unknown): string {
  return String(JSON.stringify(value)).slice(0, 80);
}
