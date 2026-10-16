import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One rounded chip. `pressed` makes it a toggle (`aria-pressed` plus the
 * selected look); leave it undefined for a plain action chip.
 */
export function ChipButton({
  pressed,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "status"> & { pressed?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      aria-pressed={pressed}
      className={cn(
        "h-auto rounded-full px-3 py-1 font-normal shadow-none hover:border-primary/40 hover:bg-muted/60 hover:text-foreground",
        pressed && "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/15",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Starter prompts under a composer: rounded chips, one click puts the prompt
 * in the draft. Shared by the new-session view and the `/setup` first task.
 */
export function SuggestionChips({
  suggestions,
  onPick,
  disabled,
  className,
}: {
  suggestions: readonly string[];
  onPick: (suggestion: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-2", className)}>
      {suggestions.map((suggestion) => (
        <ChipButton key={suggestion} onClick={() => onPick(suggestion)} disabled={disabled}>
          {suggestion}
        </ChipButton>
      ))}
    </div>
  );
}
