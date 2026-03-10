import type { Metadata } from "next";
import Script from "next/script";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const siteUrl = "https://templates.agent-swarm.dev";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Agent Swarm Templates",
    template: "%s | Agent Swarm Templates",
  },
  description:
    "Pre-configured worker templates for your agent swarm. Browse, customize, and deploy.",
  icons: {
    icon: "/logo.png",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "Agent Swarm Templates",
    title: "Agent Swarm Templates",
    description:
      "Pre-configured worker templates for your agent swarm. Browse, customize, and deploy.",
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "Agent Swarm" }],
  },
  twitter: {
    card: "summary",
    title: "Agent Swarm Templates",
    description:
      "Pre-configured worker templates for your agent swarm. Browse, customize, and deploy.",
    images: ["/logo.png"],
  },
  alternates: {
    canonical: siteUrl,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#ffffff" />
        <Script
          src="https://plausible.io/js/pa-M1-eco9iixf2o8UzZs6o5.js"
          strategy="afterInteractive"
        />
        <Script id="plausible-init" strategy="afterInteractive">
          {`window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`}
        </Script>
      </head>
      <body
        className={`${spaceGrotesk.variable} ${spaceMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
