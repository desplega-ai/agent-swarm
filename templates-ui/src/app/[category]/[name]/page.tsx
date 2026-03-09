import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { TemplateDetail } from "@/components/template-detail";
import {
  getAllTemplates,
  getTemplate,
} from "@/lib/templates";

interface PageProps {
  params: Promise<{ category: string; name: string }>;
}

export async function generateStaticParams() {
  const templates = getAllTemplates();
  return templates.map((t) => ({
    category: t.category,
    name: t.name,
  }));
}

export default async function TemplateDetailPage({ params }: PageProps) {
  const { category, name } = await params;

  let template;
  try {
    template = getTemplate(category, name);
  } catch {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-12">
        <TemplateDetail template={template} category={category} />
      </main>
      <Footer />
    </div>
  );
}
