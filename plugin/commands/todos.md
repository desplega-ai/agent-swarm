---
description: Handle the agent personal todos.md file
argument-hint: [action]
---

# Agent Personal Todos

File location: `/workspace/personal/todos.md`

## Format

```
# My TODOs

## Current

- [ ] Task 1
- [x] Task 2
- [ ] Task 3

## <YYYY-MM-DD>

- [ ] Task 4
- [ ] Task 5
```

`## Current` contains ongoing tasks related to your active work — what you should be focusing on right now. Once done, move completed tasks to a section with the completion date (create it if it doesn't exist).

## Keep it tidy

Regularly review and clean up: remove completed tasks from `## Current` and archive them under the appropriate date section.

## Fallback

If this command is used without a clear action, provide a summary of how to use the todos.md file, including the format above.
