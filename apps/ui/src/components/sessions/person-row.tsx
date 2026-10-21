import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One person (or agent) in a list: the avatar, the name with an optional
 * muted second line, and an end slot (the access). The Share dialog and the
 * sessions v2 People popover share it.
 */
export function PersonRow({
  avatar,
  name,
  detail,
  children,
  className,
}: {
  avatar: ReactNode;
  name: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <li className={cn("flex min-w-0 items-center gap-2.5 py-1.5", className)}>
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">{name}</span>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      </div>
      {children}
    </li>
  );
}
