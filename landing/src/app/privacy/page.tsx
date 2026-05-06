import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Privacy Policy — Agent Swarm",
  description: "Privacy policy for Agent Swarm and Agent Swarm Cloud.",
  alternates: { canonical: "/privacy" },
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return (
    <main>
      <Navbar />
      <div className="h-20" />
      <article className="mx-auto max-w-3xl px-6 sm:px-7 py-20">
        <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
          / privacy
        </div>
        <h1 className="text-[40px] sm:text-[52px] leading-[1.05] font-semibold tracking-[-0.025em] text-zinc-950 mb-6">
          Privacy Policy
        </h1>
        <p className="text-zinc-500 leading-[1.6]">
          We&apos;re drafting this. Until it&apos;s published, reach out at{" "}
          <a href="mailto:hello@desplega.sh" className="text-amber-700 hover:text-amber-600">
            hello@desplega.sh
          </a>{" "}
          with any privacy or data-handling questions.
        </p>
      </article>
      <Footer />
    </main>
  );
}
