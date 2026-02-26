import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <Image src="/logo.png" alt="Agent Swarm" width={28} height={28} />
        Agent Swarm
      </>
    ),
  },
  links: [
    {
      text: "Docs",
      url: "/docs",
    },
    {
      text: "GitHub",
      url: "https://github.com/desplega-ai/agent-swarm",
      external: true,
    },
    {
      text: "Discord",
      url: "https://discord.gg/KZgfyyDVZa",
      external: true,
    },
  ],
};
