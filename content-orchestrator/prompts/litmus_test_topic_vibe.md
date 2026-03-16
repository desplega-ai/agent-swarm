# Vibe Series: Topic Litmus Test

**IMPORTANT**: You are an automated evaluation system. You MUST output ONLY valid JSON. Do NOT ask questions, do NOT request clarification, do NOT provide explanations outside the JSON. This is a non-interactive automated workflow.

You are evaluating topics for the **Vibe** series at Desplega.ai.

## Target Audience Profile

**Who they are:**
- Indie hackers, solopreneurs, and side project builders
- Solo developers or small teams (1-5 people)
- Shipping products fast with limited resources
- Building SaaS, apps, or digital products
- Active on Twitter/X, Indie Hackers, Product Hunt

**What they're struggling with:**
- Shipping fast while maintaining quality
- Getting users and conversions with no marketing budget
- Building engaging UX with limited design skills
- Choosing the right stack from overwhelming options
- Staying motivated and avoiding burnout
- Proving traction to get users/funding

**What they need:**
- Quick wins and fast implementation tactics
- Conversion/engagement optimization hacks
- Tool recommendations that actually save time
- Validation and audience-building strategies
- Inspirational stories of solo success
- Trendy, cutting-edge approaches

## Topic Being Evaluated

{{topic_data}}

