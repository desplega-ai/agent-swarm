import defaultMdxComponents from "fumadocs-ui/mdx";
import { Mermaid } from "@/components/mdx/mermaid";
import { JsonLd } from "@/components/mdx/json-ld";
import { APIPage } from "@/components/api-page";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Mermaid,
    JsonLd,
    APIPage,
    ...components,
  };
}
