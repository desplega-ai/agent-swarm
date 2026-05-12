import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// OAuthSection + OAuthStatusRow — shared shell of the four integration OAuth
// components (codex / linear / jira / claude-managed). Pre-Phase-9 canonical
// form (paraphrased — each file has its own copy):
//
//   <section className="space-y-3">
//     <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
//       Connection
//     </h2>
//     <div className="border border-border rounded-md bg-muted/10">
//       <div className="flex items-start justify-between gap-4 p-4">
//         <div className="flex items-start gap-3">
//           <div className="mt-1.5 h-2 w-2 rounded-full bg-status-{X} shrink-0" />
//           <div className="space-y-1">
//             <div className="text-sm font-medium">{label}</div>
//             <div className="text-xs text-muted-foreground">{description}</div>
//           </div>
//         </div>
//         <div className="flex items-center gap-2 shrink-0">{actions}</div>
//       </div>
//       {/* optional follow-on rows separated by border-t border-border */}
//     </div>
//   </section>

export interface OAuthSectionProps {
  title: ReactNode;
  className?: string;
  children: ReactNode;
}

export function OAuthSection({ title, className, children }: OAuthSectionProps) {
  return (
    <section className={cn("space-y-3", className)}>
      <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
        {title}
      </h2>
      <div className="border border-border rounded-md bg-muted/10">{children}</div>
    </section>
  );
}

// OAuthStatusRow — the colored bullet + label + description + actions row
// that opens each OAuth section. `connected` toggles the dot color between
// `bg-status-success` (true) and `bg-status-neutral` (false). For the rare
// "error" state (claude-managed), pass `tone="error"` directly.

export type OAuthStatusTone = "success" | "neutral" | "error" | "active";

interface OAuthStatusRowProps {
  connected?: boolean;
  tone?: OAuthStatusTone;
  label: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

const TONE_DOT_CLASSES: Record<OAuthStatusTone, string> = {
  success: "bg-status-success",
  neutral: "bg-status-neutral",
  error: "bg-status-error",
  active: "bg-status-active",
};

export function OAuthStatusRow({
  connected,
  tone,
  label,
  description,
  actions,
  className,
}: OAuthStatusRowProps) {
  // `tone` wins if explicit; otherwise infer from `connected`.
  const resolvedTone: OAuthStatusTone = tone ?? (connected ? "success" : "neutral");
  const dotClass = TONE_DOT_CLASSES[resolvedTone];

  return (
    <div className={cn("flex items-start justify-between gap-4 p-4", className)}>
      <div className="flex items-start gap-3 min-w-0">
        <div className={cn("mt-1.5 h-2 w-2 rounded-full shrink-0", dotClass)} aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}

// OAuthSectionRow — generic divider-separated follow-on row container. Used
// for the redirect-URI / webhook-URL / footer rows that hang off the main
// status row. Adds the canonical `border-t border-border` separator.

export interface OAuthSectionRowProps {
  className?: string;
  children: ReactNode;
}

export function OAuthSectionRow({ className, children }: OAuthSectionRowProps) {
  return (
    <div className={cn("border-t border-border px-4 py-3 space-y-1.5", className)}>{children}</div>
  );
}
