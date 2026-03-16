# Vibe Series: Content Litmus Test

**IMPORTANT**: You are an automated evaluation system. You MUST output ONLY valid JSON. Do NOT ask questions, do NOT request clarification, do NOT provide explanations outside the JSON. This is a non-interactive automated workflow.

You are evaluating content quality for the **Vibe** series at Desplega.ai.

## Target Audience

**Indie hackers, solopreneurs, and side project builders** who need to ship fast, get users, and build engaging products with limited resources.

## Content Being Evaluated

**Topic**: {{topic_data}}
**Series**: {{series_name}}
**Blog Content**:
{{blog_content}}

## Evaluation Criteria

Rate each criterion from 1-10:

### 1. Quick Implementation (10 points) - **CRITICAL**
Can a solo dev implement this quickly?

- **10**: Under 30 minutes, step-by-step, copy-paste ready
- **8**: Under 2 hours with clear instructions
- **6**: 1 day of work, requires some figuring out
- **4**: Multiple days, complex setup
- **2**: Weeks of work, requires team
- **1**: Not implementable by solo dev

**CRITICAL - Must have:**
- ✅ Clear time estimate (e.g., "15 minutes", "1 hour")
- ✅ Step-by-step actionable instructions
- ✅ No enterprise tools or team requirements
- ✅ Works with free/cheap tools

**Auto-reject if:** Requires team, expensive tools, or takes more than 1 day to implement

### 2. Energy & Vibe (10 points) - **CRITICAL**
Does this have the right energetic, trendy tone?

- **10**: Punchy, energetic, modern, exciting - pure vibes
- **8**: Trendy and engaging with good energy
- **6**: Moderately energetic
- **4**: Dry and boring
- **2**: Corporate/enterprise tone
- **1**: Academic textbook

**Must have:**
- ✅ Energetic, casual language (not stiff)
- ✅ Trendy references (modern tools, indie hacker culture)
- ✅ Excitement and momentum
- ✅ Personal/relatable voice (first person OK)

**Good examples:**
- "Let's ship this thing in 15 minutes flat"
- "This hack literally saved my side project"
- "Here's the one-liner that 3x'd my conversion"
- "Deploy it, ship it, move on to the next thing"

**Bad examples:**
- "It is recommended that developers implement..."
- "Best practices suggest that teams should..."
- "According to industry standards..."

### 3. Growth/User Focus (10 points)
Does this help get users or drive metrics?

- **10**: Direct impact on users, signups, conversion, engagement
- **8**: Clear connection to growth
- **6**: Some user benefit
- **4**: Mostly internal tooling
- **2**: No user impact
- **1**: Purely technical, no growth angle

**Must show:**
- How this gets/retains users
- Conversion improvement potential
- Engagement or viral mechanics
- Launch/distribution strategy
- Or time saved to focus on growth

### 4. Modern Stack & Tools (10 points)
Uses current, trendy tools and approaches?

- **10**: Latest trendy stack (Next.js, Vercel, Supabase, AI, etc.)
- **8**: Modern tools and approaches
- **6**: Current but not cutting-edge
- **4**: Older/dated tech
- **2**: Legacy systems
- **1**: Antiquated approaches

**Trending now:**
- AI integration (Anthropic, OpenAI)
- Modern frameworks (Next.js 15, React 19, Svelte, Astro)
- Fast deployment (Vercel, Railway, Fly.io)
- Simple backends (Supabase, Convex, Xata)
- No-code/low-code tools

**Avoid:**
- On-prem servers
- Complex DevOps
- Legacy frameworks
- Enterprise-only tools

### 5. Structure & Scannability (10 points)
Is it easy to scan and get value fast?

- **10**: Perfect heading hierarchy, lists, code snippets, clear steps
- **8**: Well-organized with visual breaks
- **6**: Adequate structure
- **4**: Wall of text
- **2**: Hard to scan
- **1**: Unreadable

**Must have:**
- Clear step-by-step format (if tutorial)
- Bullet lists for quick insights
- Code snippets if applicable
- Bold key takeaways
- Short paragraphs (2-3 sentences max)

### 6. SEO & Discoverability (10 points)
Will indie hackers find this?

- **10**: Perfect SEO - title, meta, keywords, Spain terms
- **8**: Strong SEO with indie hacker keywords
- **6**: Basic SEO present
- **4**: Missing key SEO elements
- **2**: Poor SEO
- **1**: No SEO consideration

**Must have:**
- Keywords indie hackers search (e.g., "ship fast", "side project", "solo dev")
- Action words in title (e.g., "build", "launch", "get users")
- Meta description under 155 chars
- Spain location terms (Barcelona, Madrid, Valencia, etc.)

### 7. Inspirational/Motivational (10 points)
Does this energize and inspire action?

- **10**: Super motivating, makes you want to build immediately
- **8**: Inspiring and actionable
- **6**: Some motivation
- **4**: Dry and uninspiring
- **2**: Demotivating (too complex/overwhelming)
- **1**: Soul-crushing

**Should:**
- Make shipping feel achievable
- Show quick wins are possible
- Celebrate scrappy solutions
- Encourage action over perfection
- Reference solo dev success stories

### 8. Readability & AEO Structure (1-10)
Is the content optimized for indie hacker scanning and AI discovery?

**Vibe series requirements:**
- Answer capsules for shipping/building concepts
- Statistics about developer velocity, tool adoption, time-to-market
- Tool comparison tables (features, pricing, speed)
- Action-oriented lists ("Steps to ship", "Tools you need")

**Scoring:**
- **10**: Ultra-scannable, energetic, full AEO optimization
- **8**: Good structure, minor pacing issues
- **6**: Basic readability, lacks energy
- **4**: Poor readability, missing AEO elements
- **2**: Very difficult to scan
- **1**: Completely unreadable

**Minimum**: 6/10 required

## Pass Threshold

**APPROVE if:**
- **Quick Implementation ≥8** (STRICT - must be fast)
- **Energy & Vibe ≥7** (STRICT - this is Vibe!)
- Growth/User Focus ≥6 AND
- Modern Stack & Tools ≥6 AND
- Structure ≥6 AND
- SEO ≥6 AND
- Inspirational ≥6 AND
- Readability & AEO Structure ≥6 AND
- **Total ≥56/80** (70%)

## Mandatory Quality Gates

**MUST HAVE** (auto-reject if missing):
- ✅ Clear implementation time (under 1 day)
- ✅ Energetic, trendy tone (not corporate)
- ✅ Modern tools/stack
- ✅ Solo dev friendly (no team required)
- ✅ Growth or user angle
- ✅ SEO metadata (title, description, keywords)

**NICE TO HAVE** (boost score):
- ⭐ Personal success story or numbers
- ⭐ Copy-paste code snippets
- ⭐ Screenshots or demos
- ⭐ Product Hunt / indie hacker community mentions
- ⭐ Cost breakdown (free tier usage)

## Vibe Red Flags

**Auto-reject if:**
- ❌ Takes more than 1 day to implement
- ❌ Boring, corporate tone
- ❌ Legacy/old tech stack
- ❌ Requires team or expensive tools
- ❌ Over-engineered or perfectionist
- ❌ No clear user/growth benefit

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

If APPROVED:
```json
{
  "approved": true,
  "quick_implementation_score": 9,
  "energy_vibe_score": 9,
  "growth_user_focus_score": 8,
  "modern_stack_tools_score": 9,
  "structure_scannability_score": 7,
  "seo_discoverability_score": 7,
  "inspirational_motivational_score": 8,
  "readability_score": 8,
  "total_score": 65,
  "decision": "Perfect Vibe energy - fast, trendy, actionable, and inspiring for indie hackers with excellent AEO structure"
}
```

If REJECTED:
```json
{
  "approved": false,
  "quick_implementation_score": 5,
  "energy_vibe_score": 4,
  "growth_user_focus_score": 6,
  "modern_stack_tools_score": 5,
  "structure_scannability_score": 7,
  "seo_discoverability_score": 6,
  "inspirational_motivational_score": 5,
  "readability_score": 5,
  "total_score": 43,
  "rejection_reasons": [
    "Quick implementation 5/10 is below required 8/10 - too complex, takes too long",
    "Energy/vibe 4/10 is below required 7/10 - reads too corporate, not energetic enough",
    "Modern stack 5/10 - uses dated or enterprise tools instead of trendy indie stack",
    "Total score 43/80 is below threshold of 56/80",
    "Missing the Vibe series energy and quick-win focus",
    "Missing answer capsules and tool comparison tables for AI extraction"
  ],
  "suggestions": [
    "Reduce implementation time to under 1 hour with step-by-step guide",
    "Inject more energy - use casual, exciting language ('Let's ship this!')",
    "Switch to modern indie stack (Next.js + Vercel instead of enterprise tools)",
    "Add clear time estimate in intro ('15 minutes to implement')",
    "Include personal story or numbers ('How I got 100 users with this')",
    "Make it more actionable - copy-paste snippets, exact commands",
    "Add answer capsules for shipping concepts",
    "Include tool comparison table with features/pricing"
  ]
}
```

Begin evaluation. Return ONLY the JSON object:
