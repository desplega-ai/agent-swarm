import Link from "next/link";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { DocsPage } from "@/components/docs-page";

const suggestions = [
  { href: "/docs/getting-started", label: "Getting Started" },
  { href: "/docs/architecture/overview", label: "Architecture overview" },
  { href: "/docs/api-reference", label: "API reference" },
];

/** The 404 body. Render it inside `DocsLayout` so the sidebar and search stay available. */
export function NotFoundContent() {
  return (
    <DocsPage toc={[]} breadcrumb={{ enabled: false }} footer={{ enabled: false }}>
      <DocsTitle>Page not found</DocsTitle>
      <DocsDescription>
        This page does not exist or has moved. Search from the sidebar, or start from the
        documentation home.
      </DocsDescription>
      <DocsBody>
        <p>
          <Link href="/docs" className={buttonVariants({ color: "primary", className: "px-4 py-2" })}>
            Go to documentation
          </Link>
        </p>
        <p>Popular pages:</p>
        <ul>
          {suggestions.map(({ href, label }) => (
            <li key={href}>
              <Link href={href}>{label}</Link>
            </li>
          ))}
        </ul>
      </DocsBody>
    </DocsPage>
  );
}
