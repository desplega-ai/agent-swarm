# Landing — agent-swarm.dev

Marketing site for Agent Swarm. Next.js 16 (App Router) + React 19 + Tailwind v4 + Turbopack. Single bundle, no shadcn/ui (we hand-roll components).

Run from this directory: `pnpm dev` (port 3000) or `PORT=4321 pnpm dev` if 3000 is busy.

## Project map

```
src/
  app/
    page.tsx              # Homepage — composes Hero + Pillars + SocialProof + Features + HowItWorks + PricingTiers + CTA + Footer
    globals.css           # Tailwind v4 @theme tokens + design-system CSS (gradient-text, prose-custom, copy-btn, hljs)
    layout.tsx            # Root layout — Space Grotesk + Space Mono via Google Fonts, JSON-LD, Plausible
    pricing/page.tsx      # Reuses PricingTiers + PricingFAQ + CTA
    blog/                 # 13 posts + index + layout (Navbar → content → CTA → Footer)
    privacy/, terms/      # Placeholder pages — keep until legal pages ship
  components/
    navbar.tsx            # Sticky scroll-aware. Auto-inverts dark→light past hero on darkAboveFold pages
    hero.tsx              # min-h-screen dark hero — uses HiveScroll + grid bg + radial wash
    hive-scroll.tsx       # Client component — scroll-driven 3D scale/rotate/blur on the Hive SVG
    hive.tsx              # SVG honeycomb (lead + 1 or 2 rings of worker cells)
    pricing-tiers.tsx     # 3-tier card layout (Self-hosted / Cloud highlighted / Enterprise)
    pricing-faq.tsx       # FAQ accordion for /pricing
    figure.tsx            # Image with optional caption — used in blog posts (size: narrow|default|wide)
    prose-enhancer.tsx    # Client wrapper around blog post body — adds copy buttons + highlight.js to <pre>
    blog-post-layout.tsx  # Header (back link, date/read-time, title, lede, tags) + ProseEnhancer-wrapped body
    star-count.tsx        # Server-rendered "★ N" — count comes from getStarCount() ISR
  lib/
    stars.ts              # getStarCount() and getLatestRelease() — both 6h ISR with hardcoded fallbacks
public/
  logos/                  # Customer logos for SocialProof + desplega-iso for testimonial avatar
  images/                 # Blog hero images (one per deep-dive post)
```

## Design system

<important if="you are styling any new section, page, or component">

The visual language is consistent across the homepage, /pricing, and /blog. Match it.

**Color tokens** (defined in `globals.css` `@theme`):
- Brand: `amber-700` is primary (oklch(0.555 0.163 48.998)). `amber-300/400/500` for accents on dark surfaces, `amber-800` for hover/depth, `amber-50/100` for tinted backgrounds.
- Neutral: zinc scale. `zinc-950` deep dark bg, `zinc-500` body copy, `zinc-400` quiet captions, `zinc-200` borders, `zinc-100` hairlines.

**Typography**:
- `font-sans`: Space Grotesk (Google Fonts via `<link>` in layout)
- `font-mono`: Space Mono — used for eyebrows, captions, code, chips
- Display headlines use `clamp(...)` sizing, `tracking-[-0.025em]` to `-0.04em`, `leading-[1.0]` to `1.05`, `text-zinc-950`, optional `style={{ textWrap: "balance" }}`

**Section header pattern** (use for every new section):

```tsx
<div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
  / your section name
</div>
<h2
  className="text-[40px] sm:text-[52px] leading-[1.02] font-semibold tracking-[-0.025em] text-zinc-950"
  style={{ textWrap: "balance" }}
>
  Plain part of the headline
  <br />
  <span className="italic gradient-text">accented part.</span>
</h2>
```

The mono `/ slash-prefixed` eyebrow + italic gradient-text accent on a second line is the brand signature — don't substitute headlines without it.

**Section width**: `max-w-[1180px] mx-auto px-6 sm:px-7`. Use `max-w-[760px]` for prose-heavy sections (FAQs, terms).

**Section padding**: `py-32` for major sections, `py-20` for narrower bands (e.g. SocialProof). `py-24` for blog/legal.

**Cards / chips**:
- Card: `rounded-2xl border border-zinc-100 p-7 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-200/40 transition-all`
- Mono chip (used for tags, integrations): `font-mono text-[11px] tracking-[0.02em] text-zinc-700 bg-zinc-50 border border-zinc-100 rounded-md px-2 py-1`
- Pill badge: `bg-amber-500 text-zinc-950 text-[10px] font-bold tracking-[0.1em] uppercase rounded-full px-2.5 py-1`

**Buttons** (CTAs):
- Primary on dark hero: `bg-amber-500 hover:bg-amber-400 text-zinc-950 ... rounded-xl` + amber glow shadow
- Primary on light: `bg-amber-700 hover:bg-amber-600 text-white ... rounded-md` + amber-glow inset shadow
- Secondary on dark: `bg-white/[0.06] hover:bg-white/[0.1] backdrop-blur-sm text-white border border-white/[0.12]`
- Secondary on light: `bg-zinc-950 hover:bg-zinc-800 text-white rounded-xl`

