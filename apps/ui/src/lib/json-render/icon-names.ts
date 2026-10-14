/**
 * The curated icon names a swarm-app definition may use (`icon` props and the
 * `Icon` block). A closed list, not every lucide icon: the zod enum validates
 * names and gives authors autocomplete, and the static map in `./icons` keeps
 * the bundle tree-shaken.
 *
 * Kept free of React imports so `scripts/generate-catalog-schema.ts` can load
 * `catalog.ts` under plain `bun run`.
 */
export const ICON_NAMES = [
  "plus",
  "refresh-cw",
  "search",
  "filter",
  "download",
  "upload",
  "external-link",
  "copy",
  "check",
  "x",
  "trash-2",
  "pencil",
  "eye",
  "calendar",
  "clock",
  "user",
  "users",
  "bot",
  "git-pull-request",
  "git-branch",
  "github",
  "slack",
  "mail",
  "link",
  "file-text",
  "folder",
  "database",
  "zap",
  "sparkles",
  "flag",
  "star",
  "tag",
  "alert-triangle",
  "info",
  "circle-check",
  "trending-up",
  "trending-down",
  "dollar-sign",
  "activity",
  "rocket",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
