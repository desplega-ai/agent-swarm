---
title: "Landing Page Cloud Integration & Redesign"
date: 2026-03-27
type: research
autonomy: verbose
status: complete
---

# Landing Page Cloud Integration & Redesign

## Research Objective

Research what's needed to:
1. Replace the waitlist with a one-click cloud signup (cloud.agent-swarm.dev)
2. Add a pricing page
3. Redesign the landing to be less verbose and visually cleaner
4. Maintain strong SEO

---

## 1. Current State

### Landing Page (`/landing/`)

**Tech stack**: Next.js 16.1.6, Tailwind CSS v4, Framer Motion, static export (`next build` → `/out/`)
**URL**: https://agent-swarm.dev
**Fonts**: Space Grotesk (sans), Space Mono (mono)
**Colors**: Zinc neutrals, Amber accent (oklch)
**Analytics**: Plausible

**Page structure** (`src/app/page.tsx`):
1. Navbar (sticky)
2. Hero — animated SVG swarm viz, "Intelligence that compounds" headline
3. Features — 8 cards
4. WhyChoose
5. HowItWorks
6. Architecture
7. Workshops
8. CTA — "Ready to build your swarm?"
9. **Waitlist** — email capture via Resend
10. Footer

**Issues identified**:
- **Header too packed**: Navbar has 8 items (Features, How It Works, Architecture, Blog, Examples, Templates, Docs, Dashboard) + GitHub button + mobile menu
- **Too many sections**: 10 sections on a single page is verbose — WhyChoose, HowItWorks, Architecture, Workshops overlap conceptually
- **Waitlist is dead-end**: Captures email but doesn't convert to actual users
- **No pricing info**: No mention of what the cloud costs
- **No cloud CTA**: The main CTA points to docs/GitHub, not the hosted product
- **Some images not accurate**: SVG swarm visualization may not reflect current product accurately
- **Static export constraint**: Server actions (waitlist) won't work in static export — the waitlist form likely needs the Vercel deployment to work

### SEO (already solid)
- **Title**: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants"
- **JSON-LD**: Organization, WebSite, SoftwareApplication schemas
- **Open Graph**: Full tags with og-image.png (1200x630)
- **Twitter Card**: summary_large_image
- **Sitemap**: 6 routes with priorities
- **Robots.txt**: Allow all
- **Plausible**: Privacy-friendly analytics

### Cloud Platform (`agent-swarm-internal/apps/web/`)

**Tech stack**: Next.js 15.2, Clerk auth, Convex backend, Stripe billing, Fly.io infra
**URL**: https://cloud.agent-swarm.dev
**Current landing** (`app/page.tsx`): Minimal — just "Agent Swarm" title + Sign in / Get started buttons

**Pricing model** (from Stripe):
- **Agent Swarm Platform**: €9/month (flat fee)
- **Worker Compute**: €29/month per worker (quantity-based)
- **7-day free trial** (card required upfront)
- Prices fetched dynamically from Stripe via Convex action

**Checkout flow**:
1. User signs up via Clerk
2. 4-step onboarding: Create Swarm → Integrations → Harness → Provision
3. At Provision step: sees pricing estimate, clicks "Subscribe & Start 7-Day Trial"
4. Redirects to Stripe Checkout
5. Webhook confirms → user can deploy

**No existing pricing page** — pricing only shown during onboarding provision step.

---

## 2. What Needs to Change

### 2.1 Replace Waitlist with Cloud CTA

**Current**: Waitlist component captures email via Resend segment
**Target**: Direct "Get Started" button that sends users to `https://cloud.agent-swarm.dev`

This should be **one click** — no intermediary. The CTA should clearly communicate:
- What they get (managed agent swarm infrastructure)
- The pricing (starting at €9/mo + €29/worker)
- 7-day free trial
- No credit card to browse (Clerk sign-up is free; card only needed at checkout)

**Implementation**:
- Remove `src/components/waitlist.tsx` and `src/app/actions/waitlist.ts`
- Remove `resend` dependency from `package.json`
- Update the CTA section to point to cloud.agent-swarm.dev
- Consider keeping a secondary "self-host" path for open-source users

