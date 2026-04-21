import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";
import { notFound } from "next/navigation";
import { MARKDOWN_CONTENT_TYPE } from "@/lib/content-negotiation";

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      Vary: "Accept",
    },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
