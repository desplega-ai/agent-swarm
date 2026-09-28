import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A keycap for a keyboard shortcut ("Esc", "S", "↵"). Inside a button, mark
 * it `aria-hidden` and put the shortcut on the button's `aria-keyshortcuts`.
 * `inverted` reads on a filled (primary) button.
 */
function Kbd({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"kbd"> & { tone?: "default" | "inverted" }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4.5 min-w-4.5 select-none items-center justify-center rounded-sm border px-1 font-mono text-[10px] leading-none font-medium",
        tone === "inverted"
          ? "border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground/80"
          : "border-border bg-muted/60 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
