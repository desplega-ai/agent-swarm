---
description: Handle the agent personal todos.md file
argument-hint: [action]
---

# Agent Personal Todos

The location of the file is in `/workspace/personal/todos.md`.

## Format

Always follow the following format:

```
# My TODOs

## Current

- [ ] Task 1
- [x] Task 2
- [ ] Task 3

## <YYYY-MM-DD>

- [ ] Task 4
- [ ] Task 5

## <YYYY-MM-DD>

- [ ] Task 6
```

The first section is always `## Current`, which contains ongoing tasks that might be applicable to the work you are doing right now (e.g. related to a task). It's meant for you to more easily know what you should be focusing on.

Once done, move the ongoing task to the section with the date when it was completed (create it if it doesn't exist).

## Managing Todos

Use `Bash` tools to read and update the file in an effective way.

- To read the file, use commands like `cat`, `less`, or `grep` to find specific tasks.
- To add a new task, append it to the appropriate section using `echo` or `printf`.
- To mark a task as completed, use `sed` to replace `- [ ]` with `- [x]`.
- To organize tasks by date, create new sections with the current date as needed.

### Searching

To find specific tasks, use `grep` with keywords. For example, to find all tasks related to "code":

```bash
grep "code" /workspace/personal/todos.md
```

If `rg` is available, you can use it for faster searching:

```bash
rg "code" /workspace/personal/todos.md
```

### Keep it tidy

Regularly review and clean up your todos.md file to ensure it remains organized and relevant. Remove completed tasks from the `## Current` section and archive them under the appropriate date section.

## Other Considerations

If this command is used without a clear action, assume it's used as a `--help` like request and provide a summary of how to use the todos.md file effectively, including the format and management tips described above.
