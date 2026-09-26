import { useState } from "react";
import type { User } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.trim().slice(0, 2) || "?").toUpperCase();
}

/**
 * A person, by name, with an initials avatar. The stored reference (user id or
 * email) sits in a tooltip for whoever needs to match it against logs or the
 * API, and a click copies it. An unknown reference renders as stored, so
 * nothing is hidden.
 */
export function UserChip({
  userRef,
  user,
  className,
}: {
  /** What the record stores: a user id or an email. */
  userRef: string;
  /** The directory entry for `userRef`, when the directory knows them. */
  user?: User;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const name = user?.name?.trim() || userRef;
  const copyValue = user?.id ?? userRef;
  const detail = user
    ? [user.email, user.id].filter(Boolean).join(" · ")
    : "Not in the people directory";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${name}. Copy ID ${copyValue}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void navigator.clipboard?.writeText(copyValue).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className={cn(
            "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full align-middle text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
        >
          <span
            aria-hidden
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-semibold text-foreground"
          >
            {user ? userInitials(name) : "?"}
          </span>
          <span className={cn("min-w-0 truncate font-medium", !user && "font-mono text-[11px]")}>
            {name}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span className="font-mono text-[11px]">{detail}</span>
        <span className="text-[11px] opacity-70">{copied ? "Copied" : "Click to copy the ID"}</span>
      </TooltipContent>
    </Tooltip>
  );
}