</important>

<important if="you are creating or styling a new page that has a full-bleed dark hero">

Pass `darkAboveFold` to `<Navbar />`. The navbar starts dark/transparent over the hero and auto-inverts to a frosted-light pill once scrolled past `innerHeight - 80px`. All other pages just use `<Navbar />` (defaults to light tone).

Active link highlighting is automatic via `usePathname()` — `/pricing` and `/blog` get amber + semibold when active. Add new active matches by extending the link list in `navbar.tsx`.

</important>

<important if="you are running the dev server during development">

**Turbopack HMR drift is real.** When CSS or components stop reflecting source changes, the served bundle is stale. Fix:

```bash
# Ctrl+C the dev server
rm -rf .next
PORT=3000 pnpm dev   # or whichever port
```

Symptoms to recognize: code blocks render with old styles, copy buttons missing, `globals.css` edits invisible, 500s mentioning `Unable to open static sorted file`. None of these are bugs in your code — they're cache wedges.

</important>

## Blog posts

<important if="you are creating a new blog post">

Each post is its own `app/blog/<slug>/page.tsx` file (no MDX). Pattern:

1. Export `metadata` (title, description, OpenGraph, twitter, canonical) — copy structure from any existing post.
2. Build a `jsonLd` object (Schema.org `BlogPosting`).
3. Inside `<BlogPostLayout date readTime title description tags jsonLd>...children...</BlogPostLayout>`.
4. Hero image goes through `<Figure src="/images/<slug>.png" alt="..." caption="..." />` — keep captions short, dry, on-brand.
5. Append the post to the `posts` array in `app/blog/page.tsx` (in chronological order, newest first).

**Body styling** — posts hand-roll their JSX with Tailwind. There's no MDX/prose plugin. Common patterns inside the post body:
- Section heading: `<h2 className="text-[28px] font-semibold text-zinc-950 mt-12 mb-4 tracking-[-0.015em]">`
- Body text: `<p className="text-[15.5px] text-zinc-700 leading-[1.7] mb-5">`
- Inline code: just `<code>foo</code>` — `globals.css` styles it as an amber-tinted chip via `.prose-custom :not(pre) > code`
- Code blocks: a small local `CodeBlock` helper that returns `<pre><code>{children}</code></pre>` with Tailwind classes. The `prose-custom` CSS forces a light theme regardless of the per-post Tailwind utilities, so don't fight it.
- Pull quotes: `<blockquote className="border-l-2 border-amber-700 pl-5 my-6 text-[16px] italic text-zinc-600">`

**Code blocks get for free** (via `<ProseEnhancer>` in BlogPostLayout):
- highlight.js syntax highlighting (auto-detect; supports bash/sh/shell, js/ts, json, python, yaml, markdown, sql, html/xml, css)
- Hover-revealed copy button (top-right, mono "COPY" → "COPIED" feedback)
- Light zinc-50 theme with token colors tuned to amber/zinc palette

If you need a specific language and auto-detect picks wrong, add `className="language-bash"` (or whichever) to the `<code>` element — hljs will use it directly.

</important>

<important if="you are adding a customer logo to the SocialProof section, the logo wall, or any landing trust signal">

- Save SVG to `/public/logos/<name>.svg` (preferred) or `.png` if SVG isn't available
- Prefer brand wordmarks in dark grey/black on white — works with the greyscale + 70% opacity wash applied by `CompanyLogo`
- Each entry must be a working link: `{ name, href: "https://...", src: "/logos/<name>.svg" }`
- Update the `COMPANIES` array in `social-proof.tsx`. Grid is `grid-cols-2 sm:grid-cols-4` — if you want a different count, change both the array and the grid columns.

For research strategy when sourcing a new logo: check the company's homepage `<header>` for inline SVG, then `/press`, `/brand`, `/media` pages, then common conventions (`<domain>/logo.svg`, `/static/logo.svg`), and last resort `https://logo.clearbit.com/<domain>`.

</important>

## Routing + global guarantees

- `getStarCount()` and `getLatestRelease()` (`lib/stars.ts`) are 6h ISR with sensible fallbacks (239 stars, `v1.50`). Safe to call from any server component.
- All external links in the footer/social-proof use `target="_blank" rel="noopener noreferrer"` and an `aria-label` for screen readers.
- `body { overflow-x: hidden; max-width: 100vw }` and `html { overflow-x: hidden }` are global guards against mobile horizontal scroll. Don't remove them — the hero's 3D-transformed hive can otherwise escape on Mobile Safari even with the hero's own `overflow-hidden + clip-path`.
- `prefers-reduced-motion` is respected globally (CSS) and in `HiveScroll` (clamps progress to 0). Honor it in any new motion you add.

## Verification

```bash
# Typecheck only the landing project
./node_modules/.bin/tsc -p ./tsconfig.json --noEmit

# Production build (catches more than tsc — image optimization, sitemap, ISR)
pnpm build

# Test dev locally on a non-default port
PORT=4321 pnpm dev
```

Frontend PRs require a `qa-use` session with screenshots before merging — see the parent repo's `runbooks/testing.md`.
