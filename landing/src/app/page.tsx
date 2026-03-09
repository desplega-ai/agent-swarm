import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { WhyChoose } from "@/components/why-choose";
import { HowItWorks } from "@/components/how-it-works";
import { Architecture } from "@/components/architecture";
import { Workshops } from "@/components/workshops";
import { CTA } from "@/components/cta";
import { Waitlist } from "@/components/waitlist";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <main>
      <Navbar />
      <Hero />
      <Features />
      <WhyChoose />
      <HowItWorks />
      <Architecture />
      <Workshops />
      <CTA />
      <Waitlist />
      <Footer />
    </main>
  );
}