### 2.2 Add Pricing Page

**New route**: `/pricing` (static page on agent-swarm.dev)

**Content**:
- Two-tier pricing display:
  - **Platform fee**: €9/mo — base infrastructure, dashboard access, integrations
  - **Worker Compute**: €29/mo per worker — Docker-isolated AI agent, managed infrastructure
- Example calculations (1 worker = €38/mo, 3 workers = €96/mo, 6 workers = €183/mo)
- "7-day free trial" badge prominently displayed
- FAQ section addressing common questions
- CTA: "Start Free Trial" → https://cloud.agent-swarm.dev
- Open-source alternative mention: "Prefer self-hosting? It's free and MIT-licensed."

**SEO for pricing page**:
- Title: "Pricing — Agent Swarm Cloud"
- Description: "Start with a 7-day free trial. Platform fee €9/mo + €29/mo per worker. Managed infrastructure, real-time dashboard, Slack & GitHub integrations included."
- JSON-LD: Product schema with pricing offers
- Add to sitemap with priority 0.9

**Note**: Prices are in EUR (€) based on Stripe config, not USD ($). The internal pricing code uses `formatPrice` with `$` but the Stripe products are in EUR. Need to clarify with Taras which currency to display publicly, or show both.

### 2.3 Landing Page Design Improvements

**Header simplification**:
- Current: Features, How It Works, Architecture, Blog, Examples, Templates, Docs, Dashboard, GitHub (9 items)
- Proposed: Docs, Pricing, Blog, Templates, GitHub (5 items) — with "Get Started" as primary CTA button
- Move Features/HowItWorks/Architecture to anchor links accessible via scrolling, not top nav

**Section consolidation**:
- **Keep**: Hero, Features (streamline to 4-6 key ones), CTA
- **Merge**: WhyChoose + HowItWorks → single "How It Works" section (3 steps max)
- **Remove or condense**: Architecture (move to docs), Workshops (low-value for conversion)
- **Replace**: Waitlist → Cloud CTA with pricing teaser
- **Add**: Social proof section — "50+ agents deployed", "10,000+ tasks handled", GitHub stars (fetched dynamically)

**Hero improvements**:
- The SVG swarm visualization is cool but may not be immediately clear
- Consider: keep the viz but make it smaller/background, put a product screenshot or short demo GIF as the main visual
- Simplify the tagline area — "Intelligence that compounds" is good but needs supporting copy that's more concrete
- Primary CTA should be "Start Free Trial" (not "Get Started" pointing to docs)
- Secondary CTA: "View on GitHub" (for open-source crowd)

**Proposed page structure** (6 sections, down from 10):
1. **Navbar** — simplified (Docs, Pricing, Blog, Templates, GitHub icon | "Start Free Trial" button)
2. **Hero** — headline, subhead, primary CTA (cloud), secondary CTA (GitHub), product visual
3. **Features** — 4-6 key features in a clean grid
4. **How It Works** — 3 steps: Install → Configure → Deploy (or for cloud: Sign up → Connect → Deploy)
5. **Pricing Teaser** — compact pricing card with "See full pricing" link
6. **CTA** — final conversion section with cloud + self-host paths
7. **Footer** — streamlined links

### 2.4 SEO Considerations

**What to preserve**:
- JSON-LD structured data (update SoftwareApplication price from $0 to include paid option)
- Open Graph tags and og-image
- Sitemap (add `/pricing` route)
- Plausible analytics
- Canonical URLs
- Robot.txt allowing all

**What to add**:
- `/pricing` page with Product JSON-LD schema
- `alternateLanguage` consideration (EUR pricing suggests international audience)
- FAQ schema on pricing page (rich results in Google)
- Breadcrumb schema on sub-pages
- `rel="noopener"` on external links (already likely there)

**What to update**:
- Meta description to mention "cloud" and "free trial" (conversion keywords)
- SoftwareApplication schema: add `offers` with pricing tiers
- Sitemap: add `/pricing` with high priority

### 2.5 Static Export Constraint

