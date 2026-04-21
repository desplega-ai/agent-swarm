import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";
import { MARKDOWN_CONTENT_TYPE } from "@/lib/content-negotiation";

export const revalidate = false;

export async function GET() {
  const scan = source.getPages().map(getLLMText);
  const scanned = await Promise.all(scan);

  return new Response(scanned.join("\n\n"), {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
    },
  });
}
