/**
 * The id of the swarm app a json-render surface renders, for catalog
 * components that key server state by app (`SessionThread` looks up its
 * session by `task:app:<appId>:…`). `null` outside an app surface (a page).
 */

import { createContext, useContext } from "react";

const AppScopeContext = createContext<string | null>(null);

export const AppScopeProvider = AppScopeContext.Provider;

export function useAppScopeId(): string | null {
  return useContext(AppScopeContext);
}