The landing is built as a static export (`next build` → `out/`). This means:
- No server actions at runtime (the waitlist server action only works on Vercel, not static)
- Pricing page must be **static** — no dynamic Stripe price fetching
- Prices will need to be hardcoded or fetched at build time via `generateStaticParams` or similar

**Options**:
1. **Hardcode prices** on the landing page (simplest, prices rarely change)
2. **Build-time fetch** from Stripe API during `next build` (more complex, keeps prices in sync)
3. **Switch to Vercel deployment** instead of static export (enables server actions, ISR, etc.)

Recommendation: **Hardcode prices** — they change infrequently and the landing page is a marketing site. When prices change, update the landing page and redeploy. This avoids coupling the landing build to Stripe API availability.

---

## 3. Currency Approach

The Stripe products are configured in **EUR** (€9 and €29). The landing page will implement a **currency selector** (EUR default, USD option) using a live exchange rate from an open API (e.g., exchangerate-api.com or frankfurter.app). Since the landing is static, the rate will be fetched client-side and cached. Stripe charges in EUR regardless — the USD display is informational only.

---

## 4. Resolved Questions

1. **Currency display** → Currency selector (EUR default, USD converted via open exchange rate API)
2. **Product screenshots** → Not needed for now, skip dashboard screenshots in hero
3. **Social proof** → Use "50+ agents deployed", "10,000+ tasks handled", GitHub stars (dynamic via GitHub API)
4. **Self-host vs Cloud messaging** → OSS is the primary identity; cloud positioned as "makes life easier for teams". Both paths prominent, OSS first
5. **Blog/Examples** → Examples in footer only; Blog stays in header nav (good for SEO)
6. **Images** → Focus on landing SVGs only; propose variant SVG designs in the implementation plan

---

## 5. File Inventory (files to modify/create/delete)

### Modify
| File | Change |
|------|--------|
| `landing/src/app/page.tsx` | Remove Waitlist, consolidate sections, add pricing teaser |
| `landing/src/components/navbar.tsx` | Simplify nav items, add "Start Free Trial" CTA |
| `landing/src/components/hero.tsx` | Update CTAs, improve visual hierarchy, add cloud CTA |
| `landing/src/components/cta.tsx` | Point to cloud.agent-swarm.dev, dual path (cloud + self-host) |
| `landing/src/components/footer.tsx` | Add Pricing link, Cloud link |
| `landing/src/app/layout.tsx` | Update meta description to mention cloud/trial, update JSON-LD |
| `landing/src/app/sitemap.ts` | Add `/pricing` route |
| `landing/package.json` | Remove `resend` dependency |

### Create
| File | Purpose |
|------|---------|
| `landing/src/app/pricing/page.tsx` | New pricing page with SEO |
| `landing/src/components/pricing-section.tsx` | Reusable pricing cards (used on both pricing page and landing teaser) |

### Delete
| File | Reason |
|------|--------|
| `landing/src/components/waitlist.tsx` | Replaced by cloud CTA |
| `landing/src/app/actions/waitlist.ts` | No longer needed without waitlist |

### Potentially Remove/Condense
| File | Consideration |
|------|--------------|
| `landing/src/components/workshops.tsx` | Low conversion value, consider removing |
| `landing/src/components/why-choose.tsx` | Merge key points into features or how-it-works |
| `landing/src/components/architecture.tsx` | Move detailed architecture to docs site |

---

## 6. Competitive Reference

For pricing page design inspiration (developer tools with similar pricing models):
- **Railway.app** — clean per-resource pricing, usage calculator
- **Render.com** — simple tier cards with feature comparison
- **Fly.io** — per-machine pricing similar to our model
- **Supabase** — free tier + paid tiers with clear feature differentiation

These all share: clean design, dark mode option, prominent free trial/tier, FAQ section, minimal text.

---

## 7. Recommended Next Steps

1. **Clarify open questions** (currency, screenshots, messaging balance)
2. **Create a plan** for the implementation (section-by-section)
3. **Design the pricing page** first (it's new content, defines the messaging)
4. **Redesign the landing page** (simplify, add cloud CTA)
5. **Update SEO** (meta, JSON-LD, sitemap)
6. **Test** (mobile responsiveness, Lighthouse score, OG preview)
