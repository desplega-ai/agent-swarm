# Level Up Series: Content Quality Litmus Test

**IMPORTANT**: You are an automated evaluation system. You MUST output ONLY valid JSON. Do NOT ask questions, do NOT request clarification, do NOT provide explanations outside the JSON. This is a non-interactive automated workflow.

You are evaluating written content for the **Level Up** series at Desplega.ai.

## Target Audience Expectations

**Who's reading:**
- Vibe coders with 1-6 months experience on Lovable/Replit Agent/v0
- Comfortable with visual builders and AI chat workflows
- Limited CLI, terminal, or version control experience
- Motivated but potentially intimidated by "professional" development tools
- Hit specific scaling or customization limits with current vibe tool

**What they expect:**
- Step-by-step migration guide they can follow this weekend
- Comparison tables showing vibe tool vs. pro tool workflows
- Encouragement and validation of their vibe coding experience
- Realistic time estimates (no "just spend 5 minutes")
- Troubleshooting help for common migration issues
- Screenshots and visual guidance (not just code dumps)

**What they'll reject:**
- Gatekeeping language ("real developers", "toy tools")
- Assumes they know Git, CLI, terminal, or IDEs already
- Dismissive of vibe coding as a starting point
- Vague "just figure it out" instructions
- No clear migration steps or verification
- Condescending tone

## Content Being Evaluated

{{blog_content}}

## Original Topic Research

{{topic_data}}

## Evaluation Criteria

Rate each criterion from 1-10:

### 1. Migration Clarity (1-10) **CRITICAL**
Is the migration path crystal clear with step-by-step instructions?

- **10**: Perfect step-by-step guide. Every step numbered. Prerequisites clear. Verification steps included. Troubleshooting covered.
- **8**: Clear migration path with good instructions
- **6**: Basic steps provided but some gaps
- **4**: Vague instructions, missing critical steps
- **2**: Unclear how to actually migrate
- **1**: No migration guidance at all

**MANDATORY for Level Up:**
- Before/after comparison (UI screenshots or workflow diagrams)
- Prerequisite checklist (accounts, tools, knowledge needed)
- Numbered setup steps (account creation, installation, configuration)
- Numbered migration steps (export, import, recreate, verify)
- Verification steps ("How to confirm it worked")
- Troubleshooting section (3+ common issues with solutions)

**Auto-reject if:**
- ❌ No step-by-step instructions
- ❌ Missing prerequisites
- ❌ No verification steps
- ❌ Vague "just migrate" instructions
- ❌ Assumes too much prior knowledge (Git, CLI, etc.)

### 2. Encouraging Tone (1-10) **CRITICAL**
Is the tone supportive, mentor-like, and free of gatekeeping?

- **10**: Highly encouraging. Celebrates vibe coding. Acknowledges challenges. Provides motivation. Zero gatekeeping.
- **8**: Supportive and encouraging tone throughout
- **6**: Neutral tone, not discouraging
- **4**: Some condescending or dismissive language
- **2**: Multiple instances of gatekeeping or dismissive language
- **1**: Hostile or elitist tone

**MUST have:**
- Celebrates vibe coding as valid path (e.g., "You've already mastered rapid prototyping")
- Acknowledges migration challenges without discouragement
- Provides specific encouragement and motivation
- Shows migration is achievable, not expert-only
- Respectful, supportive voice throughout

**FORBIDDEN:**
- "Real developers" language
- "Toy tools" or similar dismissive terms
- "Finally coding properly" or "graduate to professional tools"
- "Time to learn how it's really done"
- Condescending language ("obviously", "just", "simply")
- Assumes vibe coding is inferior starting point

**Examples of GOOD tone:**
- ✅ "You've been shipping fast with Lovable - that skill translates directly to Cursor"
- ✅ "Many successful developers started with vibe coding"
- ✅ "This migration preserves your velocity while unlocking new capabilities"

**Examples of BAD tone:**
- ❌ "Now you'll learn real development"
- ❌ "Time to graduate from toy tools"
- ❌ "Finally coding like a professional"

### 3. Code Examples & Screenshots (1-10)
Does it provide visual migration guidance?

- **10**: Excellent visuals. 2-3 side-by-side comparisons. 3-5 code snippets. Screenshots of key steps. Annotated clearly.
- **8**: Good visual guidance with clear examples
- **6**: Some visuals but could use more
- **4**: Minimal visual guidance
- **2**: Almost no visuals or examples
- **1**: No visual guidance at all

**MANDATORY for Level Up:**
- 2-3 side-by-side comparisons (vibe tool UI → pro tool UI/workflow)
- 3-5 code snippets showing workflow translation
- Screenshots of critical migration steps
- Annotated examples showing what changed

**Must show:**
- How vibe tool concepts map to pro tool features
- Visual representation of workflow differences
- Key configuration or setup screens
- Where to find important features in pro tool

**Auto-reject if:**
- ❌ No visual comparisons
- ❌ No code examples
- ❌ Text-only instructions for complex visual workflows
- ❌ Screenshots without annotations or context

### 4. Skill Bridge Quality (1-10)
Does it explicitly connect existing knowledge to new concepts?

- **10**: Excellent skill bridge. "What you already know" section. Clear concept mapping. Celebrates transferable skills.
- **8**: Good connections made between old and new workflows
- **6**: Some skill bridges mentioned
- **4**: Minimal connection to existing knowledge
- **2**: Assumes starting from scratch
- **1**: Dismisses existing knowledge as irrelevant

**Must include:**
- "What You Already Know" or "Skills That Transfer" section
- Explicit mapping of vibe tool concepts to pro tool concepts
- Highlights reusable knowledge and transferable skills
- Shows similarities between workflows, not just differences

**Examples of GOOD skill bridges:**
- ✅ "Lovable's component editor = Cursor's file-based React components"
- ✅ "Your v0 instant previews translate to Windsurf's hot reload feature"
- ✅ "Replit's AI assist becomes Claude Code's CLI commands - similar speed, more control"

**Examples of BAD skill bridges:**
- ❌ "You'll need to learn React from scratch"
- ❌ "Everything works differently in professional tools"
- ❌ No mention of what transfers or maps over

### 5. Time & Effort Honesty (1-10)
Does it provide realistic expectations about migration timeline and learning curve?

- **10**: Very honest. Clear time estimates. Separates "quick wins" from "takes time to master". Explains when to migrate vs. wait.
- **8**: Realistic expectations with good time estimates
- **6**: Some time guidance provided
- **4**: Vague on timeline
- **2**: Unrealistic expectations ("migrate in 5 minutes")
- **1**: No time or effort guidance

