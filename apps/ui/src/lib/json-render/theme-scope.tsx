/**
 * App-theme scope for json-render surfaces.
 *
 * A swarm-app canvas carries its preset through a `data-theme` attribute on
 * the surface wrapper (CSS custom properties cascade to everything inside).
 * Radix portals (Select dropdowns, the Drawer sheet, action-confirm dialogs)
 * mount on `<body>` — OUTSIDE that wrapper — so they would silently fall back
 * to the dashboard theme. Portal-rendering catalog components read this
 * context and stamp the same `data-theme` onto their portalled content
 * element instead.
 */

import { createContext, useContext } from "react";

const JsonRenderThemeContext = createContext<string | null>(null);

export const JsonRenderThemeProvider = JsonRenderThemeContext.Provider;

/**
 * Attribute bag for a portalled element: `{ "data-theme": <id> }` inside a
 * themed surface, `{}` outside one — spread it, unconditionally.
 */
export function useJsonRenderThemeAttr(): { "data-theme"?: string } {
  const theme = useContext(JsonRenderThemeContext);
  return theme ? { "data-theme": theme } : {};
}
