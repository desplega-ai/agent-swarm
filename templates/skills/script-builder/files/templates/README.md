# script-builder templates

Three templates implement the script-builder **context-optimal output convention**:

- `typescript.ts.tmpl` — Bun-first (falls back to `npx tsx` / compiled Node)
- `python.py.tmpl` — vanilla `python3` by default; `{{UV_METADATA}}` substitution adds the uv inline-script header when uv is detected
- `bash.sh.tmpl` — `set -euo pipefail`, EXIT trap, `tee`-based verbose mode

## Substitution markers

The skill replaces these markers when drafting a new script:

| Marker | Meaning | Example |
|---|---|---|
| `{{SCRIPT_NAME}}` | File-name stem (no extension) | `check-health` |
| `{{WHAT}}` | One-line summary of what the script validates | `Verifies /api/health returns 200 within 500ms` |
| `{{WHEN}}` | When the script should be run | `After deploys, before cutting a release` |
| `{{ENV}}` | Required env vars / deps | `BASE_URL, API_TOKEN; bun ≥1.1` |
| `{{EXAMPLE}}` | Example invocation | `BASE_URL=https://staging bun scripts/check-health.ts` |
| `{{TEST_BODY}}` | The actual generated test logic | (language-specific, varies) |
| `{{UV_METADATA}}` | Python only: empty or `# /// script\n# requires-python = ">=3.10"\n# ///` | (skill decides per detection) |

## Output-shape contract

Every generated script MUST honor:

1. **Single PASS/FAIL stdout line** by default, including the `/tmp` log path.
2. **Full verbose output** mirrored to `/tmp/<script-name>-<YYYYMMDD-HHMMSS>.log`.
3. **Exit code 0 on PASS, non-zero on FAIL.**
4. **`--help`** prints usage + the header `What/When/Env/Example` block.
5. **`--verbose`** streams the full log to stdout.
6. **`--json`** (TS/Python) emits one JSON line `{status, log, summary}` for machine consumers.

The contract is **template-enforced**, not runtime-validated — keep the templates the source of truth.
