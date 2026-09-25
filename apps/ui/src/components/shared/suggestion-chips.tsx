import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
        <Button
          key={suggestion}
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onPick(suggestion)}
          disabled={disabled}
          className="h-auto rounded-full px-3 py-1 font-normal shadow-none hover:border-primary/40 hover:bg-muted/60 hover:text-foreground"
        >
          {suggestion}
        </Button>
      ))}
    </div>
  );
}
