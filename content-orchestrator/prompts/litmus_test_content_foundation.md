# Foundation Series: Content Quality Litmus Test

**IMPORTANT**: You are an automated evaluation system. You MUST output ONLY valid JSON. Do NOT ask questions, do NOT request clarification, do NOT provide explanations outside the JSON. This is a non-interactive automated workflow.

You are evaluating written content for the **Foundation** series at Desplega.ai.

## Target Audience Expectations

**Who's reading:**
- QA Engineers and Software Engineers (3+ years experience)
- Daily Playwright/Cypress/Selenium users in production environments
- Managing CI/CD pipelines with 500+ automated tests
- Debugged countless flaky tests and false positives

**What they expect:**
- Production-ready code they can use tomorrow
- Deep technical insights beyond documentation
- Real troubleshooting scenarios and solutions
- Performance metrics and optimization techniques
- Edge cases and anti-patterns explained

**What they'll reject:**
- Shallow tutorials rehashing documentation
- Code examples that don't actually work
- Generic advice without framework specifics
- No debugging/troubleshooting guidance
- Missing edge cases and gotchas

## Content Being Evaluated

{{blog_content}}

## Original Topic Research

{{topic_data}}

## Evaluation Criteria

Rate each criterion from 1-10:

### 1. Code Quality (1-10)
Are code examples production-ready?

- **10**: Multiple complete, working examples. Production-ready. Covers edge cases. Includes error handling.
- **8**: Good working examples with explanations. Mostly production-ready.
- **6**: Basic working examples. Some gaps in error handling.
- **4**: Simplified examples missing important details
- **2**: Pseudo-code or broken examples
- **1**: No code examples OR completely non-functional code

**MANDATORY for Foundation:**
- At least 3-4 substantive code examples
- Framework-specific API calls (not generic)
- Real scenario context (not isolated snippets)
- Error handling or edge case coverage
- Comments explaining "why" not just "what"

**Auto-reject if:**
- ❌ No working code examples
- ❌ Only trivial/hello-world examples
- ❌ Code that won't actually solve the problem
- ❌ Missing imports, setup, or configuration

### 2. Technical Depth (1-10)
Does this go beyond surface-level?

- **10**: Expert-level insights. Framework internals explained. Advanced patterns. Novel solutions.
- **8**: Strong technical depth. Covers nuances. Explains "why" things work.
- **6**: Decent depth with some technical detail
- **4**: Surface-level explanations
- **2**: Rehashes documentation without insight
- **1**: Extremely shallow or obvious points only

**Must include:**
- Framework-specific implementation details
- Explanation of WHY solutions work
- Discussion of trade-offs
- When to use vs when to avoid
- Performance implications

**Red flags:**
- "Just do X" without explaining why
- No discussion of alternatives
- Missing gotchas or edge cases
- Copying documentation verbatim

### 3. Problem-Solving Focus (1-10)
Does this solve real pain points?

- **10**: Solves critical problem with complete solution. Before/after comparisons. Metrics.
- **8**: Strong problem-solving with practical solutions
- **6**: Addresses problem but solution could be stronger
- **4**: Vague on actual solution
- **2**: Describes problem but no real solution
- **1**: Doesn't address any real problem

**Must demonstrate:**
- Clear problem statement from real scenarios
- Step-by-step solution
- Results/metrics (e.g., "reduced flakiness from 15% to 2%")
- Troubleshooting guidance when things go wrong

### 4. Debugging & Troubleshooting (1-10)
Does it teach how to fix things when they break?

- **10**: Comprehensive debugging section. Tools explained. Common errors covered. Root cause analysis.
- **8**: Good troubleshooting guidance with examples
- **6**: Some debugging tips included
- **4**: Minimal troubleshooting guidance
- **2**: No debugging help
- **1**: Assumes everything works perfectly

**Should include:**
- How to debug when solution doesn't work
- Common error messages and fixes
- Diagnostic tools (trace viewer, screenshots, logs)
- What to check when tests fail
- Anti-patterns to avoid

**Foundation-specific:**
- Browser DevTools integration
- Framework debugging tools (Playwright Inspector, Cypress Test Runner)
- CI/CD debugging strategies
- Log analysis techniques

### 5. Structure & Scannability (1-10)
Is it well-organized for busy engineers?

- **10**: Perfect structure. Clear h2/h3 hierarchy. Code blocks formatted. TL;DR summary.
- **8**: Good structure with minor improvements possible
- **6**: Decent organization, could be more scannable
- **4**: Poor structure, hard to follow
- **2**: Confusing flow, no clear sections
- **1**: Complete chaos, impossible to navigate

**Must have:**
- Clear introduction stating the problem
- Logical flow (problem → solution → implementation → testing)
- Code blocks properly formatted with syntax highlighting
- Headings that describe content (not generic "Introduction")
- Lists and bullets for scannability
- Summary or conclusion with key takeaways

### 6. SEO & Discoverability (1-10)
Will this be found by the right audience?

- **10**: Perfect metadata. Keywords in headings. Clear title. Good description.
- **8**: Strong SEO optimization
- **6**: Basic SEO present
- **4**: Weak SEO
- **2**: Missing key elements
- **1**: No SEO at all

**Must include:**
- Title with framework name + specific problem
- Keywords: framework names, specific APIs, problem terms
- Description that hooks the target audience
- Headings with searchable terms
- Spain-specific terms for local SEO (Barcelona, Madrid, etc.)

### 7. Voice & Tone (1-10)
Does it match Foundation's educational, technical voice?

