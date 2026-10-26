import { defineDocs, defineConfig, frontmatterSchema } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { z } from "zod";

// `agent` feeds the docs index in the seeded `swarm-docs` skill
// (`bun run build:docs-index` at the repo root). `when` is the user intent
// that makes the lead offer this page.
const agentFrontmatterSchema = z.object({
  offer: z.boolean().optional(),
  when: z.string().max(200).optional(),
  notWhen: z.string().max(200).optional(),
  template: z.string().optional(),
});

export const { docs, meta } = defineDocs({
  dir: "content/docs",
  docs: {
    schema: frontmatterSchema.extend({
      agent: agentFrontmatterSchema.optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid],
  },
});