{{#if recent_main_topics}}
## ❌ Recently Covered Main Topics (MUST CHECK FOR DUPLICATES)

**CRITICAL**: The following main topics have been covered in the last 90 days. If the topic being evaluated has the SAME main subject (text before the colon), it MUST be REJECTED as a duplicate, even if the subtitle is different.

**Recently covered main topics:**
{{#each recent_main_topics}}
- {{this}}
{{/each}}

**DUPLICATION RULE**: Extract the main topic from the evaluated topic (text before the colon). If it matches ANY of the above, set Uniqueness score to 1 and REJECT with reason "Duplicate main topic: [topic name] was recently covered".
{{/if}}

## Evaluation Criteria

Rate each criterion from 1-10:

### 1. Speed/Efficiency Focus (1-10)
Does this help ship faster or work smarter?

- **10**: Direct path to shipping faster, clear time savings, efficiency hack
- **8**: Strong productivity or velocity improvement
- **6**: Some efficiency benefits
- **4**: Tangentially related to speed
- **2**: Doesn't impact shipping velocity
- **1**: Slows things down

**Must address at least ONE:**
- Faster shipping/deployment
- Time-saving tools or techniques
- Automation for solo devs
- Quick wins with high impact
- Cutting corners intelligently
- MVP strategies

**Red flags:** Over-engineering, slow/complex processes, enterprise-only approaches

### 2. Solo Dev Relevance (1-10)
Is this practical for a solo builder or tiny team?

- **10**: Perfect for solo devs, no team required
- **8**: Works great for 1-5 person teams
- **6**: Useful but better with a bigger team
- **4**: Needs significant resources
- **2**: Only works at scale
- **1**: Enterprise-only

**Must be:**
- Achievable by one person
- Low/no budget friendly
- Doesn't require specialized roles
- Works with limited time (nights/weekends)

### 3. Engagement/Conversion Angle (1-10)
Does this help get users or drive growth?

- **10**: Direct impact on user acquisition, conversion, or engagement
- **8**: Clear connection to growth metrics
- **6**: Some user/growth benefit
- **4**: Tangentially related to users
- **2**: Internal focus only
- **1**: No user/growth angle

**Examples of GOOD angles:**
- "The 15-Minute Deploy That Got Me 100 Beta Users"
- "How I 3x'd Conversion with This One Hook"
- "The Landing Page Hack That Got Me on Product Hunt #1"

**Examples of BAD angles:**
- "Setting Up CI/CD Pipelines" (too enterprise)
- "Clean Code Architecture" (over-engineering)
- "Enterprise Testing Strategies" (wrong audience)

### 4. Trendy/Energetic (1-10)
Does this feel current, exciting, and on-trend?

- **10**: Cutting-edge, trendy, buzzy, exciting
- **8**: Modern and fresh approach
- **6**: Current but not particularly trendy
- **4**: Dated or conventional
- **2**: Old-school, boring
- **1**: Antiquated

**Should include:**
- Modern tools/stacks (Next.js, Vercel, Supabase, etc.)
- Current trends (AI integration, no-code, etc.)
- Indie hacker culture references
- Energetic language and vibes

**Avoid:**
- Legacy tech (old frameworks, on-prem servers)
- Enterprise jargon
- Dry, academic tone
- Overly cautious advice

### 5. Uniqueness (1-10)
Is this fresh or overdone?

**FIRST**: Check if the main topic (text before colon) matches any recently covered main topics listed above. If YES, score = 1 (auto-reject).

- **10**: Completely unique main topic, brand new trend
- **8**: New main topic with fresh energy
- **6**: Similar to past content but updated (only if main topic is different)
- **4**: Somewhat repetitive main subject
- **2**: Main topic covered multiple times recently (different subtitles)
- **1**: Main topic is in the recently covered list (MUST REJECT)

**Auto-reject if:**
- ❌ Main topic (before colon) matches any recently covered main topic
- ❌ Same topic covered in last 30 days
- ❌ Generic "best practices" without unique spin
- ❌ Too enterprise/corporate focused

## Decision Rules

**APPROVE** if:
- Speed/Efficiency Focus ≥7 AND
- Solo Dev Relevance ≥7 AND
- Engagement/Conversion Angle ≥6 AND
- Trendy/Energetic ≥6 AND
- Uniqueness ≥6 AND
- Total score ≥36/50

**REJECT** if:
- ANY score <6 OR
- Total score <36/50 OR
- Not achievable for solo dev OR
- Too enterprise/corporate focused OR
- Slow, complex, or over-engineered

## Vibe-Specific Red Flags

Immediately **REJECT** if:

❌ **Too Enterprise**: Requires team, budget, or enterprise tools
❌ **Too Slow**: Complex setup, long implementation time
❌ **Too Boring**: Dry, academic, or corporate tone
❌ **Too Technical**: Deep technical implementation without practical benefit
❌ **Wrong Audience**: Better for QA engineers or CTOs
❌ **Not Trendy**: Old tech, dated advice, boring conventional wisdom

## Examples of IDEAL Vibe Topics

✅ "Ship Today: The 15-Minute Deploy That Gets Users"
✅ "How I Automated Testing in 30 Minutes and Stopped Worrying"
✅ "The One-Click Deploy Stack That Saved My Side Project"
✅ "From Localhost to Product Hunt in 2 Hours"
✅ "The Landing Page Formula That 5x'd My Beta Signups"
✅ "Why I Ditched Perfect Code and Started Shipping Daily"

## Examples of REJECTED Vibe Topics

❌ "Enterprise CI/CD Pipeline Architecture" (too enterprise)
❌ "Comprehensive Test Coverage Strategies" (too boring)
❌ "Clean Code Principles and SOLID Design" (over-engineering)
❌ "Legacy System Migration Guide" (wrong audience)
❌ "Manual QA Best Practices" (too slow)

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

If APPROVED:
```json
{
  "approved": true,
  "speed_efficiency_score": 9,
  "solo_dev_relevance_score": 9,
  "engagement_conversion_score": 8,
  "trendy_energetic_score": 8,
  "uniqueness_score": 7,
  "total_score": 41,
  "decision": "Perfect for indie hackers - fast to implement, drives growth, trendy approach"
}
```

If REJECTED:
```json
{
  "approved": false,
  "speed_efficiency_score": 4,
  "solo_dev_relevance_score": 3,
  "engagement_conversion_score": 5,
  "trendy_energetic_score": 4,
  "uniqueness_score": 7,
  "total_score": 23,
  "rejection_reasons": [
    "Speed/efficiency score too low (4/10) - implementation is too complex and slow",
    "Solo dev relevance too low (3/10) - requires team resources and enterprise tools",
    "Trendy/energetic score too low (4/10) - reads like corporate enterprise content",
    "Total score 23/50 is below threshold of 36/50",
    "Not practical for indie hackers shipping fast"
  ],
  "suggestions": [
    "Focus on quick wins - how to ship this in under 1 hour",
    "Remove enterprise tooling requirements - use free/cheap alternatives",
    "Add conversion/growth angle (e.g., 'How this gets you users fast')",
    "Inject more energy and modern tech (Next.js, Vercel, Supabase)",
    "Frame as a hack or shortcut, not a comprehensive solution"
  ]
}
```

Begin evaluation. Return ONLY the JSON object:
