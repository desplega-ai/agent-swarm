/**
 * Dashboard UI font: a per-browser choice on Settings → Appearance.
 *
 * The choice is a `data-font` attribute on <html>; globals.css maps each value
 * to `--font-sans` (and `--font-mono` where the family ships a mono cut). The
 * Hive default sets no attribute and loads nothing beyond index.html's Space
 * fonts. Web fonts are self-hosted from @fontsource and fetched as their own
 * CSS chunk only when that option is applied. main.tsx applies the stored
 * choice before the first render, so the first paint already uses it.
 */

export type UiFontId = "hive" | "system" | "atkinson" | "opendyslexic" | "lexend";

export interface UiFontOption {
  id: UiFontId;
  label: string;
  hint: string;
  /** Fetches the font's @font-face rules. Absent for fonts already on the page. */
  load?: () => Promise<unknown>;
}

export const UI_FONT_STORAGE_KEY = "agent-swarm-ui-font";
export const DEFAULT_UI_FONT: UiFontId = "hive";

export const UI_FONT_OPTIONS: readonly UiFontOption[] = [
  { id: "hive", label: "Hive default", hint: "Space Grotesk, code in Space Mono" },
  { id: "system", label: "System", hint: "Your OS font, code in your OS mono font" },
  {
    id: "atkinson",
    label: "Atkinson Hyperlegible",
    hint: "Distinct letterforms for low vision, code in its mono cut",
    load: () =>
      Promise.all([
        import("@fontsource-variable/atkinson-hyperlegible-next"),
        import("@fontsource-variable/atkinson-hyperlegible-mono"),
      ]),
  },
  {
    id: "opendyslexic",
    label: "OpenDyslexic",
    hint: "Weighted letter bottoms for dyslexia, code in Space Mono",
    load: () =>
      Promise.all([
        import("@fontsource/opendyslexic/400.css"),
        import("@fontsource/opendyslexic/700.css"),
      ]),
  },
  {
    id: "lexend",
    label: "Lexend",
    hint: "Wide spacing for reading fluency, code in Space Mono",
    load: () => import("@fontsource-variable/lexend"),
  },
];

export function isUiFontId(value: unknown): value is UiFontId {
  return UI_FONT_OPTIONS.some((option) => option.id === value);
}

export function readStoredUiFont(): UiFontId {
  try {
    const stored = localStorage.getItem(UI_FONT_STORAGE_KEY);
    if (isUiFontId(stored)) return stored;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return DEFAULT_UI_FONT;
}

export function storeUiFont(id: UiFontId): void {
  try {
    if (id === DEFAULT_UI_FONT) localStorage.removeItem(UI_FONT_STORAGE_KEY);
    else localStorage.setItem(UI_FONT_STORAGE_KEY, id);
  } catch {
    // Storage unavailable: the choice holds for this page load only.
  }
}

/**
 * Sets `data-font` on the root and starts the font download when needed. The
 * attribute goes on first, so text renders in the fallback stack until the
 * face arrives (`font-display: swap`) instead of in the Hive font.
 */
export function applyUiFont(id: UiFontId, root: HTMLElement = document.documentElement): void {
  if (id === DEFAULT_UI_FONT) root.removeAttribute("data-font");
  else root.setAttribute("data-font", id);
  const option = UI_FONT_OPTIONS.find((candidate) => candidate.id === id);
  option?.load?.().catch(() => {
    // Offline or a stale chunk after a deploy: the fallback stack stays.
  });
}
