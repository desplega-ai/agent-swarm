# Public ranking entries

Each `<domain>.json` file here approves one agent-swarm install for [agent-swarm.dev/ranking](https://agent-swarm.dev/ranking), which ranks installs by tokens used, like OpenRouter's app rankings.

```json
{ "$schema": "./schema.json", "domain": "example.com", "claim": "rk_3f9a1c0e7b2d4a6f8e1c3b5d7f9a2c4e" }
```

## Get ranked

1. Turn telemetry on, and set the **Organization name** and **Company website** in Settings → Configuration → Branding. Both are required.
2. Pick a category under **Public ranking** in the same card and click **Get ranked**. The install sends its listing and opens a prefilled GitHub page for this file.
3. Open the PR with the title `chore(ranking): add <domain>`. The **Ranking entry** check asks the telemetry proxy whether an install sent this exact domain and claim, and prints the listing that will be shown.
4. A Desplega maintainer reviews and merges it. The entry shows up within about two hours.

**Token totals are public and exact.** The page shows your total tokens per day, week and month, and tokens per model. The name, category and description come from your install's listing, so a rename in Branding shows without a new PR. A new website needs a new PR.

## Leave

Turn the setting off, turn telemetry off, or clear the organization name or website: the entry disappears at the next refresh. To remove it for good, open a PR titled `chore(ranking): remove <domain>` that deletes the file.

What leaves the install is listed in the [telemetry reference](https://docs.agent-swarm.dev/docs/reference/telemetry#public-ranking).
