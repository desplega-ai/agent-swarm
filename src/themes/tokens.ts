/**
 * Page theme token contract: the dashboard token names that HTML pages
 * (design version 2) expose.
 *
 * A page's look comes only from these custom properties. Presets, per-page
 * overrides and imported themes all resolve to this set, so one switch
 * restyles the whole page. Sidebar, action, peer, type-scale and easing
 * tokens are dashboard-only and stay out of the contract.
 */

/** Color tokens: one value per mode. */
export const PAGE_THEME_COLOR_TOKENS = [
  "--color-background",
  "--color-foreground",
  "--color-card",
  "--color-card-foreground",
  "--color-surface",
  "--color-popover",
  "--color-popover-foreground",
  "--color-primary",
  "--color-primary-foreground",
  "--color-secondary",
  "--color-secondary-foreground",
  "--color-muted",
  "--color-muted-foreground",
  "--color-accent",
  "--color-accent-foreground",
  "--color-destructive",
  "--color-destructive-foreground",
  "--color-border",
  "--color-border-subtle",
  "--color-input",
  "--color-ring",
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-status-success",
  "--color-status-success-strong",
  "--color-status-success-foreground",
  "--color-status-active",
  "--color-status-active-strong",
  "--color-status-active-foreground",
  "--color-status-error",
  "--color-status-error-strong",
  "--color-status-error-foreground",
  "--color-status-info",
  "--color-status-info-strong",
  "--color-status-info-foreground",
  "--color-status-pending",
  "--color-status-pending-strong",
  "--color-status-pending-foreground",
  "--color-status-warning",
  "--color-status-warning-strong",
  "--color-status-warning-foreground",
  "--color-status-paused",
  "--color-status-paused-strong",
  "--color-status-paused-foreground",
  "--color-status-neutral",
  "--color-status-neutral-strong",
  "--color-status-neutral-foreground",
  "--color-status-success-solid",
  "--color-status-active-solid",
] as const;

/** Font and radius tokens: one value for both modes. */
export const PAGE_THEME_SHARED_TOKENS = [
  "--font-sans",
  "--font-mono",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
] as const;

export const PAGE_THEME_TOKENS = [...PAGE_THEME_COLOR_TOKENS, ...PAGE_THEME_SHARED_TOKENS] as const;

export type PageThemeToken = (typeof PAGE_THEME_TOKENS)[number];
export type PageThemeTokenValues = Partial<Record<PageThemeToken, string>>;
export type PageThemeTokens = { light: PageThemeTokenValues; dark: PageThemeTokenValues };

type PageThemeColorToken = (typeof PAGE_THEME_COLOR_TOKENS)[number];
type PageThemeSharedToken = (typeof PAGE_THEME_SHARED_TOKENS)[number];

/** Hive values from the light `@theme` block of `apps/ui/src/styles/globals.css`. */
const HIVE_SHARED_TOKENS: Record<PageThemeSharedToken, string> = {
  "--font-sans": '"Space Grotesk", sans-serif',
  "--font-mono": '"Space Mono", monospace',
  "--radius-sm": "0.375rem",
  "--radius-md": "0.5rem",
  "--radius-lg": "0.625rem",
  "--radius-xl": "0.625rem",
};

const HIVE_LIGHT_COLORS: Record<PageThemeColorToken, string> = {
  "--color-background": "oklch(1 0 0)",
  "--color-foreground": "oklch(0.141 0.005 285.823)",
  "--color-card": "oklch(1 0 0)",
  "--color-card-foreground": "oklch(0.141 0.005 285.823)",
  "--color-surface": "oklch(0.985 0.0015 286)",
  "--color-popover": "oklch(1 0 0)",
  "--color-popover-foreground": "oklch(0.141 0.005 285.823)",
  "--color-primary": "oklch(0.555 0.163 48.998)",
  "--color-primary-foreground": "oklch(0.985 0 0)",
  "--color-secondary": "oklch(0.967 0.001 286.375)",
  "--color-secondary-foreground": "oklch(0.21 0.006 285.885)",
  "--color-muted": "oklch(0.967 0.001 286.375)",
  "--color-muted-foreground": "oklch(0.552 0.016 285.938)",
  "--color-accent": "oklch(0.943 0.003 286.375)",
  "--color-accent-foreground": "oklch(0.21 0.006 285.885)",
  "--color-destructive": "oklch(0.577 0.245 27.325)",
  "--color-destructive-foreground": "oklch(0.985 0 0)",
  "--color-border": "oklch(0.92 0.004 286.32)",
  "--color-border-subtle": "oklch(0.945 0.003 286)",
  "--color-input": "oklch(0.92 0.004 286.32)",
  "--color-ring": "oklch(0.555 0.163 48.998)",
  "--color-chart-1": "oklch(0.646 0.222 41.116)",
  "--color-chart-2": "oklch(0.6 0.118 184.704)",
  "--color-chart-3": "oklch(0.398 0.07 227.392)",
  "--color-chart-4": "oklch(0.828 0.189 84.429)",
  "--color-chart-5": "oklch(0.769 0.188 70.08)",
  "--color-status-success": "oklch(0.74 0.1 163)",
  "--color-status-success-strong": "oklch(0.5 0.09 163)",
  "--color-status-success-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-active": "oklch(0.81 0.11 75)",
  "--color-status-active-strong": "oklch(0.55 0.1 68)",
  "--color-status-active-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-error": "oklch(0.72 0.12 25)",
  "--color-status-error-strong": "oklch(0.51 0.14 25)",
  "--color-status-error-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-info": "oklch(0.74 0.09 235)",
  "--color-status-info-strong": "oklch(0.5 0.09 240)",
  "--color-status-info-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-pending": "oklch(0.84 0.1 95)",
  "--color-status-pending-strong": "oklch(0.55 0.09 90)",
  "--color-status-pending-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-warning": "oklch(0.76 0.11 55)",
  "--color-status-warning-strong": "oklch(0.53 0.11 50)",
  "--color-status-warning-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-paused": "oklch(0.71 0.1 262)",
  "--color-status-paused-strong": "oklch(0.5 0.1 262)",
  "--color-status-paused-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-neutral": "oklch(0.62 0.014 286)",
  "--color-status-neutral-strong": "oklch(0.48 0.014 286)",
  "--color-status-neutral-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-success-solid": "oklch(0.627 0.194 149.2)",
  "--color-status-active-solid": "oklch(0.666 0.179 58.318)",
};

