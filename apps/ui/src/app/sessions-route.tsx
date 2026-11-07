import { type ComponentType, useState } from "react";
import { lazyRoute } from "@/components/shared/app-update-prompt";

const loadSessionsPage = () => import("@/pages/sessions/page");
const LazySessionsPage = lazyRoute(loadSessionsPage);
let loadedPage: ComponentType | undefined;

/** Prepare the component as well as its chunk, so the setup handoff never suspends. */
export async function preloadSessionsPage() {
  loadedPage = (await loadSessionsPage()).default;
}

export function SessionsRoute() {
  // A late preload must not remount a session that already opened lazily.
  const [Page] = useState(() => loadedPage ?? LazySessionsPage);
  return <Page />;
}
