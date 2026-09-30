// No `@/` imports: unit tests render this from the repo root.
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";

/**
 * A link that stays in the dashboard (`to`, same tab) or opens `href` in a new
 * tab. Used where an agent-fs link opens in Comb while Comb is connected.
 */
export function InAppOrExternalLink({
  to,
  href,
  children,
  ...rest
}: Omit<ComponentProps<"a">, "href"> & {
  to: string | null | undefined;
  href: string | null | undefined;
}) {
  if (to) {
    return (
      <Link to={to} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href ?? undefined} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}
