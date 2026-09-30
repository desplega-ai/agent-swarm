import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import { baseOptions } from "@/app/layout.config";
import type { Metadata } from "next";
import { NotFoundContent } from "@/components/not-found-content";

export const metadata: Metadata = { title: "Page not found" };

// Every unknown URL lands here, /docs/* included (its page calls notFound()). It renders its
// own DocsLayout so the sidebar and search stay available.
export default function NotFound() {
  return (
    <DocsLayout tree={source.pageTree} {...baseOptions}>
      <NotFoundContent />
    </DocsLayout>
  );
}
