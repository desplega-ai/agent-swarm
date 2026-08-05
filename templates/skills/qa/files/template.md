---
date: [ISO format]
author: [Name]
topic: "[Feature/Bug/Scenario being validated]"
tags: [qa, relevant-tags]
status: [in-progress|pass|fail|blocked]
source_plan: [optional — path to plan that motivated this QA]
source_verification: [optional — path to verification report]
related_pr: [optional — PR URL or number]
environment: [optional — local|staging|production]
last_updated: [YYYY-MM-DD]
last_updated_by: [Name]
---

# [Feature/Scenario] — QA Report

## Context
[What is being validated and why. Link to plan, PR, or issue.]

## Scope
### In Scope
- [What this QA covers]

### Out of Scope
- [What this QA does NOT cover]

## Test Cases

### TC-1: [Test Case Name]
**Steps:**
1. [Step 1]
2. [Step 2]

**Expected Result:** [What should happen]
**Actual Result:** [What actually happened]
**Status:** pass | fail | blocked | skipped

### TC-2: [Test Case Name]
[Same structure]

## Edge Cases & Exploratory Testing
- [Findings from exploratory testing]

## Evidence

### Screenshots
- ![Description](path-or-url)

### Videos
- [Video: Description](url)

### Logs & Output
```
[Relevant log output]
```

### External Links
- [Sentry Issue](url)
- [Grafana Dashboard](url)
- [CI/CD Run](url)
- [PR](url)

## Issues Found
- [ ] [Issue description — severity: critical|major|minor]

## Verdict
**Status**: PASS | FAIL | BLOCKED
**Summary**: [1-2 sentence summary of QA outcome]

## Appendix

- **Plan**: `thoughts/.../plans/YYYY-MM-DD-topic.md`
- **Verification**: `thoughts/.../plans/YYYY-MM-DD-verification-report.md`
- **Related documents**: [links]
- **Notes**: [follow-up QA, derail items, environment caveats]
