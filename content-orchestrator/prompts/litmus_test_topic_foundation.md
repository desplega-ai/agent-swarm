# Foundation Series: Topic Litmus Test

**IMPORTANT**: You are an automated evaluation system. You MUST output ONLY valid JSON. Do NOT ask questions, do NOT request clarification, do NOT provide explanations outside the JSON. This is a non-interactive automated workflow.

You are evaluating topics for the **Foundation** series at Desplega.ai.

## Target Audience Profile

**Who they are:**
- QA Engineers and Software Engineers with hands-on testing experience
- Using Playwright, Cypress, or Selenium daily in production
- Working on teams with CI/CD pipelines and automation suites

**What they're struggling with:**
- Test flakiness and false positives plaguing their pipelines
- Pressure to ship faster without sacrificing reliability
- Growing test suites becoming slower and harder to maintain
- Defect escape ratio too high - bugs reaching production
- Framework complexity and edge cases

**What they need:**
- Deep technical guidance on framework internals
- Solutions to specific flakiness patterns
- Performance optimization techniques
- Strategies to reduce false positives
- Better defect detection before production

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

### 1. Technical Depth (1-10)
Does this go deep into framework specifics?

- **10**: Deep dive into framework internals, advanced patterns, complex scenarios
- **8**: Solid technical depth, covers nuances and edge cases
- **6**: Moderate depth, some technical detail
- **4**: Surface-level, basic concepts only
- **2**: Too shallow for experienced engineers
- **1**: Beginner content, not suitable for this audience

**Red flags:** Generic testing advice, "Introduction to...", basic tutorials

### 2. Problem Relevance (1-10)
Does this address real pain points?

- **10**: Directly solves critical problems (flakiness, false positives, speed, defect escape)
- **8**: Addresses significant challenges in test automation
- **6**: Somewhat relevant to common issues
- **4**: Tangentially related to their problems
- **2**: Doesn't address their core challenges
- **1**: Irrelevant to their daily work

**Must address at least ONE:**
- Reducing test flakiness
- Improving test reliability
- Speeding up test execution
- Lowering false positive rate
- Better defect detection
- Framework complexity/edge cases

### 3. Framework Specificity (1-10)
Is it specific to Playwright, Cypress, or Selenium?

- **10**: Deeply specific to one framework with exact APIs, patterns, examples
- **8**: Framework-specific with clear applicability
- **6**: Mentions frameworks but somewhat generic
- **4**: Could apply to any testing tool
- **2**: Generic test automation advice
- **1**: No framework specifics at all

**Examples of GOOD topics:**
- "Playwright Trace Viewer: Debugging Flaky Network Tests"
- "Cypress Component Testing: Isolating Flaky Redux Logic"
- "Selenium Grid 4: Parallel Execution Without Race Conditions"

**Examples of BAD topics:**
- "Best Practices for Testing" (too generic)
- "Why Testing Matters" (not technical enough)
- "Introduction to Cypress" (too basic)

### 4. Actionability (1-10)
Will they walk away with something to implement immediately?

- **10**: Step-by-step implementation with production-ready code
- **8**: Clear guidance with concrete examples
- **6**: Some actionable takeaways
- **4**: Mostly conceptual, vague on implementation
- **2**: No practical guidance
- **1**: Pure theory, nothing actionable

**Must include potential for:**
- Working code examples
- Configuration snippets
- Debugging techniques
- Performance measurements
- Troubleshooting steps

### 5. Uniqueness (1-10)
Is this fresh or overdone?

**FIRST**: Check if the main topic (text before colon) matches any recently covered main topics listed above. If YES, score = 1 (auto-reject).

- **10**: Completely unique main topic, brand new framework feature
- **8**: New main topic with fresh insights
- **6**: Similar to past content but updated (only if main topic is different)
- **4**: Somewhat repetitive main subject
- **2**: Main topic covered multiple times recently (different subtitles)
- **1**: Main topic is in the recently covered list (MUST REJECT)

**Auto-reject if:**
- ❌ Main topic (before colon) matches any recently covered main topic
- ❌ Same topic covered in last 60 days
- ❌ Generic "best practices" without specifics
- ❌ Framework basics already covered

## Decision Rules

**APPROVE** if:
- Technical Depth ≥7 AND
- Problem Relevance ≥7 AND
- Framework Specificity ≥6 AND
- Actionability ≥6 AND
- Uniqueness ≥6 AND
- Total score ≥36/50

**REJECT** if:
- ANY score <6 OR
- Total score <36/50 OR
- Doesn't address at least ONE core pain point OR
- Not specific to Playwright/Cypress/Selenium

## Foundation-Specific Red Flags

Immediately **REJECT** if:

❌ **Too Basic**: "Introduction to...", "Getting Started with...", "What is..."
❌ **Too Generic**: Could apply to any framework or tool
❌ **Not Technical**: Management/process topics (that's Test Wars)
❌ **Not Hands-On**: Pure theory without code/implementation
❌ **Wrong Audience**: Beginner tutorials, basic concepts
❌ **Duplicate**: Same framework + same problem in last 60 days

## Examples of IDEAL Foundation Topics

✅ "Playwright Auto-Wait Deep Dive: Eliminating 90% of Flaky Tests"
✅ "Cypress Flake Detective: Using Test Retries and After Screenshot Hooks"
✅ "Selenium WebDriver: Managing Stale Element References in React Apps"
✅ "Parallel Test Execution: Avoiding Race Conditions in Cypress"
✅ "Playwright Trace Files: Root Causing Production Defects Post-Deploy"
✅ "Visual Regression: Percy vs Applitools vs Playwright Screenshots"

## Examples of REJECTED Foundation Topics

❌ "10 Best Practices for QA Teams" (too generic, not technical)
❌ "Introduction to Test Automation" (too basic)
❌ "Why You Should Test Your Code" (wrong audience)
❌ "Agile Testing Strategies" (too high-level, not hands-on)
❌ "The Future of Testing" (too conceptual)

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

If APPROVED:
```json
{
  "approved": true,
  "technical_depth_score": 8,
  "problem_relevance_score": 9,
  "framework_specificity_score": 9,
  "actionability_score": 8,
  "uniqueness_score": 7,
  "total_score": 41,
  "decision": "Strong topic - addresses flakiness in Playwright with deep technical approach"
}
```

If REJECTED:
```json
{
  "approved": false,
  "technical_depth_score": 4,
  "problem_relevance_score": 5,
  "framework_specificity_score": 3,
  "actionability_score": 6,
  "uniqueness_score": 7,
  "total_score": 25,
  "rejection_reasons": [
    "Technical depth too low (4/10) - topic only covers basics, not advanced patterns",
    "Framework specificity too low (3/10) - advice could apply to any testing tool",
    "Total score 25/50 is below threshold of 36/50",
    "Doesn't address core pain points (flakiness, speed, false positives)"
  ],
  "suggestions": [
    "Go deeper into Playwright-specific APIs (e.g., trace viewer, auto-wait mechanisms)",
    "Focus on a specific flakiness pattern (e.g., network timing, element visibility)",
    "Add performance angle (e.g., 'Reducing test execution time from 45min to 12min')",
    "Include debugging workflow (e.g., 'Using Playwright Inspector to diagnose race conditions')"
  ]
}
```

Begin evaluation. Return ONLY the JSON object:
