import { Hash, SquareDashed } from "lucide-react";
import { TaskSourceMark } from "@/components/shared/task-source-mark";
import { sourceOfGroupKey } from "@/lib/session-groups";
import { cn } from "@/lib/utils";

/**
 * The icon before a group path (the pane crumb, the row card, the group
 * tab): a dashed square for No group, the source logo for a source group
 * (the path names the source: `Slack › #eng`), else `#`. Decorative.
 */
export function GroupCrumbIcon({
  groupKey,
  noGroup,
  className,
}: {
  groupKey: string | null | undefined;
  noGroup: boolean;
  /** The size, `size-3` for example. */
  className: string;
}) {
  const source = !noGroup && groupKey ? sourceOfGroupKey(groupKey) : null;
  if (source) return <TaskSourceMark source={source} className={className} />;
  const Icon = noGroup ? SquareDashed : Hash;
  return <Icon aria-hidden className={cn("shrink-0", className)} />;
}
