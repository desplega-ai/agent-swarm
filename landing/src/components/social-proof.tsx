import { StarCount } from "@/components/star-count";

type Company = {
  name: string;
  href: string;
  src: string;
};

const COMPANIES: Company[] = [
  { name: "Reveri", href: "https://www.reveri.com/", src: "/logos/reveri.png" },
  { name: "Lodgify", href: "https://www.lodgify.com/", src: "/logos/lodgify.svg" },
  { name: "Capchase", href: "https://capchase.com/", src: "/logos/capchase.svg" },
  { name: "Evalion", href: "https://evalion.ai/", src: "/logos/evalion.svg" },
];

function CompanyLogo({ company }: { company: Company }) {
  return (
    <a
      href={company.href}
      target="_blank"
      rel="noopener noreferrer"
      className="group h-12 rounded-md flex items-center justify-center px-4 opacity-70 hover:opacity-100 transition"
      aria-label={`${company.name} — opens in a new tab`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={company.src}
        alt={company.name}
        className="max-h-7 w-auto object-contain grayscale group-hover:grayscale-0 transition"
        loading="lazy"
      />
    </a>
  );
}

export function SocialProof({ stars }: { stars: number }) {
  return (
    <section className="relative py-20 border-y border-zinc-100 bg-white">
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7">
        <div className="grid lg:grid-cols-[auto_1fr] gap-10 lg:gap-16 items-center">
          <figure className="lg:max-w-md">
            <blockquote className="text-[20px] leading-[1.45] text-zinc-800 tracking-[-0.005em]">
              <span className="text-amber-700 italic text-[28px] leading-none mr-1">“</span>
              Building multi-agent workflows is surprisingly approachable. You don&apos;t code it,
              you just explain it.
              <span className="text-amber-700 italic text-[28px] leading-none ml-0.5">”</span>
            </blockquote>
            <figcaption className="mt-5 text-[13px] text-zinc-500 leading-tight">
              — Engineer Manager
            </figcaption>
          </figure>

          <div className="lg:border-l lg:border-zinc-100 lg:pl-12">
            <div className="text-[11px] font-semibold tracking-[0.14em] uppercase text-zinc-400 mb-7">
              Trusted by
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 items-center">
              {COMPANIES.map((c) => (
                <CompanyLogo key={c.name} company={c} />
              ))}
            </div>
            <div className="mt-7 flex flex-wrap gap-x-7 gap-y-2 font-mono text-[11px] tracking-[0.06em] text-zinc-500">
              <span>
                <span className="text-amber-700 font-semibold">
                  <StarCount count={stars} />
                </span>{" "}
                stars on GitHub
              </span>
              <span className="text-zinc-200">·</span>
              <span>
                <span className="text-amber-700 font-semibold">Docker-isolated</span> workers
              </span>
              <span className="text-zinc-200">·</span>
              <span>
                <span className="text-amber-700 font-semibold">MIT</span> licensed
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
