import Link from "next/link";
import { ArrowLeft, Calendar, Clock } from "lucide-react";

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
        className="inline-flex items-center gap-1.5 text-[13px] text-zinc-400 hover:text-zinc-700 transition-colors mb-8"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Blog
      </Link>

      <header className="mb-12">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
            <Calendar className="w-3.5 h-3.5" />
            {date}
          </span>
          <span className="text-zinc-300">&middot;</span>
          <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
            <Clock className="w-3.5 h-3.5" />
            {readTime}
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-zinc-900 leading-tight mb-4">
          {title}
        </h1>

        <p className="text-lg text-zinc-500 leading-relaxed max-w-2xl">{description}</p>

        <div className="flex gap-2 flex-wrap mt-6">
          {tags.map((tag) => (
            <span
              key={tag}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500"
            >
              {tag}
            </span>
          ))}
        </div>
      </header>

      <div className="prose-custom">{children}</div>
    </article>
  );
}
