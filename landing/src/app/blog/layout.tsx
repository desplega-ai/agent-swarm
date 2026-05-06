import { Navbar } from "@/components/navbar";
import { CTA } from "@/components/cta";
import { Footer } from "@/components/footer";

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-white">
      <Navbar />
      <div className="mx-auto max-w-6xl px-6 sm:px-7 pt-32 pb-20">{children}</div>
      <CTA />
      <Footer />
    </main>
  );
}
