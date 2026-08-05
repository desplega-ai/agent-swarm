# WTS Command Reference

Complete documentation for all `@desplega.ai/wts` commands.

## wts init

Initialize WTS for the current project.

```bash
wts init        # Interactive setup
wts init -y     # Use defaults, skip prompts
```

**What it does:**
- Creates global config entry at `~/.wts.json`
- Optionally creates `.wts-config.json` for project-specific settings
- Registers the project for worktree management

**Options:**
| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip prompts, use defaults |

---

## wts create

Create a new worktree.

```bash
wts create <alias>                    # Interactive branch selection (fzf)
wts create <alias> -n                 # Create new branch named <alias>
wts create <alias> -b <branch>        # Use existing branch
wts create <alias> --base develop     # Base new branch on 'develop'
wts create <alias> --tmux             # Open in tmux window
wts create <alias> --tmux --claude    # Open in tmux + launch Claude Code
```

**Options:**
| Flag | Description |
|------|-------------|
| `-n, --new-branch` | Create a new branch with the alias name |
| `-b, --branch <name>` | Use an existing branch |
| `--base <branch>` | Base new branch on specified branch (default: current branch) |
| `--tmux` | Open worktree in a new tmux window |
| `--claude` | Launch Claude Code in the worktree (requires --tmux) |

**Worktree Location:**
`.worktrees/<project>/YYYY-MM-DD-<alias>/`

---

## wts list

List worktrees.

```bash
wts list        # Current project only
wts list -a     # All tracked projects
wts list --json # JSON output
```

**Options:**
| Flag | Description |
|------|-------------|
| `-a, --all` | Show worktrees from all tracked projects |
| `--json` | Output as JSON |

---

## wts switch

Switch to a worktree.

```bash
wts switch              # Interactive fzf picker
wts switch <alias>      # Switch directly to alias
wts switch --tmux       # Open in new tmux window
```

**Options:**
| Flag | Description |
|------|-------------|
| `--tmux` | Open in a new tmux window instead of cd |

---

## wts delete

Delete a worktree.

```bash
wts delete <alias>      # Delete with confirmation
wts delete <alias> -f   # Force delete (skip confirmation)
```

**Options:**
| Flag | Description |
|------|-------------|
| `-f, --force` | Force delete even with uncommitted changes |

---

## wts pr

Create a GitHub Pull Request from a worktree.

```bash
wts pr                          # Auto-detect from current worktree
wts pr <alias>                  # Specify worktree
wts pr --draft                  # Create as draft PR
wts pr --web                    # Open in browser after creation
wts pr -t "Title" -b "Body"     # Set title and body
```

**Options:**
| Flag | Description |
|------|-------------|
| `--draft` | Create as draft PR |
| `--web` | Open PR in browser after creation |
| `-t, --title <title>` | PR title |
| `-b, --body <body>` | PR description |
| `--base <branch>` | Target branch (default: main/master) |

**Requirements:**
- `gh` CLI must be installed and authenticated
- Branch must be pushed to remote

---

## wts cleanup

Clean up worktrees.

```bash
wts cleanup                 # Interactive cleanup of merged worktrees
wts cleanup --dry-run       # Show what would be removed
wts cleanup -f              # Force, no confirmation
wts cleanup --older-than 30 # Include worktrees older than 30 days
wts cleanup --unmerged      # Include unmerged worktrees
```

**Options:**
| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be removed without removing |
| `-f, --force` | Skip confirmation prompts |
| `--older-than <days>` | Include worktrees older than N days |
| `--unmerged` | Include unmerged worktrees (dangerous) |

---

## Configuration Files

### Global: `~/.wts.json`

```json
{
  "projects": [
    {
      "path": "/path/to/project",
      "name": "my-project"
    }
  ],
  "defaults": {
    "worktreeDir": ".worktrees",
    "tmuxWindowTemplate": "{project}-{alias}",
    "autoTmux": false,
    "autoClaude": false
  }
}
```

### Project: `.wts-config.json`

```json
{
  "worktreeDir": ".worktrees",
  "tmuxWindowTemplate": "{project}-{alias}",
  "autoTmux": true,
  "autoClaude": true,
  "setupScript": "./scripts/setup-worktree.sh"
}
```

**Setup Script Environment Variables:**
- `$WTS_WORKTREE_PATH` - Path to the new worktree
- `$WTS_ALIAS` - Worktree alias
- `$WTS_BRANCH` - Branch name

---

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `Project not initialized` | wts init not run | Run `wts init` |
| `Worktree already exists` | Alias in use | Use different alias or delete existing |
| `Branch already exists` | Using -n with existing branch | Use `-b <branch>` instead |
| `gh not found` | GitHub CLI not installed | Install gh: `brew install gh` |
| `Not authenticated` | gh not logged in | Run `gh auth login` |
