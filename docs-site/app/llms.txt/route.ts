import { source } from "@/lib/source";
import { llms } from "fumadocs-core/source";
import { MARKDOWN_CONTENT_TYPE } from "@/lib/content-negotiation";

export const revalidate = false;

export function GET() {
  return new Response(llms(source).index(), {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
    },
  });
}
