import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Agent Swarm",
    template: "%s | Agent Swarm",
  },
  description:
    "Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          async
          src="https://plausible.io/js/pa-N5qqdwlGhd8el6aPC8pJ7.js"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
          }}
        />
      </head>
      <body
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
