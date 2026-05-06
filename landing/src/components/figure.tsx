type FigureProps = {
  src: string;
  alt: string;
  caption?: string;
  /** "narrow" (~480px), "default" (~640px), "wide" (~960px) */
  size?: "narrow" | "default" | "wide";
};

const SIZE_TO_CLS: Record<NonNullable<FigureProps["size"]>, string> = {
  narrow: "max-w-md",
  default: "max-w-xl",
  wide: "max-w-3xl",
};

export function Figure({ src, alt, caption, size = "default" }: FigureProps) {
  return (
    <figure className={`mx-auto my-10 ${SIZE_TO_CLS[size]}`}>
      <div className="rounded-xl overflow-hidden border border-zinc-200 bg-zinc-50/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="w-full block" loading="lazy" />
      </div>
      {caption && (
        <figcaption className="mt-3 text-center font-mono text-[11.5px] tracking-[0.02em] text-zinc-400 italic px-4">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
