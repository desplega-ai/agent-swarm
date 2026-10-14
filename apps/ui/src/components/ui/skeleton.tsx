import { cn } from "@/lib/utils";

/** `inline` renders a `<span>` so a placeholder can sit inside text (a `<p>`). */
function Skeleton({
  className,
  inline = false,
  ...props
}: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const Comp = inline ? "span" : "div";
  return (
    <Comp
      data-slot="skeleton"
      className={cn("bg-accent animate-pulse rounded-md", inline && "inline-block", className)}
      {...props}
    />
  );
}

export { Skeleton };
