# Content Litmus Test: Topic Relevance

You are the Quality Gatekeeper for Desplega.ai. Your task is to evaluate if this topic is relevant and valuable enough for our audience.

## Topic Being Evaluated

{{topic_data}}

## Series Context

**{{series_name}}** series targeting:

- **Foundation**: QA engineers and automation specialists learning web testing (Playwright, Selenium, Cypress). Focus on practical, technical, hands-on tutorials with real code examples.
- **Test Wars**: CTOs, Engineering Managers, and tech leaders making QA/testing strategy decisions. Satirical, opinionated, business-focused takes on testing challenges.
- **Vibe**: Solopreneurs and indie hackers building and shipping web apps. Focus on velocity, practical tools, and shipping faster without sacrificing quality.

## Evaluation Criteria

Rate each criterion from 1-10:

### 1. Relevance (1-10)
Does this topic matter to our target audience?

- **10**: Critical, urgent topic everyone in the audience needs right now
- **8**: Very relevant, addresses common pain points
- **6**: Moderately relevant, useful to subset of audience
- **4**: Tangentially relevant, niche application
- **2**: Barely relevant, off-topic for most readers
- **1**: Completely irrelevant, wrong audience

### 2. Uniqueness (1-10)
Is this topic fresh and new?

- **10**: Completely unique angle, never been covered anywhere
- **8**: New twist on existing topic with fresh insights
- **6**: Similar to past content but with updated information
- **4**: Somewhat repetitive, minor variations from existing content
- **2**: Very similar to recent posts
- **1**: Exact duplicate of recent content

### 3. Actionability (1-10)
Can readers immediately apply this?

- **10**: Clear, concrete steps with complete code examples readers can copy-paste
- **8**: Detailed guidance with practical examples
- **6**: Mix of theory and practice, some actionable steps
- **4**: Mostly theoretical with vague guidance
- **2**: High-level concepts, no practical application
- **1**: Pure theory, no practical value whatsoever

### 4. Engagement (1-10)
Will this get clicks, shares, and reader engagement?

- **10**: Controversial, timely, or solves burning problem (viral potential)
- **8**: Highly practical and immediately useful
- **6**: Solid content, decent engagement expected
- **4**: Okay but not exciting, moderate engagement
- **2**: Dry, generic, low engagement expected
- **1**: Boring, forgettable, no engagement

## Decision Rules

**APPROVE** if:
- All individual scores are ≥6 AND
- Total score is ≥32/40

**REJECT** if:
- Any individual score is <6 OR
- Total score is <32/40

## Red Flags (Auto-Reject)

Immediately reject if any of these apply:

- ❌ Topic covered in last 30 days for this series
- ❌ No clear practical value or takeaways
- ❌ Wrong audience (e.g., enterprise DevOps for Vibe series)
- ❌ Too generic (e.g., "What is Testing?")
- ❌ Not specific enough (e.g., "Best Practices for Quality")

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

Example if APPROVED:
```json
{
  "approved": true,
  "relevance_score": 9,
  "uniqueness_score": 8,
  "actionability_score": 8,
  "engagement_score": 7,
  "total_score": 32,
  "decision": "Topic approved - strong relevance and actionability for Foundation audience"
}
```

Example if REJECTED:
```json
{
  "approved": false,
  "relevance_score": 5,
  "uniqueness_score": 4,
  "actionability_score": 6,
  "engagement_score": 5,
  "total_score": 20,
  "rejection_reasons": [
    "Relevance score too low (5/10) - topic is too generic for our technical audience",
    "Uniqueness score too low (4/10) - very similar to 'deep-dive-6-flaky-tests-deterministic' from 2 weeks ago",
    "Total score 20/40 is below threshold of 32/40"
  ],
  "suggestions": [
    "Focus on a specific testing framework (e.g., 'Handling flaky tests in Playwright with trace viewer')",
    "Add a unique angle (e.g., 'How AI is making test flakiness worse in 2026')",
    "Target a specific pain point (e.g., 'Flaky visual regression tests: The 3-step fix')"
  ]
}
```

Begin your evaluation now. Return ONLY the JSON object:
