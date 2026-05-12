import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// SettingsRow — labeled form-field wrapper. Pre-Phase-9 canonical form:
//
//   <div className="space-y-2">
//     <Label htmlFor="repo-url">Repository URL</Label>
//     <Input id="repo-url" ... />
//     <p className="text-xs text-muted-foreground">helper text</p>
//   </div>
//
// 14 occurrences (config, repos, repos/[id], tasks, ...). Phase 10 will
// replace those call sites; the consumer is still responsible for passing
// the matching `id` on the input control via the `htmlFor` field.

export interface SettingsRowProps {
  label: ReactNode;
  htmlFor?: string;
  helper?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function SettingsRow({
  label,
  htmlFor,
  helper,
  required,
  className,
  children,
}: SettingsRowProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-status-error ml-0.5">*</span> : null}
      </Label>
      {children}
      {helper ? <p className="text-xs text-muted-foreground">{helper}</p> : null}
    </div>
  );
}
