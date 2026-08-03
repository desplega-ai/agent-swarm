import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <Image src="/logo.png" alt="agent-swarm.dev" width={28} height={28} />
        agent-swarm.dev
      </>
    ),
  },
  links: [
    {
      text: "Docs",
      url: "/docs",
    },
    {
      text: "Templates",
      url: "https://templates.agent-swarm.dev",
      external: true,
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
