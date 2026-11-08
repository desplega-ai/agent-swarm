/**
 * The scope context, apart from `link-preview-state.tsx` so a card (which the
 * preview panel itself renders) can read it without importing the panel.
 */

import { createContext, useContext } from "react";

export interface LinkPreviewScopeValue {
  /** Called by a mounted dock; returns the unregister call. */
  registerDock: () => () => void;
}

export const LinkPreviewScopeContext = createContext<LinkPreviewScopeValue | null>(null);

/** The scope a dock registers with; null outside a `LinkPreviewScope`. */
export function useLinkPreviewScope(): LinkPreviewScopeValue | null {
  return useContext(LinkPreviewScopeContext);
}
