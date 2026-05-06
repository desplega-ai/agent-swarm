import Link from "next/link";
import { ArrowLeft, Calendar, Clock } from "lucide-react";
import { ProseEnhancer } from "@/components/prose-enhancer";

interface BlogPostLayoutProps {
  date: string;
  readTime: string;
  title: React.ReactNode;
  description: string;
  tags: string[];
  jsonLd: Record<string, unknown>;
  children: React.ReactNode;
}

export function BlogPostLayout({
  date,
  readTime,
  title,
  description,
  tags,
  jsonLd,
  children,
}: BlogPostLayoutProps) {
  return (
    <article>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link
        href="/blog"
        className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.14em] uppercase text-zinc-400 hover:text-amber-700 transition-colors mb-10"
      >
        <ArrowLeft className="w-3 h-3" />
        Back to writing
      </Link>

      <header className="mb-14 max-w-3xl">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] tracking-[0.06em] text-zinc-400 mb-6">
          <span className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3" />
            {date}
          </span>
          <span className="text-zinc-200">·</span>
          <span className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            {readTime}
          </span>
        </div>

        <h1
          className="text-[36px] sm:text-[44px] md:text-[52px] font-semibold tracking-[-0.025em] text-zinc-950 leading-[1.05] mb-5"
          style={{ textWrap: "balance" }}
        >
          {title}
        </h1>

        <p
          className="text-[18px] text-zinc-500 leading-[1.55] max-w-2xl"
          style={{ textWrap: "pretty" }}
        >
          {description}
        </p>

        <div className="flex gap-1.5 flex-wrap mt-6">
          {tags.map((tag) => (
            <span
              key={tag}
              className="font-mono text-[10.5px] tracking-[0.02em] text-zinc-500 bg-zinc-50 border border-zinc-100 rounded-md px-2 py-0.5"
            >
              {tag}
            </span>
          ))}
        </div>
      </header>

      <div className="prose-custom">
        <ProseEnhancer>{children}</ProseEnhancer>
      </div>
    </article>
  );
}
