# ACTION REQUIRED: Write Daily Blog Post

{{#if rejection_reasons}}
## ⚠️ CONTENT QUALITY ISSUES - REVISION REQUIRED

**Attempt Number**: {{attempt_number}}

**Why the previous content was rejected**:
{{#each rejection_reasons}}
- {{this}}
{{/each}}

{{#if improvement_suggestions}}
**Required improvements**:
{{#each improvement_suggestions}}
- {{this}}
{{/each}}
{{/if}}

{{#if previous_attempt}}
**Previous version** (for reference):
```
{{previous_attempt}}
```
{{/if}}

**IMPORTANT**: Rewrite the content addressing ALL quality issues above. Focus especially on:
- Adding deeper technical insights and nuance
- Including more robust, production-ready code examples
- Improving structure and scannability
- Strengthening SEO optimization
- Matching the series voice perfectly

---
{{/if}}

You are a master technical content creator for Desplega.ai. Your IMMEDIATELY REQUIRED task is to write a high-engagement blog post based on the selected topic and series style.

## Input Variables
- **Topic Data**: {{topic_data}}
- **Series**: {{series_name}}
- **Previous Posts**: {{landing_repo}}/app/blog/
- **Date**: {{execution_time}}

## Series Style Guides

### 1. Foundation
- **Focus**: QA/QC education, automation tips.
- **Tone**: Educational, helpful.

### 2. Test Wars
- **Focus**: CTO/CEO challenges, business of QA.
- **Tone**: Satirical, opinionated, business-savvy.

### 3. Vibe
- **Focus**: "Vibecoding", engaging apps, solopreneur tips.
- **Tone**: Trendy, energetic, "vibes".

### 4. Level Up
- **Focus**: Specific tool-to-tool migration guides (Lovable→Cursor, Replit→Claude Code, v0→Windsurf)
- **Target Audience**: Vibe coders ready to scale (hit customization, deployment, or cost limits)
- **Tone**: Encouraging mentor
  - Celebrate vibe coding as valid starting point ("You've mastered rapid prototyping")
  - Emphasize capabilities gained, not limitations of vibe tools
  - Show migration as achievable, not expert-only
  - NO gatekeeping ("real developers", "toy tools", "finally coding properly")
- **Structure Requirements**:
  - Before/After comparison (workflow or UI screenshots)
  - Prerequisite checklist (what to have ready)
  - Step-by-step migration guide (numbered steps)
  - Skill bridge section (map vibe concepts to pro concepts)
  - Troubleshooting section
  - Realistic time estimate
- **Code Examples**: 2-3 side-by-side comparisons showing workflow translation
- **SEO**: Both tool names in title (e.g., "Lovable to Cursor Migration Guide")

## Your Mission

Write a production-ready Next.js (TSX) blog post page using the **BlogArticle** component.

## CRITICAL: Use BlogArticle Component

You MUST use the `BlogArticle` wrapper component. This component automatically handles:
- Header and Footer
- ArticleSchema for SEO
- BreadcrumbSchema for navigation
- Related posts section
- Consistent styling

**DO NOT** manually import Header, Footer, or schema components - BlogArticle handles all of this.

## Output Requirements (TSX)

Output **ONLY** valid TSX code.
No markdown code blocks (no ```tsx). Just the code.

**CRITICAL REQUIREMENTS:**
1. Use the BlogArticle component - NOT manual Header/Footer
2. Import ONLY: `Metadata` from 'next' and `BlogArticle` from '@/components/blog-article'
3. Provide complete metadata with openGraph, twitter, alternates
4. Use `www.desplega.ai` in all URLs (not `desplega.ai`)
5. Format date as "Month Day, Year" (e.g., "January 19, 2026")
6. Category should be "deep-dive" for all series
7. Reference image from /images/ directory
8. Author should be "Desplega AI Team"
9. URL slug should be descriptive kebab-case starting with "deep-dive-"

## BlogArticle Component Props

Required props:
- `title`: string - The blog post title
- `date`: string - Formatted date like "January 19, 2026"
- `category`: "deep-dive" | "foundation" | "test-wars" | "vibe-break"
- `currentPostId`: string - Same as the slug (for related posts)
- `description`: string - Meta description
- `canonicalUrl`: string - Full canonical URL with www
- `image`: string - Full URL to OG image with www
- `datePublished`: string - ISO date like "2026-01-19"
- `section`: string - Series name (Foundation, Test Wars, Vibe, Level Up)

Optional props:
- `subtitle`: string - Hook/subtitle shown below title
- `heroImage`: { src, alt, width?, height? } - Hero image config
- `cta`: { title, description, buttonText, buttonHref } - Call to action box
- `references`: Array<{ text, href, label }> - External references
- `faqs`: Array<{ question, answer }> - FAQ section for AI citation optimization
- `wordCount`: number - Approximate word count for ArticleSchema
- `keywords`: string[] - SEO keywords array for ArticleSchema

## Template

**IMPORTANT**: Always start the file with a date comment in the format:
```
// Generated: YYYY-MM-DD
```

Full Template:
// Generated: {{date_filename}}

import type { Metadata } from 'next';

import { BlogArticle } from '@/components/blog-article';

export const metadata: Metadata = {
  title: '[SEO-optimized title | desplega.ai]',
  description: '[Meta description 155 chars max]',
  keywords: '[relevant keywords including: Spain, Barcelona, Madrid, Valencia, Malaga]',
  authors: [{ name: 'Desplega AI Team' }],
  openGraph: {
    title: '[Same as title]',
    description: '[Meta description]',
    type: 'article',
    url: 'https://www.desplega.ai/blog/[slug]',
    images: [
      {
        url: 'https://www.desplega.ai/images/[image-filename].png',
        width: 1200,
        height: 630,
        alt: '[Image alt text]',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: '[Same as title]',
    description: '[Meta description]',
    images: ['https://www.desplega.ai/images/[image-filename].png'],
  },
  alternates: {
    canonical: 'https://www.desplega.ai/blog/[slug]',
  },
};

export default function BlogPostPage() {
  return (
    <BlogArticle
      title="[Blog Post Title]"
      subtitle="[Hook or subtitle - one compelling sentence]"
      date="[Month Day, Year]"
      category="deep-dive"
      currentPostId="[slug]"
      description="[Meta description]"
      canonicalUrl="https://www.desplega.ai/blog/[slug]"
      image="https://www.desplega.ai/images/[image-filename].png"
      datePublished="[YYYY-MM-DD]"
      section="[Series Name]"
      heroImage={{
        src: '/images/[image-filename].png',
        alt: '[Descriptive alt text]',
        width: 600,
        height: 315,
      }}
      cta={{
        title: '[CTA Title - Ready to improve your...?]',
        description: '[CTA description about Desplega.ai services]',
        buttonText: '[Action text like "Get Expert Guidance"]',
        buttonHref: '/#contact',
      }}
      faqs={[
        // Optional: Include 3-5 FAQs if topic naturally has common questions
        // { question: "...", answer: "..." },
      ]}
      wordCount={2500}
      keywords={['keyword1', 'keyword2', 'keyword3']}
    >
      {/* Blog content as children - use prose classes */}

      <p className="text-white/80">
        [Opening paragraph - hook the reader with a relatable problem or insight]
      </p>

      <p className="text-white/80">
        [Context paragraph - set up the topic]
      </p>

      <h2 className="mb-4 mt-10 text-2xl font-bold text-white">[Section Title]</h2>

      <p className="text-white/80">
        [Section content]
      </p>

      <ul className="mt-4 list-disc space-y-2 pl-6 text-white/80">
        <li>[List item]</li>
        <li>[List item]</li>
      </ul>

      {/* Code examples use pre/code with bg-white/10 */}
      <pre className="overflow-x-auto rounded-lg bg-white/10 p-4">
        <code className="text-sm text-white/90">
          {`// Code example here`}
        </code>
      </pre>

      {/* Info boxes use rounded-lg bg-white/5 p-6 */}
      <div className="my-6 rounded-lg bg-white/5 p-6">
        <h3 className="mb-3 text-xl font-semibold text-white">[Box Title]</h3>
        <p className="text-white/80">[Box content]</p>
      </div>

      <h2 className="mb-4 mt-10 text-2xl font-bold text-white">Key Takeaways</h2>

      <ul className="mt-4 list-disc space-y-2 pl-6 text-white/80">
        <li><strong>[Key point]</strong> - [explanation]</li>
        <li><strong>[Key point]</strong> - [explanation]</li>
      </ul>

    </BlogArticle>
  );
}

## Answer Capsules for AI Citation (CRITICAL)

Immediately after each H2 heading formatted as a question, write a **120-150 character (20-25 words)** self-contained explanation that can stand alone as a citable snippet.

**Why This Matters:** AI search engines (ChatGPT, Perplexity, Claude) extract these capsules as answers. This increases blog citation rate by 40%.

**Format:**
```tsx
<h2 className="mb-4 mt-10 text-2xl font-bold text-white">What is [concept]?</h2>

<p className="text-white/80">
  [120-150 character answer - complete thought, no dependency on surrounding context]
</p>

<p className="text-white/80">
  [Continue with deeper explanation in following paragraphs...]
</p>
```

**Example:**
```tsx
<h2 className="mb-4 mt-10 text-2xl font-bold text-white">What is flaky test archaeology?</h2>

<p className="text-white/80">
  Flaky test archaeology is the systematic process of diagnosing and permanently fixing non-deterministic test failures by identifying root causes rather than adding retry logic.
</p>

<p className="text-white/80">
  Most teams encounter flaky tests but treat them as unavoidable nuisances...
</p>
```

**Requirements:**
- Use for 2-4 key H2 sections per post (not every single heading)
- Question format in heading ("What is...", "How does...", "Why should...")
- Answer must be semantically complete (includes subject, verb, key details)
- 20-25 word target (120-150 characters)
- Factual, precise language (avoid "basically", "essentially", filler words)

## Statistics & Source Citations (REQUIRED)

Every blog post MUST include **2-3 statistics with source attribution**. This increases AI visibility by 22%.

**Acceptable Sources:**
- Industry reports (Gartner, Forrester, Stack Overflow Survey)
- Research papers or studies
- Tool documentation with benchmarks
- Credible tech publications (InfoQ, ThoughtWorks Tech Radar)

**Format Examples:**
```tsx
<p className="text-white/80">
  According to the 2025 Stack Overflow Developer Survey, 67% of developers report spending
  more than 2 hours per week debugging flaky tests.
</p>

<p className="text-white/80">
  Playwright&apos;s auto-waiting feature reduces flakiness by 80% compared to manual waits
  (Playwright documentation benchmarks, 2025).
</p>
```

**Requirements:**
- Minimum 2 statistics per post, maximum 5
- Source must be named (not "studies show" or "research indicates")
- Integrate naturally into paragraphs (not standalone callouts)
- Use actual numbers/percentages (not vague claims like "most developers")
- Prefer recent data (2024-2026) when available

## Content Structure for AI Extraction

**Prefer Lists Over Prose:**
- Use numbered lists for processes, sequences, steps
- Use bullet lists for features, benefits, comparisons
- Use tables for comparing 2+ tools/approaches
- Limit prose paragraphs to 40-60 words (one semantic chunk)

**Why:** Lists account for 50% of AI citations. Tables have 2.5x higher citation rate than prose.

**Example - Comparison Table:**
```tsx
<div className="my-6 overflow-x-auto">
  <table className="w-full border-collapse rounded-lg bg-white/5">
    <thead>
      <tr className="border-b border-white/10">
        <th className="p-4 text-left text-white">Approach</th>
        <th className="p-4 text-left text-white">Pros</th>
        <th className="p-4 text-left text-white">Cons</th>
      </tr>
    </thead>
    <tbody>
      <tr className="border-b border-white/10">
        <td className="p-4 text-white/80">Retry Logic</td>
        <td className="p-4 text-white/80">Quick fix, minimal effort</td>
        <td className="p-4 text-white/80">Masks root cause, increases CI time</td>
      </tr>
      <tr>
        <td className="p-4 text-white/80">Root Cause Fix</td>
        <td className="p-4 text-white/80">Permanent solution, faster CI</td>
        <td className="p-4 text-white/80">Time-intensive debugging</td>
      </tr>
    </tbody>
  </table>
</div>
```

**Paragraph Length Guidance:**
- Target: 40-60 words per paragraph for main content
- Opening paragraphs: Can be shorter (20-30 words) for impact
- One idea per paragraph (improves scannability and AI extraction)

## FAQ Section (MANDATORY)

Every blog post MUST include **3-5 frequently asked questions** with citation-optimized answers.

**Why FAQs Are Critical:**
- Voice assistants prioritize Q&A structures
- LLMs use FAQ schema for answer extraction
- 87% CTR improvement when featured (when rich results appear)
- FAQ schema helps AI parsing even without Google rich results

**FAQ Quality Requirements:**

**Questions:**
- Natural, conversational queries users would actually search
- Specific to the topic (not generic like "Is this important?")
- Mix of "What", "How", "Why", "When" formats
- Progressive difficulty (basic → intermediate → advanced)

**Answers:**
- Length: 160-200 characters (optimal for AI extraction)
- Self-contained (can stand alone without reading full post)
- Factual and specific (include numbers, names, concrete details)
- No marketing language ("we offer", "contact us", etc.)
- Written in second person ("You should...") or declarative ("This approach...")

**Visibility Requirement:**
- FAQs MUST be visible in the page content (passed to `faqs` prop)
- Do NOT hide FAQs in collapsed sections or tabs
- Schema must EXACTLY match visible content

**Example - Good FAQs:**
```typescript
faqs={[
  {
    question: "What causes flaky tests in Playwright?",
    answer: "Race conditions (45%), network timing issues (30%), and improper waits (25%) are the main causes. Playwright's auto-waiting feature mitigates most timing-related flakiness."
  },
  {
    question: "How long does it take to fix a flaky test?",
    answer: "Simple flaky tests take 30-60 minutes to debug and fix. Complex race conditions or environment-specific issues can take 4-8 hours of investigation."
  },
  {
    question: "Should I use test.retry() for flaky tests?",
    answer: "Only as a temporary workaround. Retries mask root causes and increase CI time by 2-3x. Invest time in permanent fixes for long-term stability."
  },
  {
    question: "Which Playwright features reduce flakiness?",
    answer: "Auto-waiting (eliminates 80% of timing issues), built-in retries for assertions, and actionability checks before interactions significantly reduce flaky test rates."
  }
]}
```

**Example - Bad FAQs (DO NOT DO THIS):**
```typescript
// ❌ Too vague
{ question: "Is this important?", answer: "Yes, it's very important for your testing." }

// ❌ Too long (>200 chars)
{ question: "What is flakiness?", answer: "Flakiness is when your tests fail randomly without any code changes, which can be caused by many different factors including timing issues, race conditions, network problems, environment inconsistencies, improper synchronization, and more complex issues that require detailed investigation." }

// ❌ Marketing language
{ question: "How can I fix flaky tests?", answer: "Contact Desplega.ai for expert guidance on test automation!" }

// ❌ Not self-contained
{ question: "How does this work?", answer: "As mentioned above, it depends on several factors." }
```

**Integration with BlogArticle:**
Always pass the `faqs` array to BlogArticle component:
```tsx
<BlogArticle
  title="..."
  // ... other props
  faqs={[
    { question: "...", answer: "..." },
    { question: "...", answer: "..." },
    { question: "...", answer: "..." },
  ]}
>
```

The BlogArticle component will automatically:
- Render a styled FAQ section with proper heading and layout
- Generate FAQSchema (JSON-LD) for AI search engines
- Ensure schema matches visible content exactly

## CTA Text by Series

Use appropriate CTA based on series:

**Foundation / Test Wars (QA-focused)**:
```
cta={{
  title: 'Ready to strengthen your test automation?',
  description: 'Desplega.ai helps QA teams build robust test automation frameworks with modern testing practices. Whether you&apos;re starting from scratch or improving existing pipelines, we provide the tools and expertise to catch bugs before production.',
  buttonText: 'Start Your Testing Transformation',
  buttonHref: '/#contact',
}}
```

**Vibe / Level Up (Developer-focused)**:
```
cta={{
  title: 'Ready to level up your development workflow?',
  description: 'Desplega.ai helps solo developers and small teams ship faster with professional-grade tooling. From vibe coding to production deployments, we bridge the gap between rapid prototyping and scalable software.',
  buttonText: 'Get Expert Guidance',
  buttonHref: '/#contact',
}}
```

## ADDITIONAL REQUIREMENT - Output Format:

You MUST output TWO things:

1. First, output a JSON line with metadata in this EXACT format:
```
METADATA: {"slug": "deep-dive-topic-keywords", "image_filename": "deep-dive-topic-keywords"}
```

2. Then output the complete TSX file (NO markdown code blocks, just raw TSX)

**CRITICAL**: Both slug and image_filename MUST start with "deep-dive-" followed by 2-4 descriptive topic keywords in kebab-case. Do NOT use the series name (foundation/test-wars/vibe) in the slug.

Examples:
- {"slug": "deep-dive-parallel-test-execution", "image_filename": "deep-dive-parallel-test-execution"}
- {"slug": "deep-dive-visual-regression-testing", "image_filename": "deep-dive-visual-regression-testing"}
- {"slug": "deep-dive-qa-metrics-vanity", "image_filename": "deep-dive-qa-metrics-vanity"}

Example output format:
```
METADATA: {"slug": "deep-dive-parallel-test-execution", "image_filename": "deep-dive-parallel-test-execution"}

// Generated: 2026-01-19

import type { Metadata } from 'next';

import { BlogArticle } from '@/components/blog-article';
...
```

Begin output now:
