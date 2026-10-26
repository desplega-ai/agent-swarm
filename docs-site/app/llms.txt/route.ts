import { source } from "@/lib/source";
import { llms } from "fumadocs-core/source";
import { MARKDOWN_CONTENT_TYPE } from "@/lib/content-negotiation";

export const revalidate = false;

export function GET() {
  const index = llms(source, {
    // The default renders `String(undefined)` for a folder whose meta.json has
    // no description, so the index printed "Architecture: undefined".
    renderDescription: (node) => {
      if (typeof node.description === "string") return node.description;
      if (node.type === "page") return source.getNodePage(node)?.data.description ?? "";
      return "";
    },
  }).index();
  return new Response(index, {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
    },
  });
}
