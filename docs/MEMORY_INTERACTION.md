# Swarm Memory Interaction Guide

This guide documents how PR creators, reviewers, and external agents can interact with the swarm's memory layer during PR reviews.

## Overview

The swarm memory system allows agents to learn from interactions and remember preferences. Users can trigger memory operations using natural language phrases in PR comments or review threads.

## Memory Trigger Phrases

### Storing Preferences ("Remember This...")

Use these patterns when you want the swarm to remember something for future reviews:

| Trigger Pattern | What Gets Stored | Scope |
|-----------------|------------------|-------|
| `remember this: ...` | Explicit preference or rule | Per-repo |
| `remember that ...` | Convention or pattern | Per-repo |
| `for future reviews: ...` | Review preference | Per-repo |
| `always check for ...` | Focus area | Per-repo |
| `we use ... in this repo` | Code convention | Per-repo |
| `our convention is ...` | Style rule | Per-repo |
| `this is intentional because ...` | Design decision | Per-PR |

#### Examples

```markdown
@swarm-bot remember this: We use 2-space indentation in this repo

@swarm-bot remember that error messages should be in English only

@swarm-bot for future reviews: Always check for SQL injection in user input handlers

@swarm-bot we use PascalCase for React components in this repo

@swarm-bot this is intentional because we're maintaining backwards compatibility
```

### Dismissing Feedback ("I Don't Care About...")

Use these patterns when you want to suppress certain types of feedback:

| Trigger Pattern | Effect | Scope |
|-----------------|--------|-------|
| `i don't care about ...` | Lower confidence for this issue type | Per-repo |
| `ignore ... issues` | Filter out this category | Per-repo |
| `don't flag ...` | Suppress these warnings | Per-repo |
| `skip ... checks` | Disable specific check | Per-repo |
| `this is fine because ...` | Mark as accepted | Per-PR |
| `won't fix: ...` | Mark as won't fix | Per-PR |
| `not applicable here` | Dismiss current issue | Per-thread |

#### Examples

```markdown
@swarm-bot i don't care about trailing whitespace in markdown files

@swarm-bot ignore nit-level style issues in test files

@swarm-bot don't flag console.log statements in development scripts

@swarm-bot this is fine because the null check happens in the caller

@swarm-bot won't fix: we prefer this pattern for readability
```

### Adjusting Sensitivity

| Trigger Pattern | Effect |
|-----------------|--------|
| `be stricter about ...` | Increase confidence threshold |
| `be more lenient with ...` | Decrease confidence threshold |
| `focus more on ...` | Prioritize this category |
| `focus less on ...` | Deprioritize this category |

#### Examples

```markdown
@swarm-bot be stricter about security issues in API handlers

@swarm-bot be more lenient with TypeScript type annotations in test files

@swarm-bot focus more on performance in database queries
```

## Best Practices

### 1. Be Specific

**Good:**
```markdown
@swarm-bot remember this: All API endpoints must validate request body with Zod schemas
```

**Less Effective:**
```markdown
@swarm-bot remember to validate stuff
```

### 2. Provide Context

**Good:**
```markdown
@swarm-bot this is intentional because we're using a factory pattern
here that requires the intermediate type casting
```

**Less Effective:**
```markdown
@swarm-bot this is fine
```

### 3. Scope Appropriately

- Use **per-repo** preferences for coding standards that apply everywhere
- Use **per-PR** preferences for exceptions specific to the current change
- Use **per-thread** responses for individual review comments

### 4. Update When Things Change

```markdown
@swarm-bot forget: the rule about 2-space indentation - we're moving to 4-space

@swarm-bot update preference: error messages can now be localized
```

## How Memory Affects Reviews

### Before Review Starts

1. Agent loads repo-specific memory (conventions, preferences, CLAUDE.md rules)
2. Agent applies stored sensitivity adjustments
3. Agent filters issue types marked as "don't care"

### During Review

1. Issues are scored against remembered patterns
2. Previously dismissed issue types get lower confidence
3. Areas marked as "focus more" get extra attention

### After Review

1. Your responses update the memory:
   - Accepted issues: Reinforce the pattern
   - Dismissed issues: Lower future confidence for similar
   - "Remember this" commands: Store new preferences

## Memory Types

| Type | Description | Lifetime |
|------|-------------|----------|
| **Episodic** | Specific events (PR #42 had auth issue) | Months |
| **Semantic** | Facts and rules (uses 2-space indent) | Permanent until updated |
| **Procedural** | Patterns and skills (how to review auth code) | Permanent, improved over time |

## Viewing and Managing Memory

### Check What's Remembered

```markdown
@swarm-bot what do you remember about this repo?

@swarm-bot list my preferences
```

### Clear Memory

```markdown
@swarm-bot forget all preferences for this repo

@swarm-bot reset confidence thresholds
```

## Integration with CLAUDE.md

The memory layer complements your repository's `CLAUDE.md` file:

- **CLAUDE.md**: Static rules committed to repo
- **Memory Layer**: Dynamic preferences learned from interactions

Memory preferences can augment but not override CLAUDE.md rules. For permanent changes, update CLAUDE.md directly.

## Feedback Loop

The memory system learns from outcomes:

1. When you accept a review suggestion → Reinforces the pattern
2. When you dismiss with explanation → Records as potential false positive
3. When you say "remember this" → Creates explicit preference
4. When you say "don't care" → Lowers future confidence

Over time, the swarm becomes more aligned with your team's standards and preferences.

## Example Workflow

### First Review of a New Repo

```markdown
# Reviewer catches something that's actually intentional
@reviewer: This function is too long (45 lines)

# PR author provides context
@author: @swarm-bot this is fine because it's a state machine
that's clearer as one function - remember that state machines
can be longer than our usual 30-line limit
```

### Subsequent Reviews

The swarm now knows:
- State machines can exceed normal length limits
- Won't flag length issues in files with "state machine" patterns

### Adjusting Later

```markdown
# If the rule was too broad
@author: @swarm-bot be stricter about function length - only
state machines in the /machines/ directory should be exempt
```

## Troubleshooting

### Memory Not Working?

1. Make sure you're addressing the swarm bot directly (`@swarm-bot` or `@desplega-bot`)
2. Check that the trigger phrase is at the start of a sentence
3. Verify the preference scope matches your intent

### Unexpected Behavior?

```markdown
@swarm-bot explain why you flagged this issue

@swarm-bot what preferences apply to this file?
```

### Need to Reset?

```markdown
@swarm-bot reset preferences for auth/ directory

@swarm-bot forget the "ignore trailing whitespace" rule
```

---

## Quick Reference Card

### Store Preference
```
remember this: [rule]
remember that [convention]
we use [pattern] in this repo
```

### Dismiss Feedback
```
i don't care about [issue type]
ignore [category] issues
this is fine because [reason]
```

### Adjust Sensitivity
```
be stricter about [area]
be more lenient with [area]
focus more on [category]
```

### Query Memory
```
what do you remember about this repo?
explain why you flagged this
```

### Manage Memory
```
forget [preference]
reset [category] preferences
```