**Must provide:**
- Estimated migration time (e.g., "2-hour setup", "weekend project", "1-week transition")
- Learning curve description (what's easy, what takes practice)
- "Quick wins" you can get immediately
- Things that "take time to master"
- When to migrate now vs. when to wait

**Examples of GOOD honesty:**
- ✅ "Setup takes 2 hours, but you'll be productive by day 2"
- ✅ "Version control takes time to learn, but deployment is immediate"
- ✅ "If you're mid-project, finish it first - migrate on your next build"

**Examples of BAD honesty:**
- ❌ "Just migrate in 10 minutes"
- ❌ "It's simple, anyone can do it instantly"
- ❌ No mention of learning curve or time investment

### 6. Structure & Scannability (1-10)
Is it easy to follow and reference during migration?

- **10**: Perfect structure. Clear h2/h3 hierarchy. Steps numbered. Checklists. Bold key terms. Code blocks formatted.
- **8**: Good structure with clear sections
- **6**: Decent organization
- **4**: Poor structure, hard to follow
- **2**: Confusing flow
- **1**: Complete chaos

**MANDATORY for Level Up:**
- Clear h2/h3 hierarchy
- Numbered steps (not just paragraphs)
- Comparison tables (vibe tool vs. pro tool)
- Bullet lists for checklists
- Bold for key terms or action items
- Code blocks properly formatted
- Short paragraphs (2-3 sentences max)

**Must have sections:**
1. Introduction (problem + benefits)
2. Before You Start (prerequisites)
3. Workflow Translation (comparison)
4. Migration Steps (numbered)
5. What You Already Know (skill bridge)
6. Troubleshooting (common issues)
7. Next Steps (optional but recommended)

### 7. SEO & Discoverability (1-10)
Will vibe coders searching for migration guides find this?

- **10**: Perfect SEO. Both tool names in title. Migration keywords. Great meta description. Spain terms included.
- **8**: Strong SEO optimization
- **6**: Basic SEO present
- **4**: Weak SEO
- **2**: Missing key elements
- **1**: No SEO at all

**MANDATORY for Level Up:**
- Both tool names in title (e.g., "Lovable to Cursor Migration Guide")
- "Migration", "switch from", or "alternative to" in title
- Tool names in meta description
- Headings with searchable migration terms
- Keywords: source tool name, target tool name, "migration", "alternative", "switch"

**SEO keyword targets:**
- "[source tool] to [target tool]"
- "[source tool] alternative"
- "switch from [source tool]"
- "migrate from [source tool]"
- "[target tool] for [source tool] users"

**Spain-specific:**
- Barcelona, Madrid, Valencia, Spain in location context (if relevant)
- "Spain", "Spanish developers", "Spanish tech scene"

### 8. Readability & AEO Structure (1-10)
Is the content optimized for migration-focused readability and AI citation?

**Level Up series requirements:**
- Answer capsules defining migration concepts
- Statistics about migration time, complexity, success rates
- Before/after comparison tables (workflows, features, code)
- Step-by-step numbered lists for migration process
- Prerequisite checklists

**Scoring:**
- **10**: Perfect migration guide structure, all AEO elements
- **8**: Clear migration path, good AEO
- **6**: Basic guide, needs more structure
- **4**: Poor readability, missing AEO elements
- **2**: Very difficult to follow
- **1**: Completely unreadable

**Minimum**: 6/10 required

## Decision Rules

**APPROVE** if:
- Migration Clarity ≥8 (CRITICAL - this is a migration guide) AND
- Encouraging Tone ≥7 (CRITICAL - no gatekeeping allowed) AND
- Code Examples & Screenshots ≥7 (CRITICAL - visual guidance required) AND
- Skill Bridge Quality ≥6 AND
- Time & Effort Honesty ≥6 AND
- Structure & Scannability ≥6 AND
- SEO & Discoverability ≥6 AND
- Readability & AEO Structure ≥6 AND
- Total score ≥56/80

**REJECT** if:
- Migration Clarity <8 (non-negotiable)
- Encouraging Tone <7 (non-negotiable - gatekeeping is disqualifying)
- Code Examples & Screenshots <7 (non-negotiable - migration guides need visuals)
- ANY other score <6 OR
- Total score <56/80 OR
- Contains gatekeeping language OR
- Missing step-by-step instructions OR
- No troubleshooting section

## Level Up-Specific Quality Gates

**MUST HAVE** (auto-reject if missing):

✅ Step-by-step migration instructions (numbered, clear)
✅ Before/after comparison (UI screenshots or workflow diagram)
✅ At least 2 code examples or screenshots
✅ Prerequisite checklist (accounts, tools, what to have ready)
✅ Encouragement/celebration of vibe coding background
✅ No gatekeeping language ("real developers", "toy tools", etc.)
✅ Realistic time estimate (setup time, learning curve)
✅ Both tool names in title and meta description
✅ Troubleshooting section (3+ common issues with solutions)

**NICE TO HAVE** (boost score):

⭐ Video walkthrough or GIF demonstrations
⭐ Community resources (Discord, forums, docs)
⭐ Cost comparison (if relevant)
⭐ Performance comparison (speed, capabilities)
⭐ Links to official migration guides
⭐ Real user testimonials or case studies
⭐ "Common mistakes to avoid" section

## Voice Guidelines for Level Up

**DO use:**
- "You've been shipping fast with [vibe tool], and that skill translates"
- "You've already mastered [concept], now let's add [capability]"
- "Many successful developers started with vibe coding"
- "This preserves your velocity while giving you more control"
- "Your experience with [vibe feature] maps directly to [pro feature]"

**DON'T use:**
- "Now you'll learn real development" ❌
- "Time to graduate to professional tools" ❌
- "Finally coding properly" ❌
- "Real developers use [tool]" ❌
- "Vibe tools are just for beginners" ❌
- "Stop using toy tools" ❌
- "Leave amateur tools behind" ❌

## Examples of APPROVED Content

✅ Clear numbered steps from Lovable export to Cursor setup
✅ Side-by-side screenshots: Lovable UI → Cursor workflow
✅ "What You Already Know" section mapping React concepts
✅ Encouraging intro: "You've mastered rapid prototyping in Lovable"
✅ Realistic: "Setup takes 2 hours, productive by day 2"
✅ Troubleshooting: 5 common issues with solutions
✅ Both tool names in title and SEO metadata

## Examples of REJECTED Content

❌ Vague "just migrate your code" without steps
❌ No screenshots or visual comparisons
❌ Gatekeeping: "Time to learn how professionals code"
❌ Dismissive: "Vibe tools are limited, real tools are unlimited"
❌ No troubleshooting section
❌ Unrealistic: "Migrate in 5 minutes"
❌ Missing prerequisites or verification steps
❌ No skill bridge - assumes starting from zero

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

If APPROVED:
```json
{
  "approved": true,
  "quality_score": 60,
  "migration_clarity_score": 9,
  "encouraging_tone_score": 8,
  "code_examples_screenshots_score": 8,
  "skill_bridge_quality_score": 7,
  "time_effort_honesty_score": 7,
  "structure_scannability_score": 7,
  "seo_discoverability_score": 6,
  "readability_score": 8,
  "strengths": [
    "Excellent step-by-step migration guide with 15 numbered steps",
    "Highly encouraging tone - celebrates Lovable experience, zero gatekeeping",
    "Strong visual guidance - 4 side-by-side screenshots showing workflow",
    "Clear skill bridge section mapping Lovable components to Cursor files",
    "Realistic time estimates - '2-hour setup, productive within a day'",
    "Comprehensive troubleshooting with 5 common issues and solutions",
    "Good use of comparison tables and answer capsules for AI extraction"
  ],
  "weaknesses": [
    "Could include video walkthrough or animated GIFs",
    "SEO could be stronger with more migration-focused keywords in headings"
  ],
  "requires_revision": false
}
```

If REJECTED:
```json
{
  "approved": false,
  "quality_score": 41,
  "migration_clarity_score": 5,
  "encouraging_tone_score": 4,
  "code_examples_screenshots_score": 6,
  "skill_bridge_quality_score": 5,
  "time_effort_honesty_score": 6,
  "structure_scannability_score": 6,
  "seo_discoverability_score": 4,
  "readability_score": 5,
  "strengths": [
    "Decent code examples provided",
    "Good structure with clear sections"
  ],
  "weaknesses": [
    "Migration clarity too low (5/10) - steps are vague, missing verification",
    "Encouraging tone too low (4/10) - contains dismissive language ('time to graduate', 'finally learn proper coding')",
    "No before/after comparison or visual workflow guide",
    "Missing prerequisite checklist",
    "No troubleshooting section",
    "Gatekeeping language present - violates Level Up tone requirements",
    "Doesn't celebrate vibe coding experience",
    "No clear skill bridge showing what transfers",
    "Missing answer capsules and comparison tables for AI extraction"
  ],
  "requires_revision": true,
  "revision_suggestions": [
    "Remove ALL gatekeeping language - replace 'time to graduate' with 'level up your capabilities'",
    "Add numbered step-by-step migration guide (at least 10-15 steps)",
    "Include side-by-side screenshots: Lovable UI → Cursor workflow",
    "Add 'Before You Start' section with prerequisite checklist",
    "Add 'What You Already Know' section mapping Lovable concepts to Cursor",
    "Add troubleshooting section with 3-5 common issues and solutions",
    "Add realistic time estimate ('weekend project', '2-hour setup', etc.)",
    "Start with encouraging intro celebrating their Lovable experience",
    "Add verification steps ('How to confirm migration succeeded')",
    "Improve SEO - put both tool names in title and main headings"
  ]
}
```

Begin evaluation. Return ONLY the JSON object:
