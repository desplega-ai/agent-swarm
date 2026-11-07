import { Code, Type } from "lucide-react";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The hover group that reveals a `hover` action. The transcript has its own
 * group: it renders inside Sessions messages, and hovering the outer message
 * must not reveal every action in its transcript. Literal class names, so
 * Tailwind finds them.
 */
const GROUP_HOVER = {
  message: "md:group-hover/message:opacity-70",
  "transcript-message": "md:group-hover/transcript-message:opacity-70",
} as const;

export type MessageActionGroup = keyof typeof GROUP_HOVER;

/** The opacity wrapper of a message action: see `MessageCopyButton`. */
export function messageActionClass(hover: boolean, group: MessageActionGroup = "message") {
  return cn(
    "-my-1 inline-flex shrink-0 transition-opacity duration-150 ease-snappy hover:opacity-100 focus-within:opacity-100",
    hover ? cn("opacity-70 md:opacity-0", GROUP_HOVER[group]) : "opacity-60",
  );
}

/**
 * Copy for one message (SPEC R10.1, R10.2): Check and "Copied" for 1.5 s.
 * `hover` fades it in when the pointer is over the closest `group/<group>`
 * (150 ms) and keeps it at 70 % on small screens, as `OutcomeCopyShell` does.
 * Otherwise it stays visible and muted. The opacity rides a wrapper, so the
 * Button keeps its own transitions.
 */
export function MessageCopyButton({
  text,
  label = "Copy message",
  hover = false,
  group = "message",
}: {
  text: string;
  /** The tooltip and the accessible name. */
  label?: string;
  hover?: boolean;
  group?: MessageActionGroup;
}) {
  return (
    <span className={messageActionClass(hover, group)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CopyValueButton
            value={text}
            label={label}
            size="icon-xs"
            // A 44 px touch area on touch screens; the row keeps its height.
            className="text-muted-foreground hit-area [--hit-size:44px] hover:text-foreground"
          />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * Switches a person's message between its markdown view and its raw text.
 * It sits next to `MessageCopyButton`, with the same hover and group.
 */
export function MessageRawToggle({
  raw,
  onRawChange,
  hover = false,
  group = "message",
}: {
  raw: boolean;
  onRawChange: (raw: boolean) => void;
  hover?: boolean;
  group?: MessageActionGroup;
}) {
  const label = raw ? "Show formatted" : "Show raw";
  return (
    <span className={messageActionClass(hover, group)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={() => onRawChange(!raw)}
            className="text-muted-foreground hit-area [--hit-size:44px] hover:text-foreground"
          >
            {raw ? <Type /> : <Code />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </span>
  );
}