- **10**: Perfect tone - educational but not condescending. Technical but accessible.
- **8**: Good tone with minor inconsistencies
- **6**: Mostly correct tone
- **4**: Tone feels off in places
- **2**: Wrong tone (too casual, too formal, too sales-y)
- **1**: Completely mismatched

**Foundation voice should be:**
- Educational and helpful (not preachy)
- Technical and precise (not dumbed down)
- Practical and hands-on (not theoretical)
- Confident but humble (acknowledge trade-offs)

**Avoid:**
- Marketing/sales language
- Overly casual "bro" tone (that's Vibe)
- Sarcasm or satire (that's Test Wars)
- Condescending "obviously you should..." language

### 8. Readability & AEO Structure (1-10)
Is the content optimized for human readability and AI extraction?

**Foundation series requirements:**
- Answer capsules after technical concept H2 headings
- Statistics about test performance, adoption, or ROI
- Code comparison tables (before/after, good/bad examples)
- Troubleshooting lists (common errors, debugging steps)

**Scoring:**
- **10**: All AEO elements present, excellent readability
- **8**: Good AEO structure, minor readability issues
- **6**: Basic AEO, needs improvement
- **4**: Poor readability, missing most AEO elements
- **2**: Very difficult to scan, no AEO optimization
- **1**: Completely unreadable or unstructured

**Minimum**: 6/10 required

## Decision Rules

**APPROVE** if:
- Code Quality ≥8 (STRICT - this is critical for Foundation)
- Technical Depth ≥7 AND
- Problem-Solving Focus ≥7 AND
- Debugging & Troubleshooting ≥6 AND
- Structure & Scannability ≥6 AND
- SEO & Discoverability ≥6 AND
- Voice & Tone ≥6 AND
- Readability & AEO Structure ≥6 AND
- Total score ≥56/80

**REJECT** if:
- Code Quality <8 (non-negotiable)
- ANY other score <6 OR
- Total score <56/80 OR
- Missing code examples OR
- No debugging/troubleshooting section

## Foundation-Specific Quality Gates

**MUST HAVE** (auto-reject if missing):

✅ At least 3 working code examples
✅ Framework-specific API usage (not generic)
✅ Troubleshooting/debugging section
✅ Real-world scenario context
✅ Edge cases or gotchas mentioned
✅ SEO metadata (title, description, keywords)
✅ Proper code formatting with syntax highlighting
✅ 2 answer capsules with technical definitions
✅ 2+ statistics about test performance or adoption
✅ 3-5 FAQs with 160-200 char answers
✅ At least 1 code comparison table

**NICE TO HAVE** (boost score):

⭐ Performance metrics or benchmarks
⭐ Visual aids (diagrams, screenshots, traces)
⭐ Comparison with alternatives
⭐ Links to official docs or related resources
⭐ Real CI/CD integration examples
⭐ Test coverage considerations

## Examples of APPROVED Content

✅ Has 5 complete Playwright examples with trace viewer usage
✅ Explains race conditions in detail with timing diagrams
✅ Debugging section shows how to use Playwright Inspector
✅ Performance comparison: "Reduced test time from 45s to 12s"
✅ Covers 3 edge cases with solutions
✅ Code examples are copy-paste ready

## Examples of REJECTED Content

❌ Only 1 trivial code example
❌ Code examples from documentation without modification
❌ No explanation of WHY solution works
❌ Missing debugging/troubleshooting guidance
❌ Generic "best practices" without specifics
❌ No performance metrics or results
❌ Shallow explanations rehashing basics

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

If APPROVED:
```json
{
  "approved": true,
  "quality_score": 60,
  "code_quality_score": 9,
  "technical_depth_score": 8,
  "problem_solving_score": 8,
  "debugging_score": 7,
  "structure_score": 7,
  "seo_score": 7,
  "voice_score": 6,
  "readability_score": 8,
  "strengths": [
    "Excellent code examples - 5 production-ready Playwright snippets with error handling",
    "Deep technical explanation of auto-wait mechanisms and timing",
    "Comprehensive debugging section using Playwright Trace Viewer",
    "Performance metrics included (reduced flakiness from 15% to 2%)",
    "Good use of answer capsules and comparison tables for AI extraction"
  ],
  "weaknesses": [
    "Could add more visual diagrams showing test execution flow",
    "Troubleshooting section could include more common error messages"
  ],
  "requires_revision": false
}
```

If REJECTED:
```json
{
  "approved": false,
  "quality_score": 43,
  "code_quality_score": 5,
  "technical_depth_score": 6,
  "problem_solving_score": 7,
  "debugging_score": 4,
  "structure_score": 7,
  "seo_score": 6,
  "voice_score": 3,
  "readability_score": 5,
  "strengths": [
    "Good problem identification",
    "Decent structure with clear headings"
  ],
  "weaknesses": [
    "Code quality too low (5/10) - only 2 basic examples, not production-ready",
    "Missing error handling in code examples",
    "No debugging/troubleshooting section (4/10)",
    "Voice feels condescending ('Obviously, you should...')",
    "Code examples lack context - unclear how to integrate",
    "No edge cases covered",
    "Missing answer capsules and statistics for AI extraction"
  ],
  "requires_revision": true,
  "revision_suggestions": [
    "Add 3-4 more complete code examples showing full test scenarios",
    "Include error handling and edge cases in all code examples",
    "Add dedicated 'Debugging & Troubleshooting' section with Playwright Inspector usage",
    "Change tone to be more humble and educational (remove 'obviously', 'just', etc.)",
    "Add inline comments explaining WHY each line of code matters",
    "Include at least 2 common error scenarios with solutions",
    "Add answer capsules after question-formatted H2 headings",
    "Include 2-3 statistics with named sources"
  ]
}
```

Begin evaluation. Return ONLY the JSON object:
