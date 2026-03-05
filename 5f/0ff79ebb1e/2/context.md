# Session Context

## User Prompts

### Prompt 1

# Create Plan

A thin wrapper that invokes the `desplega:planning` skill with autonomy controls.

## When Invoked

1. **Parse autonomy mode from arguments:**
   - Check for `--autonomy=autopilot|critical|verbose` flag
   - If provided file has `autonomy:` in frontmatter, use that as default
   - Otherwise, ask the user via AskUserQuestion:

   ```
   How much should I check in with you during planning?
   - Autopilot: Research and create plan independently, present for final review
   - Criti...

### Prompt 2

you did it so fast... can you check in the planning skill the subagenbts you need to use and ensure you spawn paralel agents to do the work and check specifics? the plan should be crystal clear on what needs to be implemented (check previous plans as exampleS)

### Prompt 3

# File Review

Launch the file-review tool to add inline review comments to a markdown file.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--bg` | Run in background mode (don't wait for app to close) |
| `--silent` | Suppress comment output when app closes |
| `--json` | Output comments as JSON when app closes (default: human-readable) |

## Instructions

When the user invokes `/file-review [path]`:

### If no path provided

Check for recently created or modified files in th...

