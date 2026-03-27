---
title: "Landing Page Cloud Integration & Redesign"
date: 2026-03-27
type: plan
autonomy: verbose
status: ready
research: thoughts/taras/research/2026-03-27-landing-page-cloud-redesign.md
---

# Landing Page Cloud Integration & Redesign

## Overview

Replace the email waitlist with a direct cloud CTA (`cloud.agent-swarm.dev`), add a pricing page, simplify navigation, consolidate sections (10 → 8), and update SEO — all within the existing Next.js 16 server build on Vercel.

## Current State Analysis

**Stack**: Next.js 16.1.6, React 19, Tailwind v4 (OKLCH colors), Framer Motion 12, Plausible analytics, Resend for waitlist signups. Deployed as a **server build on Vercel** (not static export).

**Current page** (10 sections): Navbar → Hero → Features (8 cards) → WhyChoose (4 dark cards) → HowItWorks (3 steps) → Architecture (diagram) → Workshops → CTA → Waitlist → Footer

**Issues**:
- Navbar has 9+ items — too dense
- Hero and CTA point to docs/GitHub, not the cloud product
- Waitlist captures email via Resend but doesn't convert to users
- No pricing information anywhere (JSON-LD has `price: "0"`)
- WhyChoose and Architecture overlap with Features conceptually

### Key Discoveries:
- `next.config.ts` has **no `output: "export"`** — this is a full server build, not static export (research doc was wrong about this constraint)
- Cloud URL is `cloud.agent-swarm.dev` (not `app.agent-swarm.dev` which is the old Dashboard link in the navbar)
- Tailwind v4 uses `@theme` in `globals.css` — no `tailwind.config.*` file
- All section components follow the same shell: `<section id="...">` > gradient bg > `max-w-6xl` container > motion header > content
- Footer is the only Server Component; all others are `"use client"`
- Resend integration: 2 files (`waitlist.tsx` + `actions/waitlist.ts`), 2 env vars (`RESEND_API_KEY`, `RESEND_SEGMENT_ID`)

## Desired End State

**Target page** (8 sections): Navbar (5 items + CTA) → Hero (cloud-first) → Features (6 cards) → HowItWorks (3 steps + WhyChoose value props) → Workshops (kept) → Pricing Teaser → CTA (dual-path) → Footer

**New route**: `/pricing` — full pricing page with FAQ

**Key outcomes**:
- Primary CTA everywhere → `https://cloud.agent-swarm.dev`
- Pricing visible on landing (teaser) and dedicated page
- Waitlist and Resend dependency removed
- Navbar simplified from 9+ items to 5 + 1 CTA button
- Architecture condensed into Features; WhyChoose merged into HowItWorks
- SEO updated with cloud/trial keywords and pricing JSON-LD

## Quick Verification Reference

Common commands:
- `cd landing && bun run build` — build check
- `cd landing && bun run dev` — local dev server (Turbopack)
- `cd landing && bun run lint` — lint check

Key files:
- `landing/src/app/page.tsx` — page composition
- `landing/src/app/layout.tsx` — metadata, JSON-LD
- `landing/src/app/sitemap.ts` — sitemap routes
- `landing/src/app/globals.css` — theme tokens
- `landing/package.json` — dependencies

## What We're NOT Doing

- Changing fonts (Space Grotesk / Space Mono stay)
- Changing the color system (amber/zinc OKLCH stays)
- Touching blog or examples pages
- Adding a currency selector (EUR only for now — simplifies implementation)
- Fetching prices from Stripe at build time (hardcoded, prices rarely change)
- Replacing Plausible analytics
- Adding social proof / GitHub stars (deferred to a future iteration)
- Touching the SwarmVisualization SVG in Hero (keep as-is)

## Implementation Approach

5 phases, each independently testable. Work exclusively within `landing/` directory. Each phase produces a buildable, visually coherent site — no broken intermediate states.

**Feature card decisions** (8 → 6):
- **Keep**: Lead-Worker Orchestration, Persistent Memory, Task Lifecycle, Agent Templates, MCP-Native
- **Add**: Docker-Isolated Workers (from Architecture/WhyChoose "Dockerized from Day One")
- **Merge**: Identity & Soul → into Persistent Memory; Epics & Scheduling → into Task Lifecycle
- **Drop**: Slack Integration (still mentioned in HowItWorks visual, just not a top-level feature card)

**Grid change**: `lg:grid-cols-4` (8 cards) → `sm:grid-cols-2 lg:grid-cols-3` (6 cards)

---

## Phase 1: Remove Waitlist & Clean Dependencies

### Overview
Remove the waitlist functionality and Resend dependency. This is a clean-up phase that sets the foundation for the cloud CTA.

### Changes Required:

#### 1. Delete Waitlist Files
**File**: `landing/src/components/waitlist.tsx`
**Changes**: Delete entirely

**File**: `landing/src/app/actions/waitlist.ts`
**Changes**: Delete entirely

#### 2. Remove Waitlist from Page
**File**: `landing/src/app/page.tsx`
**Changes**:
- Remove `import { Waitlist } from "@/components/waitlist"` (line 10)
- Remove `<Waitlist />` from the JSX (between CTA and Footer)

#### 3. Remove Resend Dependency
**File**: `landing/package.json`
**Changes**:
- Remove `"resend": "^6.9.2"` from dependencies

#### 4. Clean Install
Run `cd landing && bun install` to update the lockfile.

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `cd landing && bun run build`
- [ ] No references to waitlist: `grep -r "waitlist\|Waitlist\|resend\|Resend\|RESEND" landing/src/`
- [ ] No resend in deps: `grep "resend" landing/package.json` (should return nothing)

#### Manual Verification:
- [ ] `cd landing && bun run dev` — page loads without errors
- [ ] Scroll to bottom — no waitlist form, footer follows CTA directly

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Navigation & CTAs → Cloud-First

### Overview
Simplify the navbar, update Hero/CTA/Footer to point to `cloud.agent-swarm.dev`. All primary CTAs become "Start Free Trial" pointing to the cloud.

### Changes Required:

#### 1. Simplify Navbar
**File**: `landing/src/components/navbar.tsx`
**Changes**:
- **Desktop nav items** → reduce to 5 items + 1 CTA button:
  | Current | Action |
  |---------|--------|
  | Features (anchor) | **Remove** (users scroll naturally) |
  | How It Works (anchor) | **Remove** |
  | Architecture (anchor) | **Remove** (section being removed) |
  | Blog (/blog) | **Keep** |
  | Examples (/examples) | **Remove** from nav (keep in footer) |
  | Templates (external) | **Keep** |
  | Docs (external) | **Keep** |
  | Dashboard (app.agent-swarm.dev) | **Remove** (replaced by cloud CTA) |
  | GitHub (button) | **Keep** as icon-only link (not button) |

- **New nav order**: `Docs` | `Pricing` (/pricing) | `Blog` | `Templates` | GitHub icon | **"Start Free Trial"** (amber button → `https://cloud.agent-swarm.dev`)
- **Mobile menu**: Same items + "Start Free Trial" as prominent button at bottom
- Remove the divider (`w-px h-5 bg-zinc-200`)
- Remove unused icon imports (`Newspaper`, `Play`, `LayoutDashboard`)

#### 2. Update Hero CTAs
**File**: `landing/src/components/hero.tsx`
**Changes**:
- **Primary CTA**: "Get Started" → **"Start Free Trial"** with `ArrowRight` → `https://cloud.agent-swarm.dev`
- **Secondary CTA**: Keep "GitHub" button → `https://github.com/desplega-ai/agent-swarm` (no change)
- **Badge**: "Open Source · MCP-Powered" → keep as-is (still accurate)
- **Subheadline**: Append mention of cloud: "...Knowledge compounds. **Deploy in minutes with Agent Swarm Cloud, or self-host for free.**"
- Keep all animations and SwarmVisualization unchanged

#### 3. Update CTA Section
**File**: `landing/src/components/cta.tsx`
**Changes**:
- **Heading**: "Ready to build your swarm?" → keep (still good)
- **Subtext**: Update to mention both paths: "Start your 7-day free trial on Agent Swarm Cloud, or self-host the open-source version for free. Either way, your agents start compounding today."
- **Primary button**: "Get Started" → **"Start Free Trial"** → `https://cloud.agent-swarm.dev` (amber button, keep shadow)
- **Secondary button**: "Star on GitHub" → **"Self-Host (Free)"** → `https://docs.agent-swarm.dev/docs/getting-started` (keep ghost style)

#### 4. Update Footer
**File**: `landing/src/components/footer.tsx`
**Changes**:
- Add "Pricing" link → `/pricing` (internal, `Link`)
- Add "Cloud" link → `https://cloud.agent-swarm.dev` (external)
- Change "Dashboard" link from `app.agent-swarm.dev` to `cloud.agent-swarm.dev`
- Keep all other links (GitHub, Docs, Blog, Examples, Templates, desplega.sh)
- **Link order**: GitHub | Docs | Pricing | Blog | Templates | Cloud | desplega.sh

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `cd landing && bun run build`
- [ ] Cloud URL present: `grep -r "cloud.agent-swarm.dev" landing/src/ | wc -l` (should be ≥ 4: navbar, hero, cta, footer)
- [ ] No old Dashboard URL: `grep -r "app.agent-swarm.dev" landing/src/` (should return nothing)
- [ ] Pricing link present: `grep -r '"/pricing"' landing/src/` (navbar + footer)

#### Manual Verification:
- [ ] `bun run dev` — navigate through all pages
- [ ] Navbar: 5 items + "Start Free Trial" button visible on desktop
- [ ] Navbar: mobile menu opens, shows same items + prominent CTA
- [ ] Hero: primary CTA says "Start Free Trial", links to cloud.agent-swarm.dev
- [ ] CTA section: dual-path messaging (cloud + self-host)
- [ ] Footer: Pricing and Cloud links present
- [ ] Click "Pricing" link → should 404 (page not created yet — expected)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Desktop navbar layout
  - Steps: 1. Open landing on desktop viewport, 2. Verify nav items, 3. Click "Start Free Trial"
  - Expected: Navigates to cloud.agent-swarm.dev in new tab
- [ ] TC-2: Mobile navbar
  - Steps: 1. Open on mobile viewport, 2. Tap hamburger, 3. Verify menu items, 4. Tap "Start Free Trial"
  - Expected: Menu opens, all items visible, CTA works
- [ ] TC-3: Hero CTA
  - Steps: 1. Load page, 2. Click primary hero button
  - Expected: Opens cloud.agent-swarm.dev
- [ ] TC-4: CTA section dual-path
  - Steps: 1. Scroll to CTA section, 2. Verify both buttons
  - Expected: "Start Free Trial" → cloud, "Self-Host (Free)" → docs

---

## Phase 3: Section Consolidation

### Overview
Remove WhyChoose and Architecture sections. Absorb their best content into Features (6 cards) and HowItWorks (value prop badges). Remove the section anchor links that no longer exist.

### Changes Required:

#### 1. Update Features → 6 Cards
**File**: `landing/src/components/features.tsx`
**Changes**:

Replace the 8-item `features` array with 6 items:

```typescript
const features = [
  {
    icon: Network,
    title: "Lead-Worker Orchestration",
    description: "A lead agent coordinates specialized workers. Tasks are delegated, tracked, and completed autonomously — like a team that never sleeps.",
    color: "from-amber-500 to-orange-500",
  },
  {
    icon: Brain,
    title: "Persistent Memory & Identity",
    description: "Agents remember across sessions. Each develops a unique identity with SOUL.md and IDENTITY.md — knowledge truly compounds over time.",
    color: "from-violet-500 to-purple-500",
  },
  {
    icon: Workflow,
    title: "Tasks, Epics & Scheduling",
    description: "Tasks flow through a rich lifecycle with full traceability. Organize work into epics, schedule recurring tasks with cron — the swarm runs while you sleep.",
    color: "from-emerald-500 to-teal-500",
  },
  {
    icon: Blocks,
    title: "Agent Templates",
    description: "Start from pre-built templates — Lead, Coder, Researcher, Reviewer, Tester, and more. Or create your own and share them with the community.",
    color: "from-rose-500 to-pink-500",
    link: "https://templates.agent-swarm.dev",
  },
  {
    icon: Zap,
    title: "MCP-Native",
    description: "Built on the Model Context Protocol. Every capability is a tool. Agents discover and invoke each other's services seamlessly.",
    color: "from-orange-500 to-red-500",
  },
  {
    icon: Server,
    title: "Docker-Isolated Workers",
    description: "Each worker runs in its own Docker container with full workspace isolation. Self-host on any infrastructure, air-gapped or cloud — your call.",
    color: "from-blue-500 to-cyan-500",
  },
];
```

- Update grid: `lg:grid-cols-4` → `sm:grid-cols-2 lg:grid-cols-3`
- Update icon imports: remove `Layers`, `Clock`, `Database`, `Users`; add `Server` (from lucide-react)
- Remove unused `React` import if no longer needed for type annotation (use inline type instead)

#### 2. Add Value Prop Badges to HowItWorks
**File**: `landing/src/components/how-it-works.tsx`
**Changes**:

Add a small badge/tagline to each step from WhyChoose's key points:

- Step 1 "Deploy the Swarm" → add badge: `"Docker-isolated · Runs anywhere · Self-hosted or cloud"`
- Step 2 "Delegate Tasks" → add badge: `"Any LLM · No vendor lock-in"`
- Step 3 "Knowledge Compounds" → add badge: `"Open source · Your agents are your IP"`

Implementation: Add a `badge` string field to each step object, render as a small `<span>` with `text-xs font-medium text-amber-600 bg-amber-50 rounded-full px-3 py-1` below the step description.

#### 3. Delete Removed Sections
**File**: `landing/src/components/why-choose.tsx` → **Delete entirely**
**File**: `landing/src/components/architecture.tsx` → **Delete entirely**

#### 4. Update Page Composition
**File**: `landing/src/app/page.tsx`
**Changes**:
- Remove `import { WhyChoose }` and `import { Architecture }`
- Remove `<WhyChoose />` and `<Architecture />` from JSX
- Resulting order: Navbar → Hero → Features → HowItWorks → Workshops → CTA → Footer

(Note: Pricing Teaser will be added in Phase 4 between Workshops and CTA)

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `cd landing && bun run build`
- [ ] Deleted files gone: `ls landing/src/components/why-choose.tsx landing/src/components/architecture.tsx` (should fail — files don't exist)
- [ ] No imports of deleted components: `grep -r "WhyChoose\|Architecture\|why-choose\|architecture" landing/src/app/page.tsx`
- [ ] Features has 6 items: `grep -c "title:" landing/src/components/features.tsx` (should be 6)

#### Manual Verification:
- [ ] `bun run dev` — page loads, smooth scroll through all sections
- [ ] Features section: 6 cards in 3-column grid on desktop, 2-column on tablet, 1-column on mobile
- [ ] HowItWorks: each step shows its value prop badge
- [ ] No gaps or visual breaks between sections
- [ ] Workshops section still renders correctly after Architecture removal

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Pricing

### Overview
Create a new `/pricing` route with full pricing display, and add a compact pricing teaser section to the landing page.

### Changes Required:

#### 1. Create Pricing Section Component
**File**: `landing/src/components/pricing-section.tsx` (NEW)
**Changes**: Create a reusable pricing component used on both the pricing page and the landing teaser.

**Design**:
- Two cards side by side (`sm:grid-cols-2`):
  - **Platform** — €9/mo: base infrastructure, dashboard, integrations
  - **Worker Compute** — €29/mo per worker: Docker-isolated agent, managed infrastructure
- Example calculations row: "1 worker = €38/mo · 3 workers = €96/mo · 6 workers = €183/mo"
- "7-day free trial" badge prominently on each card
- Primary CTA: "Start Free Trial" → `https://cloud.agent-swarm.dev`
- Secondary note: "Prefer self-hosting? It's free and MIT-licensed." → docs link

**Style**: Follow the existing section patterns — light gradient bg, amber accents, framer-motion whileInView. Card style matches the existing light card pattern (`rounded-2xl bg-white border border-zinc-100 p-6 hover:border-zinc-200`).

**Props**: Accept `compact?: boolean` — when true, shows a shorter version for the landing page teaser (no FAQ, no example calculations).

#### 2. Create Pricing Page
**File**: `landing/src/app/pricing/page.tsx` (NEW)
**Changes**: Full pricing page with:
- Page-level metadata (title, description, OpenGraph)
- `<PricingSection />` component (full mode)
- FAQ section with 5-6 common questions (hardcoded):
  - "What's included in the platform fee?"
  - "How do workers scale?"
  - "Is there a free trial?"
  - "What happens after the trial?"
  - "Can I self-host instead?"
  - "What LLMs are supported?"
- JSON-LD: `Product` schema with pricing offers in EUR

#### 3. Add Pricing Teaser to Landing
**File**: `landing/src/app/page.tsx`
**Changes**:
- Import `PricingSection`
- Add `<PricingSection compact />` between `<Workshops />` and `<CTA />`

**Resulting page order**: Navbar → Hero → Features → HowItWorks → Workshops → **PricingTeaser** → CTA → Footer

#### 4. Delete Actions Directory (if empty)
**File**: `landing/src/app/actions/` directory
**Changes**: If `waitlist.ts` was the only file (it was), delete the empty `actions/` directory.

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `cd landing && bun run build`
- [ ] Pricing page exists: `ls landing/src/app/pricing/page.tsx`
- [ ] Pricing component exists: `ls landing/src/components/pricing-section.tsx`
- [ ] Pricing page builds: `grep "pricing" landing/.next/server/app/pricing/page.js` (or similar build output check)
- [ ] No empty actions dir: `ls landing/src/app/actions/ 2>&1` (should fail)

#### Manual Verification:
- [ ] `bun run dev` → navigate to `/pricing` — full pricing page loads
- [ ] Pricing page: two cards with €9/mo and €29/mo, example calculations visible
- [ ] Pricing page: FAQ section with expandable questions
- [ ] Pricing page: "Start Free Trial" CTA works → cloud.agent-swarm.dev
- [ ] Landing page: pricing teaser appears between Workshops and CTA
- [ ] Landing page: teaser shows compact pricing (no FAQ, no examples)
- [ ] Landing page: "See full pricing" link navigates to /pricing
- [ ] Mobile: pricing cards stack vertically on small screens

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Pricing page loads
  - Steps: 1. Navigate to /pricing, 2. Verify two pricing cards, 3. Verify FAQ section
  - Expected: Platform €9/mo and Worker €29/mo cards, 6 FAQ items
- [ ] TC-2: Pricing page CTA
  - Steps: 1. On /pricing, 2. Click "Start Free Trial"
  - Expected: Opens cloud.agent-swarm.dev
- [ ] TC-3: Landing teaser
  - Steps: 1. Scroll landing page to pricing teaser, 2. Verify compact layout
  - Expected: Two cards, no FAQ, "See full pricing" link
- [ ] TC-4: Mobile pricing
  - Steps: 1. Open /pricing on mobile viewport
  - Expected: Cards stack, FAQ still accessible

---

## Phase 5: SEO & Polish

### Overview
Update metadata, JSON-LD schemas, and sitemap to reflect the cloud product, pricing, and free trial. Final polish pass.

### Changes Required:

#### 1. Update Layout Metadata
**File**: `landing/src/app/layout.tsx`
**Changes**:
- **Description**: Update to mention cloud and trial: "Run a team of AI coding agents that coordinate autonomously. Start your 7-day free trial on Agent Swarm Cloud, or self-host for free. Open source, MCP-powered."
- **Keywords**: Add "agent swarm cloud", "free trial", "pricing", "managed agents"

#### 2. Update JSON-LD Schemas
**File**: `landing/src/app/layout.tsx`
**Changes**:
- **SoftwareApplication**: Update `offers` from single `price: "0"` to an array:
  ```json
  "offers": [
    {
      "@type": "Offer",
      "name": "Open Source (Self-Hosted)",
      "price": "0",
      "priceCurrency": "EUR"
    },
    {
      "@type": "Offer",
      "name": "Agent Swarm Cloud - Platform",
      "price": "9",
      "priceCurrency": "EUR",
      "priceValidUntil": "2027-12-31",
      "availability": "https://schema.org/InStock"
    },
    {
      "@type": "Offer",
      "name": "Agent Swarm Cloud - Worker",
      "price": "29",
      "priceCurrency": "EUR",
      "priceValidUntil": "2027-12-31",
      "availability": "https://schema.org/InStock"
    }
  ]
  ```
- Add `url: "https://cloud.agent-swarm.dev"` to the SoftwareApplication

#### 3. Update Sitemap
**File**: `landing/src/app/sitemap.ts`
**Changes**:
- Add `/pricing` route with priority `0.9`, changeFrequency `monthly`

#### 4. Verify OpenGraph
**File**: `landing/src/app/layout.tsx`
**Changes**:
- Update `og:description` to match new meta description
- Verify `og-image.png` still makes sense (it does — no changes needed)

#### 5. Pricing Page Metadata
**File**: `landing/src/app/pricing/page.tsx`
**Changes** (verify these were set in Phase 4):
- Title: "Pricing — Agent Swarm Cloud"
- Description: "Start with a 7-day free trial. Platform fee €9/mo + €29/mo per worker. Managed infrastructure, real-time dashboard, Slack & GitHub integrations included."
- JSON-LD: FAQPage schema for the FAQ section (rich results in Google)

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `cd landing && bun run build`
- [ ] Meta description updated: `grep -i "free trial" landing/src/app/layout.tsx`
- [ ] JSON-LD has pricing: `grep -c '"price"' landing/src/app/layout.tsx` (should be ≥ 3)
- [ ] Sitemap has pricing: `grep "pricing" landing/src/app/sitemap.ts`
- [ ] Pricing page has metadata: `grep "metadata" landing/src/app/pricing/page.tsx`

#### Manual Verification:
- [ ] `bun run dev` — verify all pages load
- [ ] View page source on `/` — verify JSON-LD has pricing offers
- [ ] View page source on `/pricing` — verify FAQPage JSON-LD
- [ ] Check Open Graph preview (use an OG debugger or inspect meta tags)
- [ ] Navigate all internal links — no 404s
- [ ] Full scroll through landing page — all sections flow smoothly, no visual breaks

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

**Per-phase testing**: Each phase has automated (`bun run build`, `grep` checks) and manual verification steps.

**Final E2E**:
```bash
# Full build
cd landing && bun run build

# Lint check
cd landing && bun run lint

# Dev server manual walkthrough
cd landing && bun run dev
# Visit: http://localhost:3000
# - Scroll through all sections on desktop and mobile viewports
# - Click all CTAs (should open cloud.agent-swarm.dev)
# - Navigate to /pricing
# - Check /pricing FAQ expand/collapse
# - Verify footer links
# - Check page source for JSON-LD
# - View OG meta tags
```

**Lighthouse**: After all phases, run Lighthouse on both `/` and `/pricing` to ensure performance is maintained (target: 90+ on all metrics).

## References
- Related research: `thoughts/taras/research/2026-03-27-landing-page-cloud-redesign.md`
- Cloud platform: `https://cloud.agent-swarm.dev`
- Stripe pricing (EUR): Platform €9/mo, Worker €29/mo, 7-day free trial
