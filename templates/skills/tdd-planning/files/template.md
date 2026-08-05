# [Feature/Task Name] - TDD Implementation Plan

## Overview
[Brief description of what we're implementing and why]

## Test Infrastructure

| Aspect | Value |
|--------|-------|
| **Framework** | [Jest/pytest/Go testing/etc.] |
| **Test location** | [Where tests live] |
| **Test command** | `[command to run tests]` |
| **Coverage command** | `[command to check coverage, if applicable]` |

## Current State Analysis
[What exists now, what's missing, key constraints]

### Existing Test Patterns:
- [Pattern found in codebase with file:line reference]

## Desired End State
[Specification of the desired end state]

### Test Coverage Goals:
- [ ] [Specific behavior that should be tested]
- [ ] [Another behavior]

## Quick Reference

**TDD Commands:**
```bash
# Run tests
[test command]

# Run specific test file
[specific test command]

# Commit after GREEN
git add -A && git commit -m "[message]"

# Rollback if stuck
git checkout .
```

## What We're NOT Doing
[Explicitly list out-of-scope items]

---

## Feature 1: [Feature Name]

### QA Spec (optional):

**Approach:** browser-automation | manual | cli-verification
**Test Scenarios:**
- [ ] TC-1: [Scenario name]
  - Steps: [1. Navigate to X, 2. Click Y, 3. Verify Z]
  - Expected: [What should happen]

### Cycle 1.1: [Simplest behavior - happy path]

#### RED Phase
**Test to write:**
```[language]
describe('[Component/Function]', () => {
  it('should [expected behavior]', () => {
    // Arrange
    const input = [test input];

    // Act
    const result = [function call];

    // Assert
    expect(result).toBe([expected output]);
  });
});
```

**Expected failure:**
```
[Function/Component] is not defined
// or
Expected: [expected]
Received: undefined
```

**Verify RED:** `[test command]` should fail with the above message

#### GREEN Phase
**Implementation approach:**
[Describe the minimal code needed - just enough to pass]

**Files to modify:**
- `path/to/implementation.ext`: Create/add [minimal implementation]
- `path/to/index.ext`: Export if needed

**Verify GREEN:** `[test command]` should pass

#### COMMIT/ROLLBACK
**If GREEN:**
```bash
git add -A && git commit -m "feat([scope]): [description of behavior added]"
```

**If STUCK:**
```bash
git checkout .  # Reset to last commit
# Then reassess: Is the test too big? Does the design need rethinking?
```

---

### Cycle 1.2: [Next behavior - edge case or validation]

#### RED Phase
**Test to write:**
```[language]
it('should [handle edge case]', () => {
  // Arrange
  const input = [edge case input];

  // Act
  const result = [function call];

  // Assert
  expect(result).toBe([expected for edge case]);
});
```

**Expected failure:**
```
Expected: [expected edge case result]
Received: [current behavior]
```

**Verify RED:** `[test command]` should fail

#### GREEN Phase
**Implementation approach:**
[Minimal change to handle this case]

**Files to modify:**
- `path/to/implementation.ext`: Add [specific logic]

**Verify GREEN:** `[test command]` should pass (all tests, not just new one)

#### COMMIT/ROLLBACK
**If GREEN:**
```bash
git add -A && git commit -m "feat([scope]): handle [edge case]"
```

**If STUCK:**
```bash
git checkout .
```

---

### Cycle 1.3: [Error handling]

#### RED Phase
**Test to write:**
```[language]
it('should throw/return error when [invalid condition]', () => {
  // Arrange
  const invalidInput = [invalid input];

  // Act & Assert
  expect(() => [function call]).toThrow('[error message]');
  // or for async:
  // await expect([async call]).rejects.toThrow('[error message]');
});
```

**Expected failure:**
```
Expected: [Error: error message]
Received: [current behavior - probably no error]
```

**Verify RED:** `[test command]` should fail

#### GREEN Phase
**Implementation approach:**
Add validation/error handling for [condition]

**Files to modify:**
- `path/to/implementation.ext`: Add validation at [location]

**Verify GREEN:** `[test command]` should pass

#### COMMIT/ROLLBACK
**If GREEN:**
```bash
git add -A && git commit -m "feat([scope]): add validation for [condition]"
```

**If STUCK:**
```bash
git checkout .
```

---

## Feature 2: [Next Feature Name]

### Cycle 2.1: [First behavior of feature 2]

[Same RED → GREEN → COMMIT/ROLLBACK structure]

---

## Integration Verification

After all cycles complete:

### Automated Verification:
- [ ] All tests pass: `[test command]`
- [ ] No linting errors: `[lint command]`
- [ ] Type checks pass: `[type check command, if applicable]`
- [ ] Coverage meets threshold: `[coverage command]`

### Manual Verification:
- [ ] [End-to-end behavior works as expected]
- [ ] [No regressions in related functionality]

---

## Rollback Recovery Guide

If you need to rollback during implementation:

1. **Check current state:** `git status` and `git diff`
2. **Rollback uncommitted changes:** `git checkout .`
3. **If you need to go back further:** `git log --oneline` to find last good commit
4. **Reset to good state:** `git reset --hard [commit-sha]`

**After rollback, ask:**
- Was the test too ambitious? Break it into smaller tests.
- Is there a design issue? Consider refactoring existing code first (with its own TDD cycles).
- Is the requirement unclear? Clarify before continuing.

---

## References
- Related research: `thoughts/<username|shared>/research/[relevant].md`
- Test framework docs: [link if relevant]
