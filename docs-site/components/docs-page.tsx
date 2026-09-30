"use client";

import { DocsPage as FumadocsPage, type DocsPageProps } from "fumadocs-ui/layouts/docs/page";
import { Container } from "fumadocs-ui/layouts/docs/page/slots/container";
import type { ComponentProps } from "react";

/**
 * Wraps the page in the one `<main>` landmark.
 * `contents` keeps the box out of the layout grid,
 * so the article still sits in Fumadocs' `main` grid area.
 */
function MainContainer(props: ComponentProps<"article">) {
  return (
    <main id="main" tabIndex={-1} className="contents focus:outline-none">
      <Container {...props} />
    </main>
  );
}

const slots = { container: MainContainer };

export function DocsPage(props: DocsPageProps) {
  return <FumadocsPage slots={slots} {...props} />;
}
