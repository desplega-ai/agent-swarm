import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-white">
      <Navbar animate={false} />
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-20">{children}</div>
      <Footer />
    </main>
  );
}
