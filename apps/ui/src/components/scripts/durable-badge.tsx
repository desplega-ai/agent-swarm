import { Box } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** True when a script detail's signature marks a DurableObject class script. */
export function isDurableSignature(signature: unknown): boolean {
  return (
    typeof signature === "object" &&
    signature !== null &&
    (signature as { kind?: unknown }).kind === "durable"
  );
}

/** Method names of a durable script, from its parsed signature. */
export function durableMethods(signature: unknown): string[] {
  if (!isDurableSignature(signature)) return [];
  const methods = (signature as { methods?: unknown }).methods;
  return methods && typeof methods === "object" ? Object.keys(methods) : [];
}

/** Marks a DurableObject class script: each object id keeps its own state. */
export function DurableBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" size="tag" className="border-foreground/30 text-foreground">
          <Box aria-hidden />
          Durable
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Durable object: each object id keeps its own state.</TooltipContent>
    </Tooltip>
  );
}
