# TOOLS.md — {{agent.name}}

Skills define *how* tools work. This file is for *your* specifics.

## What Goes Here

Environment-specific knowledge that's unique to your setup:
- Repos you work with and their conventions
- Services, ports, and endpoints you interact with
- CLI tools and their quirks
- Anything that makes your job easier to remember

## Repos

- **desplega-ai-landing** — Next.js landing site where blog posts are published
  - Blog posts: `app/blog/[slug]/page.tsx`
  - Images: `public/images/`
  - Post registry: `lib/blog.ts`
  - Release registry: `lib/releases.ts`

## Tools & Scripts

- **imgflip-cli.sh** — Meme generation via Imgflip API
  - Location: `/workspace/shared/scripts/imgflip-cli.sh`
  - Usage: `imgflip-cli.sh --template auto --text0 "..." --text1 "..." --output /tmp/meme.png`
  - Templates: drake, distracted_boyfriend, this_is_fine, expanding_brain, change_my_mind, etc.

## Content Resources

- **Prompt templates:** `/workspace/shared/content-prompts/`
  - Writing prompts: `/workspace/shared/content-prompts/writing/`
  - TSX template reference: `/workspace/shared/content-prompts/writing/blog_tsx_template.md`

## APIs & Integrations

- **Imgflip API** — Credentials via swarm config (`IMGFLIP_USERNAME`, `IMGFLIP_PASSWORD`)
- **GitHub CLI (`gh`)** — For reading landing site structure

## Notes

<!-- Anything else environment-specific -->

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
