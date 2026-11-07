import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/*
 * Parts shared by the Embeddings and Transcription tabs of Connect › AI
 * providers: one line of copy with a guide link, then one card with the
 * setup in use (facts on the left, notes on the right).
 */

export function TabIntro({
  children,
  href,
  label,
}: {
  children: ReactNode;
  href: string;
  label: string;
}) {
  return (
    <p className="text-sm text-muted-foreground">
      {children}{" "}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:text-primary"
      >
        {label}
        <ExternalLink aria-hidden className="size-3" />
      </a>
    </p>
  );
}

/** One fact: a label, a value, and a muted note after it. */
export function FactRow({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 break-all">{children}</span>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px]">{children}</span>;
}

export function KeyName({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}

/** The setup in use: a header (mark, name, status, one line), facts, and notes. */
export function SetupCard({
  mark,
  title,
  status,
  subtitle,
  facts,
  aside,
  footer,
}: {
  mark: ReactNode;
  title: string;
  status: ReactNode;
  subtitle: ReactNode;
  facts: ReactNode;
  aside: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-lg border border-border">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        {mark}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            {status}
          </div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </header>
      <div className="grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:divide-x divide-y md:divide-y-0 divide-border">
        <dl className="px-4 py-3">{facts}</dl>
        <div className="space-y-2 px-4 py-3 text-sm text-muted-foreground">{aside}</div>
      </div>
      {footer ? (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
