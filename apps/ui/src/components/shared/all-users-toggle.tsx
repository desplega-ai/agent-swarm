/**
 * The admin "All users" switch: every user's tasks and sessions, read-only
 * (`lib/all-users-scope.ts`). Renders nothing unless the picked identity may
 * use the scope on an API that honors it.
 */

import { useId } from "react";
import { useAllUsersScope } from "@/api/hooks/use-all-users-scope";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function AllUsersToggle() {
  const scope = useAllUsersScope();
  const id = useId();
  if (!scope.available) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2">
          <Switch id={id} size="sm" checked={scope.enabled} onCheckedChange={scope.setEnabled} />
          <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
            All users
          </Label>
        </div>
      </TooltipTrigger>
      <TooltipContent>Admins: also show other users' private sessions, read-only</TooltipContent>
    </Tooltip>
  );
}