const HIVE_DARK_COLORS: Record<PageThemeColorToken, string> = {
  "--color-background": "oklch(0.141 0.005 285.823)",
  "--color-foreground": "oklch(0.985 0 0)",
  "--color-card": "oklch(0.21 0.006 285.885)",
  "--color-card-foreground": "oklch(0.985 0 0)",
  "--color-surface": "oklch(0.185 0.006 286)",
  "--color-popover": "oklch(0.21 0.006 285.885)",
  "--color-popover-foreground": "oklch(0.985 0 0)",
  "--color-primary": "oklch(0.769 0.188 70.08)",
  "--color-primary-foreground": "oklch(0.21 0.006 285.885)",
  "--color-secondary": "oklch(0.274 0.006 286.033)",
  "--color-secondary-foreground": "oklch(0.985 0 0)",
  "--color-muted": "oklch(0.274 0.006 286.033)",
  "--color-muted-foreground": "oklch(0.705 0.015 286.067)",
  "--color-accent": "oklch(0.274 0.006 286.033)",
  "--color-accent-foreground": "oklch(0.985 0 0)",
  "--color-destructive": "oklch(0.704 0.191 22.216)",
  "--color-destructive-foreground": "oklch(0.985 0 0)",
  "--color-border": "oklch(1 0 0 / 10%)",
  "--color-border-subtle": "oklch(1 0 0 / 8%)",
  "--color-input": "oklch(1 0 0 / 15%)",
  "--color-ring": "oklch(0.769 0.188 70.08)",
  "--color-chart-1": "oklch(0.488 0.243 264.376)",
  "--color-chart-2": "oklch(0.696 0.17 162.48)",
  "--color-chart-3": "oklch(0.769 0.188 70.08)",
  "--color-chart-4": "oklch(0.627 0.265 303.9)",
  "--color-chart-5": "oklch(0.645 0.246 16.439)",
  "--color-status-success": "oklch(0.78 0.1 163)",
  "--color-status-success-strong": "oklch(0.78 0.1 163)",
  "--color-status-success-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-active": "oklch(0.84 0.1 80)",
  "--color-status-active-strong": "oklch(0.84 0.1 80)",
  "--color-status-active-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-error": "oklch(0.74 0.11 22)",
  "--color-status-error-strong": "oklch(0.74 0.11 22)",
  "--color-status-error-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-info": "oklch(0.78 0.09 235)",
  "--color-status-info-strong": "oklch(0.78 0.09 235)",
  "--color-status-info-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-pending": "oklch(0.86 0.09 95)",
  "--color-status-pending-strong": "oklch(0.86 0.09 95)",
  "--color-status-pending-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-warning": "oklch(0.79 0.1 55)",
  "--color-status-warning-strong": "oklch(0.79 0.1 55)",
  "--color-status-warning-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-paused": "oklch(0.74 0.09 260)",
  "--color-status-paused-strong": "oklch(0.74 0.09 260)",
  "--color-status-paused-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-neutral": "oklch(0.72 0.012 286)",
  "--color-status-neutral-strong": "oklch(0.72 0.012 286)",
  "--color-status-neutral-foreground": "oklch(0.21 0.006 285.885)",
  "--color-status-success-solid": "oklch(0.723 0.219 149.6)",
  "--color-status-active-solid": "oklch(0.769 0.188 70.08)",
};

/**
 * Full Hive values for every contract token, copied from the light `@theme`
 * and `.dark` blocks of `apps/ui/src/styles/globals.css` (keep in sync;
 * `themes-presets.test.ts` fails on drift). The shared font and radius
 * tokens come from the light block and apply to both modes.
 */
export const HIVE_PAGE_TOKENS: {
  light: Record<PageThemeToken, string>;
  dark: Record<PageThemeToken, string>;
} = {
  light: { ...HIVE_LIGHT_COLORS, ...HIVE_SHARED_TOKENS },
  dark: { ...HIVE_DARK_COLORS, ...HIVE_SHARED_TOKENS },
};
